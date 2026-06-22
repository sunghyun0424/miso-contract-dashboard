'use strict';

const LOGIN_URL = 'https://rfq.getmiso.com/backoffice/login';
const REQUESTS_URL = 'https://rfq.getmiso.com/backoffice/requests';

const PAYMENT_PROXY = 'https://miso-contract-api.onrender.com/api/payment-transactions';

/** 결제 API CORS 우회 — Render 프록시 (로컬은 npm start 동일 경로) */
function paymentsUrl(qs) {
  if (typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    return location.origin + '/api/payment-transactions?' + qs;
  }
  return PAYMENT_PROXY + '?' + qs;
}

const PAGE_LIMIT = 50;
const CONCURRENCY = 10;
const RETRY_429_BASE_MS = 2000;
const RETRY_429_MAX = 6;
const LOOKBACK_DAYS = 45;
const PAYMENT_LAG_DAYS = 21;
const PAID_STATUSES = ['confirming', 'complete'];
const EXCLUDED_STATUSES = ['unqualified'];
const ORDER_CACHE_TTL_MS = 10 * 60 * 1000;

function metrics() {
  return globalThis.MisoMetrics;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(url, token, attempt429 = 0) {
  const res = await fetch(url, {
    headers: { Authorization: token.startsWith('Bearer ') ? token : 'Bearer ' + token },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  if (res.status === 429 && attempt429 < RETRY_429_MAX) {
    const delay = RETRY_429_BASE_MS * Math.pow(2, attempt429);
    await sleep(delay);
    return apiGet(url, token, attempt429 + 1);
  }
  if (!res.ok) {
    const msg = (body && body.message) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function login(username, password) {
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  if (!res.ok || !body || !body.access_token) {
    const msg = (body && body.message) || ('로그인 실패 (HTTP ' + res.status + ')');
    const err = new Error(msg);
    err.status = res.status === 401 ? 401 : 400;
    err.isAuth = true;
    throw err;
  }
  return body.access_token;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const current = idx++;
      if (current >= items.length) break;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

function regionText(req) {
  const r = req.region || req.regions;
  if (!r) return '';
  if (Array.isArray(r)) return r.map((x) => x.name || x.display_name || x).join(', ');
  return r.name || r.display_name || '';
}

export class MisoClient {
  constructor(username, password, serviceId) {
    this.username = username;
    this.password = password;
    this.serviceId = Number(serviceId) || 586;
    this.token = null;
    this.paymentCache = new Map();
    this.lastQualified = null;
    this.lastLoadMeta = null;
  }

  clearPaymentCache() {
    this.paymentCache.clear();
  }

  cacheKey(requestId) {
    return this.serviceId + ':' + requestId;
  }

  getCachedPayment(requestId) {
    const entry = this.paymentCache.get(this.cacheKey(requestId));
    if (!entry) return undefined;
    if (Date.now() - entry.fetchedAt > ORDER_CACHE_TTL_MS) {
      this.paymentCache.delete(this.cacheKey(requestId));
      return undefined;
    }
    return entry.paymentAt;
  }

  setCachedPayment(requestId, paymentAt) {
    this.paymentCache.set(this.cacheKey(requestId), { paymentAt, fetchedAt: Date.now() });
  }

  seedPaymentCacheFromOrders(orders) {
    const now = Date.now();
    for (const o of orders) {
      if (o.paymentFetched || o.paymentAt !== undefined) {
        this.paymentCache.set(this.cacheKey(o.id), {
          paymentAt: o.paymentAt || null,
          fetchedAt: o.updatedAt || now,
        });
      }
    }
  }

  async getToken(forceNew) {
    if (!forceNew && this.token) return this.token;
    this.token = await login(this.username, this.password);
    return this.token;
  }

  resolveOpts(opts) {
    return metrics().resolveOpts(opts, { lookbackDays: LOOKBACK_DAYS, paymentLagDays: PAYMENT_LAG_DAYS });
  }

  shouldFetchPayment(req, ctx) {
    if (!PAID_STATUSES.includes(req.status)) return false;
    const createdYmd = metrics().toSeoulDate(req.created_at);
    if (!createdYmd || createdYmd < ctx.fetchStart) return false;
    if (createdYmd > ctx.paymentEnd) return false;
    return true;
  }

  async fetchRequestsInWindow(token, fetchStart) {
    const collected = [];
    for (let page = 0; page < 120; page++) {
      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('limit', String(PAGE_LIMIT));
      qs.append('service_ids', String(this.serviceId));
      const data = await apiGet(REQUESTS_URL + '?' + qs.toString(), token);
      const rows = (data && (data.requests || data.data || data.rows)) || [];
      if (!rows.length) break;
      let pastWindow = false;
      for (const r of rows) {
        const cd = metrics().toSeoulDate(r.created_at);
        if (!cd || cd < fetchStart) { pastWindow = true; break; }
        collected.push(r);
      }
      if (pastWindow || rows.length < PAGE_LIMIT) break;
    }
    return collected;
  }

  async fetchPaymentAt(token, requestId) {
    const cached = this.getCachedPayment(requestId);
    if (cached !== undefined) return cached;

    const qs = new URLSearchParams();
    qs.set('contextType', 'request');
    qs.set('contextId', String(requestId));
    qs.set('sorts', '+timestamp');
    qs.set('rowsPerPage', '50');
    let paymentAt = null;
    try {
      const data = await apiGet(paymentsUrl(qs.toString()), token);
      const rows = (data && (data.rows || data.data || (Array.isArray(data) ? data : []))) || [];
      let latest = null;
      for (const r of rows) {
        if (r && r.paymentType === 'payment' && r.success && r.timestamp) {
          const t = new Date(r.timestamp).getTime();
          if (latest === null || t > latest.t) latest = { t, raw: r.timestamp };
        }
      }
      paymentAt = latest ? latest.raw : null;
    } catch (e) {
      if (e.status === 401) throw e;
      return null;
    }
    this.setCachedPayment(requestId, paymentAt);
    return paymentAt;
  }

  async loadQualifiedData(opts) {
    const ctx = this.resolveOpts(opts);
    let token = await this.getToken(false);
    const run = async (tok) => {
      const rows = await this.fetchRequestsInWindow(tok, ctx.fetchStart);
      const enriched = await mapWithConcurrency(rows, CONCURRENCY, async (req) => {
        const createdYmd = metrics().toSeoulDate(req.created_at);
        let paymentAt = null;
        if (this.shouldFetchPayment(req, ctx)) {
          paymentAt = await this.fetchPaymentAt(tok, req.id);
        } else if (PAID_STATUSES.includes(req.status)) {
          const c = this.getCachedPayment(req.id);
          if (c !== undefined) paymentAt = c;
        }
        return {
          id: req.id,
          status: req.status,
          phone: req.phone || '',
          region: regionText(req),
          due_date: req.due_date || null,
          created_at: req.created_at || null,
          createdYmd,
          paymentAt: paymentAt || null,
          paymentYmd: metrics().toSeoulDate(paymentAt),
        };
      });
      const qualified = enriched.filter((o) => !EXCLUDED_STATUSES.includes(o.status));
      return {
        qualified,
        context: ctx,
        excludedUnqualified: enriched.length - qualified.length,
        generatedAt: new Date().toISOString(),
        fromCache: false,
      };
    };
    try {
      return await run(token);
    } catch (e) {
      if (e.status === 401) {
        this.clearPaymentCache();
        this.token = null;
        token = await this.getToken(true);
        return await run(token);
      }
      throw e;
    }
  }

  setQualifiedFromOrders(orders, opts) {
    const ctx = this.resolveOpts(opts);
    this.lastQualified = metrics().filterQualified(orders);
    this.lastLoadMeta = { context: ctx, generatedAt: new Date().toISOString(), fromCache: true };
    return this.lastQualified;
  }

  async syncDashboard(opts) {
    const data = await this.loadQualifiedData(opts);
    this.lastQualified = data.qualified;
    this.lastLoadMeta = data;
    const dashboard = metrics().buildDashboardFromOrders(data.qualified, data.context, this.serviceId, {
      excludedUnqualified: data.excludedUnqualified,
      generatedAt: data.generatedAt,
      lookbackDays: LOOKBACK_DAYS,
      fromCache: data.fromCache,
    });
    dashboard.orders = data.qualified.map((o) => ({
      id: o.id, status: o.status, phone: o.phone, region: o.region,
      due_date: o.due_date, created_at: o.created_at, createdYmd: o.createdYmd,
      paymentAt: o.paymentAt, paymentYmd: o.paymentYmd,
    }));
    return dashboard;
  }
}
