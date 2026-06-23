'use strict';

import { buildPayroll } from './miso-planner.js?v=15';

const LOGIN_URL = 'https://rfq.getmiso.com/backoffice/login';
const REQUESTS_URL = 'https://rfq.getmiso.com/backoffice/requests';
const PARTNERS_URL = 'https://rfq.getmiso.com/backoffice/partners/';

const PAGE_LIMIT = 50;
// 한 번에 병렬로 가져올 페이지 수. 배치를 받은 뒤 페이지 순서대로 윈도우 경계를 확인한다.
const PAGE_BATCH = 10;
const RETRY_429_BASE_MS = 2000;
const RETRY_429_MAX = 6;
const LOOKBACK_DAYS = 45;
const PAYMENT_LAG_DAYS = 21;
// 계약(결제)으로 인정하는 주문 상태. 이 상태의 charged_at 을 계약 일시로 사용한다.
const PAID_STATUSES = ['confirming', 'complete'];
const EXCLUDED_STATUSES = ['unqualified'];

function metrics() {
  return globalThis.MisoMetrics;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const cur = idx++;
      if (cur >= items.length) break;
      results[cur] = await worker(items[cur], cur);
    }
  });
  await Promise.all(runners);
  return results;
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

function regionText(req) {
  const r = req.region || req.regions;
  if (!r) return '';
  if (Array.isArray(r)) return r.map((x) => x.name || x.display_name || x).join(', ');
  return r.name || r.display_name || '';
}

// 선택된 견적(extras)에서 결제/수수료 정보를 추출한다. (목록 응답에 포함됨 — 추가 호출 불필요)
// commissionFee = 우리 수수료(매출). quotePrice=거래액, partnerPayout=파트너정산, remainingBalance=잔금.
function paymentInfo(req) {
  const sid = req.selected_quote_id;
  const q = sid ? (req.quotes || []).find((x) => x && x.id === sid) : null;
  const ex = (q && q.extras) || {};
  const pd = (ex && ex.paymentDetail) || {};
  const pick = (k) => (ex[k] != null ? ex[k] : (pd[k] != null ? pd[k] : null));
  return {
    quotePrice: pick('quotePrice'),
    commissionFee: pick('commissionFee'),
    depositAmount: pick('depositAmount'),
    partnerPayout: pick('partnerPayout'),
    remainingBalance: pick('remainingBalance'),
  };
}

export class MisoClient {
  constructor(username, password, serviceId) {
    this.username = username;
    this.password = password;
    this.serviceId = Number(serviceId) || 586;
    this.token = null;
    this.lastQualified = null;
    this.lastLoadMeta = null;
  }

  // 계약 일시는 주문 목록의 charged_at 을 직접 사용하므로 별도 결제 캐시가 없다.
  // index.html 의 기존 호출부 호환을 위해 메서드는 no-op 으로 남겨둔다.
  clearPaymentCache() {}
  seedPaymentCacheFromOrders() {}

  async getToken(forceNew) {
    if (!forceNew && this.token) return this.token;
    this.token = await login(this.username, this.password);
    return this.token;
  }

  resolveOpts(opts) {
    return metrics().resolveOpts(opts, { lookbackDays: LOOKBACK_DAYS, paymentLagDays: PAYMENT_LAG_DAYS });
  }

  // service_ids=N 주문을 created_at 내림차순으로 PAGE_BATCH(기본 10) 페이지씩 병렬 조회한다.
  // 각 배치를 받은 뒤 페이지 순서대로 경계를 확인해 fetchStart 이전 접수가 나오면 중단.
  // (서버 rate limit 은 고려하지 않음 — 경계 너머로 몇 페이지 더 받아도 그냥 버린다.)
  async fetchRequestsInWindow(token, fetchStart) {
    const fetchPage = (page) => {
      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('limit', String(PAGE_LIMIT));
      qs.append('service_ids', String(this.serviceId));
      return apiGet(REQUESTS_URL + '?' + qs.toString(), token).then(
        (data) => (data && (data.requests || data.data || data.rows)) || [],
        // 데이터 범위를 넘어선 페이지의 오류는 "더 없음"으로 취급. 401(만료)만 전파.
        (err) => { if (err && err.status === 401) throw err; return []; }
      );
    };

    const collected = [];
    let startPage = 0;
    let done = false;
    while (!done && startPage < 4000) {
      const pages = Array.from({ length: PAGE_BATCH }, (_, i) => startPage + i);
      const batch = await Promise.all(pages.map(fetchPage));
      for (const rows of batch) {
        if (!rows.length) { done = true; break; }
        let pastWindow = false;
        for (const r of rows) {
          const cd = metrics().toSeoulDate(r.created_at);
          if (!cd || cd < fetchStart) { pastWindow = true; break; }
          collected.push(r);
        }
        if (pastWindow || rows.length < PAGE_LIMIT) { done = true; break; }
      }
      startPage += PAGE_BATCH;
    }
    return collected;
  }

  async loadQualifiedData(opts) {
    const ctx = this.resolveOpts(opts);
    let token = await this.getToken(false);
    const run = async (tok) => {
      const rows = await this.fetchRequestsInWindow(tok, ctx.fetchStart);
      const enriched = rows.map((req) => {
        const createdYmd = metrics().toSeoulDate(req.created_at);
        // 계약 일시 = 주문 목록의 charged_at(결제 시각). PAID 상태에서만 계약으로 인정.
        // (별도 payment-transactions API 호출 불필요)
        const paymentAt = PAID_STATUSES.includes(req.status) ? (req.charged_at || null) : null;
        return {
          id: req.id,
          status: req.status,
          phone: req.phone || '',
          region: regionText(req),
          due_date: req.due_date || null,
          created_at: req.created_at || null,
          createdYmd,
          paymentAt,
          paymentYmd: metrics().toSeoulDate(paymentAt),
          ...paymentInfo(req),
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
      quotePrice: o.quotePrice, commissionFee: o.commissionFee,
      depositAmount: o.depositAmount, partnerPayout: o.partnerPayout, remainingBalance: o.remainingBalance,
    }));
    return dashboard;
  }

  // 파트너 정보(이름·미소플래너 여부) 조회 — 캐시
  async fetchPartner(token, id) {
    if (!this.partnerCache) this.partnerCache = new Map();
    if (this.partnerCache.has(id)) return this.partnerCache.get(id);
    let info = { name: String(id), isPlanner: false };
    try {
      const d = await apiGet(PARTNERS_URL + id, token);
      let tags = d && d.tags;
      if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch (_) { tags = []; } }
      const isPlanner = Array.isArray(tags) && tags.some((t) => t && t.tag === '미소플래너' && t.service_id === 586);
      info = { name: (d && d.name) || String(id), isPlanner };
    } catch (_) { /* 실패 시 기본값 */ }
    this.partnerCache.set(id, info);
    return info;
  }

  // 월별 플래너 정산(인건비) — month: 'YYYY-MM'
  async loadPlannerPayroll(month) {
    const monthStart = month + '-01';
    const fetchStart = metrics().shiftDate(monthStart, -50); // 방문 리드타임 버퍼
    let token = await this.getToken(false);
    const run = async (tok) => {
      const raw = await this.fetchRequestsInWindow(tok, fetchStart);
      const pids = new Set();
      for (const r of raw) {
        for (const q of (r.quotes || [])) {
          if (q && q.visit_schedule) {
            const vy = metrics().toSeoulDate(q.visit_schedule);
            if (vy && vy.slice(0, 7) === month) pids.add(q.partner_id);
          }
        }
      }
      const partnerMap = {};
      await mapWithConcurrency([...pids], 16, async (pid) => {
        partnerMap[pid] = await this.fetchPartner(tok, pid);
      });
      return buildPayroll(raw, partnerMap, month, metrics().todaySeoul());
    };
    try {
      return await run(token);
    } catch (e) {
      if (e.status === 401) { this.token = null; token = await this.getToken(true); return await run(token); }
      throw e;
    }
  }
}
