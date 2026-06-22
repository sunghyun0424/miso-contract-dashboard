'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const metrics = require('./metrics.js');

// ----------------------------------------------------------------------------
// 설정
// ----------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 4000);
const API_ONLY = process.env.API_ONLY === '1' || process.env.API_ONLY === 'true';

// 로그인 API (rfq.getmiso.com)
const LOGIN_URL = 'https://rfq.getmiso.com/backoffice/login';
// RFQ 주문 목록 API (rfq.getmiso.com)
const REQUESTS_URL = 'https://rfq.getmiso.com/backoffice/requests';
// 결제 거래 내역 API (api.getmiso.com)
const PAYMENTS_URL = 'https://api.getmiso.com/v3/backoffice/payment-transactions';

const DEFAULT_SERVICE_ID = 586; // 미소방문이사
const TIMEZONE = 'Asia/Seoul';

const PAGE_LIMIT = 50; // 목록 페이지당 건수
const CONCURRENCY = Number(process.env.CONCURRENCY || 10); // 결제 조회 동시 요청 수
const RETRY_429_BASE_MS = Number(process.env.RETRY_429_BASE_MS || 2000);
const RETRY_429_MAX = Number(process.env.RETRY_429_MAX || 6); // 2s, 4s, 8s … 최대 6회

// 접수(created_at) 기준으로 거슬러 올라가 스캔할 일수.
// 계약(결제)은 보통 접수 후 수일 내 발생하므로, 최근 N일 접수 주문만 보면
// 최근 7일/이번주 계약 및 전환율을 충분히 커버한다.
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 45);

// 접수→결제 지연 버퍼(일). 사용자가 과거 기간을 선택했을 때, 그 이전 접수분이
// 해당 기간에 결제될 수 있으므로 스캔 시작일을 이만큼 더 앞당긴다.
const PAYMENT_LAG_DAYS = Number(process.env.PAYMENT_LAG_DAYS || 21);

// 결제(계약)가 존재할 수 있는 주문 상태. 이 상태만 결제 내역을 조회한다.
const PAID_STATUSES = ['confirming', 'complete'];

// 지표에서 제외할 주문 상태 (접수·계약·전환율 모두 제외)
const EXCLUDED_STATUSES = ['unqualified'];

// 주문 ID별 결제 시각 캐시 (기준일 변경·재갱신 시 재사용)
// key: `${serviceId}:${requestId}` -> { paymentAt, fetchedAt }
const orderCache = new Map();
const ORDER_CACHE_TTL_MS = Number(process.env.ORDER_CACHE_TTL_MS || 10 * 60 * 1000);

// 로그인으로 발급받은 토큰을 메모리에 캐싱한다. (계정별)
let tokenState = { token: null, key: null };

// ----------------------------------------------------------------------------
// 유틸
// ----------------------------------------------------------------------------

// Asia/Seoul 기준 YYYY-MM-DD 문자열
function toSeoulDate(input) {
  if (!input) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return parts; // en-CA => YYYY-MM-DD
}

function todaySeoul() {
  return toSeoulDate(new Date());
}

// 'YYYY-MM-DD' 에 일수를 더한 날짜 문자열 (달력 기준)
function shiftDate(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 월요일=0 ... 일요일=6
function mondayIndex(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  return (d.getUTCDay() + 6) % 7;
}

// a <= d <= b (모두 'YYYY-MM-DD', 사전식 비교)
function inRange(d, a, b) {
  return !!d && d >= a && d <= b;
}

// Asia/Seoul 기준 시(0~23)
function toSeoulHour(input) {
  if (!input) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  const n = parseInt(h, 10);
  return isNaN(n) ? null : n % 24;
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
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = text;
  }
  if (res.status === 429 && attempt429 < RETRY_429_MAX) {
    const delay = RETRY_429_BASE_MS * Math.pow(2, attempt429);
    console.warn('[apiGet] 429 rate limit — retry in %dms (attempt %d/%d)', delay, attempt429 + 1, RETRY_429_MAX);
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

// 아이디/비밀번호로 로그인하여 access_token 발급
async function login(username, password) {
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = null;
  }
  // 로그인 성공 시 access_token, 실패 시 message 가 내려온다.
  if (!res.ok || !body || !body.access_token) {
    const msg = (body && body.message) || ('로그인 실패 (HTTP ' + res.status + ')');
    const err = new Error(msg);
    err.status = res.status === 401 ? 401 : 400;
    err.isAuth = true;
    throw err;
  }
  return body.access_token;
}

// 요청에서 인증 컨텍스트 추출 (직접 토큰 > 헤더 계정 > 환경변수 계정)
function resolveAuth(req) {
  const manualToken = req.headers['x-miso-token'];
  if (manualToken) return { mode: 'token', token: String(manualToken) };
  const username = req.headers['x-miso-user'] || process.env.MISO_USER;
  const password = req.headers['x-miso-pass'] || process.env.MISO_PASS;
  if (username && password) return { mode: 'login', username: String(username), password: String(password) };
  return null;
}

// 인증 컨텍스트로부터 토큰 확보 (로그인 모드는 캐시/재로그인 처리)
async function getToken(auth, forceNew) {
  if (auth.mode === 'token') return auth.token;
  if (!forceNew && tokenState.token && tokenState.key === auth.username) return tokenState.token;
  const token = await login(auth.username, auth.password);
  tokenState = { token, key: auth.username };
  return token;
}

// 동시성 제한 실행기
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

// ----------------------------------------------------------------------------
// 데이터 수집
// ----------------------------------------------------------------------------

// 해당 서비스의 주문을 (상태 무관) 최신순으로 페이지네이션하며,
// 접수일(created_at)이 fetchStart 이상인 주문만 수집한다.
// 기본 정렬은 created_at 내림차순이므로 fetchStart 이전이 나오면 중단한다.
// created_at 내림차순 페이지네이션 → fetchStart 미만 접수가 나오면 즉시 중단
async function fetchRequestsInWindow(token, serviceId, fetchStart) {
  const collected = [];
  for (let page = 0; page < 120; page++) {
    const qs = new URLSearchParams();
    qs.set('page', String(page));
    qs.set('limit', String(PAGE_LIMIT));
    qs.append('service_ids', String(serviceId));
    const data = await apiGet(REQUESTS_URL + '?' + qs.toString(), token);
    const rows = (data && (data.requests || data.data || data.rows)) || [];
    if (!rows.length) break;

    let pastWindow = false;
    for (const r of rows) {
      const cd = toSeoulDate(r.created_at);
      if (!cd || cd < fetchStart) {
        pastWindow = true;
        break;
      }
      collected.push(r);
    }
    if (pastWindow || rows.length < PAGE_LIMIT) break;
  }
  return collected;
}

function orderCacheKey(serviceId, requestId) {
  return serviceId + ':' + requestId;
}

function getOrderCacheEntry(serviceId, requestId) {
  const key = orderCacheKey(serviceId, requestId);
  const entry = orderCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > ORDER_CACHE_TTL_MS) {
    orderCache.delete(key);
    return null;
  }
  return entry;
}

// 단일 주문의 "최신 성공 결제 시각" 조회 (주문 ID 캐시, TTL 10분)
async function fetchPaymentAt(token, serviceId, requestId) {
  const cached = getOrderCacheEntry(serviceId, requestId);
  if (cached) return cached.paymentAt;

  const qs = new URLSearchParams();
  qs.set('contextType', 'request');
  qs.set('contextId', String(requestId));
  qs.set('sorts', '+timestamp');
  qs.set('rowsPerPage', '50');
  let paymentAt = null;
  try {
    const data = await apiGet(PAYMENTS_URL + '?' + qs.toString(), token);
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
  orderCache.set(orderCacheKey(serviceId, requestId), { paymentAt, fetchedAt: Date.now() });
  return paymentAt;
}

function resolveOpts(opts) {
  return metrics.resolveOpts(opts, {
    lookbackDays: LOOKBACK_DAYS,
    paymentLagDays: PAYMENT_LAG_DAYS,
  });
}

// resolveOpts 본문은 metrics.js — 아래 minYmd 등은 시트/필터용
function minYmd(...dates) {
  const valid = dates.filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  return valid.reduce((a, b) => (a < b ? a : b));
}

function maxYmd(...dates) {
  const valid = dates.filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  return valid.reduce((a, b) => (a > b ? a : b));
}

function clampYmd(v, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : fallback;
}

// 대시보드·시트에 필요한 접수/결제 기준일 윈도우 → metrics.resolveOpts
function shouldFetchPayment(req, ctx) {
  if (!PAID_STATUSES.includes(req.status)) return false;
  const createdYmd = toSeoulDate(req.created_at);
  if (!createdYmd || createdYmd < ctx.fetchStart) return false;
  // 결제일 ≥ 접수일 → 접수일이 paymentEnd 보다 늦으면 해당 결제 구간에 기여 불가
  if (createdYmd > ctx.paymentEnd) return false;
  return true;
}

function toSheetRow(o) {
  return {
    id: o.id,
    phone: o.phone || '',
    region: o.region || '',
    status: o.status || '',
    created_at: o.created_at || null,
    createdYmd: o.createdYmd || null,
    paymentAt: o.paymentAt || null,
    paymentYmd: o.paymentYmd || null,
    due_date: o.due_date || null,
  };
}

function sortOrders(rows, field, dir) {
  const mul = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[field], bv = b[field];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (field === 'id') return (Number(av) - Number(bv)) * mul;
    if (field.endsWith('Ymd') || field.endsWith('_at') || field.endsWith('At')) {
      return String(av).localeCompare(String(bv)) * mul;
    }
    return String(av).localeCompare(String(bv), 'ko') * mul;
  });
}

async function loadQualifiedData(token, serviceId, opts) {
  const ctx = resolveOpts(opts);

  const rows = await fetchRequestsInWindow(token, serviceId, ctx.fetchStart);
  let paymentSkipped = 0;
  let paymentCacheHits = 0;
  let paymentFetched = 0;
  const enriched = await mapWithConcurrency(rows, CONCURRENCY, async (req) => {
    const createdYmd = toSeoulDate(req.created_at);
    let paymentAt = null;
    if (shouldFetchPayment(req, ctx)) {
      const hadCache = !!getOrderCacheEntry(serviceId, req.id);
      paymentAt = await fetchPaymentAt(token, serviceId, req.id);
      if (hadCache) paymentCacheHits += 1;
      else paymentFetched += 1;
    } else if (PAID_STATUSES.includes(req.status)) {
      paymentSkipped += 1;
      // 결제 조회 스킵 구간이어도 캐시에 있으면 집계에 활용
      const cached = getOrderCacheEntry(serviceId, req.id);
      if (cached) paymentAt = cached.paymentAt;
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
      paymentYmd: toSeoulDate(paymentAt),
    };
  });
  const qualified = enriched.filter((o) => !EXCLUDED_STATUSES.includes(o.status));
  console.log('[load] serviceId=%s fetchStart=%s requests=%d payment fetch=%d cacheHit=%d skip=%d',
    serviceId, ctx.fetchStart, rows.length, paymentFetched, paymentCacheHits, paymentSkipped);
  return {
    qualified,
    context: ctx,
    excludedUnqualified: enriched.length - qualified.length,
    paymentSkipped,
    paymentCacheHits,
    paymentFetched,
    generatedAt: new Date().toISOString(),
  };
}

function buildSheet(type, data, params) {
  params = params || {};
  const { qualified, context: ctx } = data;
  const rate = (num, den) => (den ? num / den : null);

  const orderCols = [
    { key: 'id', label: '주문 ID' },
    { key: 'phone', label: '전화번호' },
    { key: 'region', label: '지역' },
    { key: 'status', label: '상태' },
    { key: 'created_at', label: '접수일시' },
    { key: 'paymentAt', label: '결제일시' },
    { key: 'due_date', label: 'due_date' },
  ];

  const filterOrders = (rows) => rows.map(toSheetRow);

  if (type === 'todayContracts') {
    const rows = qualified.filter((o) => o.paymentYmd === ctx.today);
    rows.sort((a, b) => new Date(b.paymentAt) - new Date(a.paymentAt));
    return {
      sheetType: 'orders',
      title: '오늘 계약',
      subtitle: ctx.today + ' · 결제 일시 기준 · unqualified 제외',
      total: rows.length,
      columns: orderCols,
      rows: filterOrders(rows),
    };
  }

  if (type === 'yesterdayLeads') {
    const rows = qualified.filter((o) => o.createdYmd === ctx.yesterday);
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return {
      sheetType: 'orders',
      title: '어제 접수',
      subtitle: ctx.yesterday + ' · 접수일(created_at) 기준 · unqualified 제외',
      total: rows.length,
      columns: orderCols,
      rows: filterOrders(rows),
    };
  }

  if (type === 'sevenDayContracts') {
    const rows = qualified.filter((o) => inRange(o.paymentYmd, ctx.sevenStart, ctx.today));
    rows.sort((a, b) => new Date(b.paymentAt || 0) - new Date(a.paymentAt || 0));
    return {
      sheetType: 'orders',
      title: '최근 7일 계약',
      subtitle: ctx.sevenStart + ' ~ ' + ctx.today + ' · 결제 일시 기준',
      total: rows.length,
      columns: orderCols,
      rows: filterOrders(rows),
    };
  }

  if (type === 'sevenDayLeads') {
    const rows = qualified.filter((o) => inRange(o.createdYmd, ctx.sevenStart, ctx.today));
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return {
      sheetType: 'orders',
      title: '최근 7일 접수',
      subtitle: ctx.sevenStart + ' ~ ' + ctx.today + ' · 접수일 기준',
      total: rows.length,
      columns: orderCols,
      rows: filterOrders(rows),
    };
  }

  if (type === 'rangeContracts') {
    const rows = qualified.filter((o) => inRange(o.paymentYmd, ctx.rangeStart, ctx.rangeEnd));
    rows.sort((a, b) => new Date(b.paymentAt || 0) - new Date(a.paymentAt || 0));
    return {
      sheetType: 'orders',
      title: '기간 계약',
      subtitle: ctx.rangeStart + ' ~ ' + ctx.rangeEnd + ' · 결제 일시 기준',
      total: rows.length,
      columns: orderCols,
      rows: filterOrders(rows),
    };
  }

  if (type === 'rangeLeads') {
    const rows = qualified.filter((o) => inRange(o.createdYmd, ctx.rangeStart, ctx.rangeEnd));
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return {
      sheetType: 'orders',
      title: '기간 접수',
      subtitle: ctx.rangeStart + ' ~ ' + ctx.rangeEnd + ' · 접수일 기준',
      total: rows.length,
      columns: orderCols,
      rows: filterOrders(rows),
    };
  }

  if (type === 'timetableOrders') {
    const day = clampYmd(params.day, ctx.dayA);
    let rows = qualified.filter((o) => o.paymentYmd === day && o.paymentAt);
    if (params.hour !== undefined && params.hour !== null && params.hour !== '') {
      const h = Number(params.hour);
      rows = rows.filter((o) => toSeoulHour(o.paymentAt) === h);
    }
    rows.sort((a, b) => new Date(b.paymentAt) - new Date(a.paymentAt));
    const hourLabel = (params.hour !== undefined && params.hour !== null && params.hour !== '')
      ? ' · ' + params.hour + '시'
      : '';
    return {
      sheetType: 'orders',
      title: day + ' 계약' + hourLabel,
      subtitle: '결제 일시 기준 · unqualified 제외',
      total: rows.length,
      columns: orderCols,
      rows: filterOrders(rows),
    };
  }

  if (type === 'hourlySummary') {
    const aByHour = new Array(24).fill(0);
    const bByHour = new Array(24).fill(0);
    for (const o of qualified) {
      if (!o.paymentAt) continue;
      const h = toSeoulHour(o.paymentAt);
      if (h === null) continue;
      if (o.paymentYmd === ctx.dayA) aByHour[h] += 1;
      if (o.paymentYmd === ctx.dayB) bByHour[h] += 1;
    }
    let cumA = 0, cumB = 0;
    const rows = Array.from({ length: 24 }, (_, h) => {
      cumA += aByHour[h]; cumB += bByHour[h];
      return { hour: h, dayA: aByHour[h], dayB: bByHour[h], cumA, cumB };
    });
    return {
      sheetType: 'summary',
      title: '시간대별 계약 요약',
      subtitle: ctx.dayA + ' vs ' + ctx.dayB,
      total: rows.length,
      columns: [
        { key: 'hour', label: '시간' },
        { key: 'dayA', label: ctx.dayA + ' 계약' },
        { key: 'dayB', label: ctx.dayB + ' 계약' },
        { key: 'cumA', label: ctx.dayA + ' 누적' },
        { key: 'cumB', label: ctx.dayB + ' 누적' },
      ],
      rows: rows.map((r) => ({ ...r, hour: r.hour + '시' })),
    };
  }

  if (type === 'dailySummary') {
    const rows = [];
    for (let d = ctx.rangeStart; d <= ctx.rangeEnd; d = shiftDate(d, 1)) {
      const contract = qualified.filter((o) => o.paymentYmd === d).length;
      const lead = qualified.filter((o) => o.createdYmd === d).length;
      rows.push({ date: d, contract, lead, rate: rate(contract, lead) });
      if (rows.length > 370) break;
    }
    const totalContract = rows.reduce((s, r) => s + r.contract, 0);
    const totalLead = rows.reduce((s, r) => s + r.lead, 0);
    return {
      sheetType: 'summary',
      title: '기간별 계약 · 접수 요약',
      subtitle: ctx.rangeStart + ' ~ ' + ctx.rangeEnd,
      total: rows.length,
      columns: [
        { key: 'date', label: '날짜' },
        { key: 'contract', label: '계약' },
        { key: 'lead', label: '접수' },
        { key: 'rate', label: '일별 전환율(%)' },
      ],
      rows: rows.map((r) => ({
        ...r,
        rate: r.rate === null ? '–' : (r.rate * 100).toFixed(2),
      })),
      summary: { contractTotal: totalContract, leadTotal: totalLead, rate: rate(totalContract, totalLead) },
    };
  }

  if (type === 'dayContracts') {
    const day = clampYmd(params.day, ctx.rangeStart);
    const rows = qualified.filter((o) => o.paymentYmd === day);
    rows.sort((a, b) => new Date(b.paymentAt || 0) - new Date(a.paymentAt || 0));
    return {
      sheetType: 'orders',
      title: day + ' 계약',
      subtitle: '결제 일시 기준',
      total: rows.length,
      columns: orderCols,
      rows: filterOrders(rows),
    };
  }

  if (type === 'dayLeads') {
    const day = clampYmd(params.day, ctx.rangeStart);
    const rows = qualified.filter((o) => o.createdYmd === day);
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return {
      sheetType: 'orders',
      title: day + ' 접수',
      subtitle: '접수일(created_at) 기준',
      total: rows.length,
      columns: orderCols,
      rows: filterOrders(rows),
    };
  }

  const err = new Error('알 수 없는 시트 유형: ' + type);
  err.status = 400;
  throw err;
}

async function computeMetrics(token, serviceId, opts) {
  const data = await loadQualifiedData(token, serviceId, opts);
  const { qualified, context: ctx, excludedUnqualified, generatedAt } = data;
  const dashboard = metrics.buildDashboardFromOrders(qualified, ctx, serviceId, {
    excludedUnqualified,
    generatedAt,
    lookbackDays: LOOKBACK_DAYS,
  });
  dashboard.orders = qualified.map((o) => ({
    id: o.id, status: o.status, phone: o.phone, region: o.region,
    due_date: o.due_date, created_at: o.created_at, createdYmd: o.createdYmd,
    paymentAt: o.paymentAt, paymentYmd: o.paymentYmd,
  }));
  return dashboard;
}

// 토큰 확보 + 401 시 1회 재로그인 후 재시도
async function computeMetricsWithAuth(auth, serviceId, opts) {
  let token = await getToken(auth, false);
  try {
    return await computeMetrics(token, serviceId, opts);
  } catch (e) {
    if (e.status === 401 && auth.mode === 'login') {
      orderCache.clear();
      token = await getToken(auth, true);
      return await computeMetrics(token, serviceId, opts);
    }
    throw e;
  }
}

async function getSheetWithAuth(auth, serviceId, opts, sheetOpts) {
  let token = await getToken(auth, false);
  try {
    const data = await loadQualifiedData(token, serviceId, opts);
    let sheet = buildSheet(sheetOpts.type, data, sheetOpts);
    if (sheetOpts.sort) sheet.rows = sortOrders(sheet.rows, sheetOpts.sort, sheetOpts.dir || 'asc');
    if (sheetOpts.q) {
      const q = sheetOpts.q.toLowerCase();
      sheet.rows = sheet.rows.filter((r) =>
        Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(q))
      );
      sheet.filtered = sheet.rows.length;
    }
    return sheet;
  } catch (e) {
    if (e.status === 401 && auth.mode === 'login') {
      orderCache.clear();
      token = await getToken(auth, true);
      const data = await loadQualifiedData(token, serviceId, opts);
      let sheet = buildSheet(sheetOpts.type, data, sheetOpts);
      if (sheetOpts.sort) sheet.rows = sortOrders(sheet.rows, sheetOpts.sort, sheetOpts.dir || 'asc');
      if (sheetOpts.q) {
        const q = sheetOpts.q.toLowerCase();
        sheet.rows = sheet.rows.filter((r) =>
          Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(q))
        );
        sheet.filtered = sheet.rows.length;
      }
      return sheet;
    }
    throw e;
  }
}

function regionText(req) {
  const r = req.region || req.regions;
  if (!r) return '';
  if (Array.isArray(r)) return r.map((x) => x.name || x.display_name || x).join(', ');
  return r.name || r.display_name || '';
}

// ----------------------------------------------------------------------------
// HTTP 서버
// ----------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-miso-user, x-miso-pass',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

async function handleApiRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/payment-transactions') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      });
      return res.end();
    }
    const auth = req.headers.authorization;
    if (!auth) return sendJson(res, 401, { error: 'Authorization header required' });
    const upstream = PAYMENTS_URL + (url.search || '');
    try {
      const r = await fetch(upstream, { headers: { Authorization: auth } });
      const text = await r.text();
      res.writeHead(r.status, {
        'Content-Type': r.headers.get('content-type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      return res.end(text);
    } catch (e) {
      return sendJson(res, 502, { error: e.message || 'Upstream error' });
    }
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-miso-user, x-miso-pass, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, ts: new Date().toISOString() });
  }

  if (url.pathname === '/api/dashboard') {
    const auth = resolveAuth(req);
    if (!auth) {
      return sendJson(res, 400, { error: '로그인 정보가 필요합니다. 대시보드 상단에 아이디/비밀번호를 입력하세요.' });
    }
    const serviceId = Number(url.searchParams.get('serviceId')) || DEFAULT_SERVICE_ID;
    const opts = {
      dayA: url.searchParams.get('dayA'),
      dayB: url.searchParams.get('dayB'),
      rangeStart: url.searchParams.get('rangeStart'),
      rangeEnd: url.searchParams.get('rangeEnd'),
    };
    try {
      console.log('[dashboard] start serviceId=%s', serviceId);
      const t0 = Date.now();
      const data = await computeMetricsWithAuth(auth, serviceId, opts);
      console.log('[dashboard] done in %ds', Math.round((Date.now() - t0) / 1000));
      return sendJson(res, 200, data);
    } catch (e) {
      const code = e.status === 401 || e.isAuth ? 401 : 500;
      return sendJson(res, code, { error: e.message || '데이터 조회 실패', status: e.status });
    }
  }

  if (url.pathname === '/api/clear-cache') {
    orderCache.clear();
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/sheet') {
    const auth = resolveAuth(req);
    if (!auth) {
      return sendJson(res, 400, { error: '로그인 정보가 필요합니다.' });
    }
    const serviceId = Number(url.searchParams.get('serviceId')) || DEFAULT_SERVICE_ID;
    const opts = {
      dayA: url.searchParams.get('dayA'),
      dayB: url.searchParams.get('dayB'),
      rangeStart: url.searchParams.get('rangeStart'),
      rangeEnd: url.searchParams.get('rangeEnd'),
    };
    const sheetOpts = {
      type: url.searchParams.get('type') || '',
      day: url.searchParams.get('day'),
      hour: url.searchParams.get('hour'),
      sort: url.searchParams.get('sort'),
      dir: url.searchParams.get('dir'),
      q: url.searchParams.get('q'),
    };
    if (!sheetOpts.type) {
      return sendJson(res, 400, { error: 'type 파라미터가 필요합니다.' });
    }
    try {
      const sheet = await getSheetWithAuth(auth, serviceId, opts, sheetOpts);
      return sendJson(res, 200, sheet);
    } catch (e) {
      const code = e.status === 401 || e.isAuth ? 401 : (e.status || 500);
      return sendJson(res, code, { error: e.message || '시트 조회 실패', status: e.status });
    }
  }

  sendJson(res, 404, { error: 'Not Found' });
}

module.exports = { handleApiRequest };

if (require.main === module) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(req, res);
    }

    if (API_ONLY) {
      return sendJson(res, 404, { error: 'Not Found' });
    }

    // 정적 파일 (index.html) — 로컬 개발용
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join(__dirname, path.normalize(filePath).replace(/^(\.\.[/\\])+/, ''));
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      const ext = path.extname(filePath);
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.webmanifest': 'application/manifest+json',
      };
      const headers = { 'Content-Type': types[ext] || 'application/octet-stream' };
      if (path.basename(filePath) === 'sw.js') {
        headers['Cache-Control'] = 'no-cache';
        headers['Service-Worker-Allowed'] = '/';
      }
      res.writeHead(200, headers);
      res.end(content);
    });
  });

  server.listen(PORT, () => {
    if (API_ONLY) {
      console.log('Miso API 프록시 실행 중 (API only): port ' + PORT);
    } else {
      console.log('실시간 계약 대시보드 실행 중: http://localhost:' + PORT);
      console.log('브라우저에서 위 주소를 열고 백오피스 아이디/비밀번호로 로그인하세요.');
    }
  });
}
