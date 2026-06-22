'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

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
const CONCURRENCY = 10; // 결제 조회 동시 요청 수

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

// 결제 시각은 한 번 확정되면 거의 바뀌지 않으므로 프로세스 메모리에 캐싱한다.
// key: requestId -> { paymentAt: string|null, fetchedAt: number }
const paymentCache = new Map();

// 로그인으로 발급받은 토큰을 메모리에 캐싱한다. (계정별)
let tokenState = { token: null, key: null };

// 대시보드 집계 결과 캐시 (시트 API lazy load용)
// key -> { qualified, context, generatedAt, fetchedAt }
const dataCache = new Map();
const DATA_CACHE_TTL_MS = Number(process.env.DATA_CACHE_TTL_MS || 5 * 60 * 1000);

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

async function apiGet(url, token) {
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
    let oldestInPage = null;
    for (const r of rows) {
      collected.push(r);
      const cd = toSeoulDate(r.created_at);
      if (cd && (oldestInPage === null || cd < oldestInPage)) oldestInPage = cd;
    }
    if (rows.length < PAGE_LIMIT) break;
    if (oldestInPage && oldestInPage < fetchStart) break;
  }
  // 윈도우 밖(과거) 접수 제거
  return collected.filter((r) => {
    const cd = toSeoulDate(r.created_at);
    return cd && cd >= fetchStart;
  });
}

// 단일 주문의 "최신 성공 결제 시각" 조회 (캐시 활용)
async function fetchPaymentAt(token, requestId) {
  if (paymentCache.has(requestId)) {
    return paymentCache.get(requestId).paymentAt;
  }
  const qs = new URLSearchParams();
  qs.set('contextType', 'request');
  qs.set('contextId', String(requestId));
  qs.set('sorts', '+timestamp');
  qs.set('rowsPerPage', '50');
  let paymentAt = null;
  try {
    const data = await apiGet(PAYMENTS_URL + '?' + qs.toString(), token);
    const rows = (data && (data.rows || data.data || (Array.isArray(data) ? data : []))) || [];
    // 성공한 'payment' 거래 중 가장 최신 timestamp
    let latest = null;
    for (const r of rows) {
      if (r && r.paymentType === 'payment' && r.success && r.timestamp) {
        const t = new Date(r.timestamp).getTime();
        if (latest === null || t > latest.t) latest = { t, raw: r.timestamp };
      }
    }
    paymentAt = latest ? latest.raw : null;
  } catch (e) {
    // 인증 만료는 상위에서 재로그인하도록 전파한다.
    if (e.status === 401) throw e;
    // 그 외 개별 결제 조회 실패는 전체를 막지 않는다.
    return null;
  }
  paymentCache.set(requestId, { paymentAt, fetchedAt: Date.now() });
  return paymentAt;
}

function clampYmd(v, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : fallback;
}

function resolveOpts(opts) {
  opts = opts || {};
  const today = todaySeoul();
  const yesterday = shiftDate(today, -1);
  const sevenStart = shiftDate(today, -6);
  const weekStart = shiftDate(today, -mondayIndex(today));
  const weekEnd = shiftDate(weekStart, 6);
  const dayA = clampYmd(opts.dayA, today);
  const dayB = clampYmd(opts.dayB, yesterday);
  let rangeStart = clampYmd(opts.rangeStart, sevenStart);
  let rangeEnd = clampYmd(opts.rangeEnd, today);
  if (rangeStart > rangeEnd) { const t = rangeStart; rangeStart = rangeEnd; rangeEnd = t; }
  const earliest = [sevenStart, weekStart, yesterday, dayA, dayB, rangeStart].reduce((a, b) => (a < b ? a : b));
  const fetchStart = [shiftDate(earliest, -PAYMENT_LAG_DAYS), shiftDate(today, -LOOKBACK_DAYS)]
    .reduce((a, b) => (a < b ? a : b));
  return { today, yesterday, sevenStart, weekStart, weekEnd, dayA, dayB, rangeStart, rangeEnd, fetchStart };
}

function cacheKey(serviceId, ctx) {
  return [serviceId, ctx.dayA, ctx.dayB, ctx.rangeStart, ctx.rangeEnd].join('|');
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
  const key = cacheKey(serviceId, ctx);
  const cached = dataCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < DATA_CACHE_TTL_MS) {
    return cached;
  }

  const rows = await fetchRequestsInWindow(token, serviceId, ctx.fetchStart);
  const enriched = await mapWithConcurrency(rows, CONCURRENCY, async (req) => {
    const createdYmd = toSeoulDate(req.created_at);
    let paymentAt = null;
    if (PAID_STATUSES.includes(req.status)) {
      paymentAt = await fetchPaymentAt(token, req.id);
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
  const payload = {
    qualified,
    context: ctx,
    excludedUnqualified: enriched.length - qualified.length,
    generatedAt: new Date().toISOString(),
    fetchedAt: Date.now(),
  };
  dataCache.set(key, payload);
  return payload;
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
  const { today, yesterday, sevenStart, weekStart, weekEnd, dayA, dayB, rangeStart, rangeEnd } = ctx;

  // 계약(contract) = 결제 일시 기준
  const todayContract = qualified.filter((o) => o.paymentYmd === today);
  const contract7d = qualified.filter((o) => inRange(o.paymentYmd, sevenStart, today));
  const weeklyContract = qualified.filter((o) => inRange(o.paymentYmd, weekStart, weekEnd));

  // 접수(lead-in) = created_at 기준 (unqualified 제외)
  const yesterdayLeads = qualified.filter((o) => o.createdYmd === yesterday);
  const leads7d = qualified.filter((o) => inRange(o.createdYmd, sevenStart, today));
  const weeklyLeads = qualified.filter((o) => inRange(o.createdYmd, weekStart, weekEnd));

  const yesterdayContract = qualified.filter((o) => o.paymentYmd === yesterday);

  todayContract.sort((a, b) => new Date(b.paymentAt) - new Date(a.paymentAt));

  // 전환율(flow) = 기간 계약수 / 기간(또는 기준) 접수수
  const rate = (num, den) => (den ? num / den : null);
  const cumulative = (arr) => {
    let s = 0;
    return arr.map((v) => (s += v));
  };

  // 시간대별(0~23시) 계약 건수 — 기준일(dayA) vs 비교일(dayB)
  const aByHour = new Array(24).fill(0);
  const bByHour = new Array(24).fill(0);
  for (const o of qualified) {
    if (!o.paymentAt) continue;
    const h = toSeoulHour(o.paymentAt);
    if (h === null) continue;
    if (o.paymentYmd === dayA) aByHour[h] += 1;
    if (o.paymentYmd === dayB) bByHour[h] += 1;
  }
  const aTotal = qualified.filter((o) => o.paymentYmd === dayA).length;
  const bTotal = qualified.filter((o) => o.paymentYmd === dayB).length;

  // 지정 기간 일자별 계약/접수
  const days = [];
  const contractByDay = [];
  const leadByDay = [];
  for (let d = rangeStart; d <= rangeEnd; d = shiftDate(d, 1)) {
    days.push(d);
    contractByDay.push(qualified.filter((o) => o.paymentYmd === d).length);
    leadByDay.push(qualified.filter((o) => o.createdYmd === d).length);
    if (days.length > 370) break; // 안전장치
  }
  const rangeContract = contractByDay.reduce((a, b) => a + b, 0);
  const rangeLead = leadByDay.reduce((a, b) => a + b, 0);

  // 페이스 비교: 어제 같은 시각(현재 시)까지의 누적 계약수
  const nowHour = toSeoulHour(new Date());
  let yesterdaySoFar = 0;
  for (const o of qualified) {
    if (o.paymentYmd !== yesterday) continue;
    const h = toSeoulHour(o.paymentAt);
    if (h !== null && h <= nowHour) yesterdaySoFar += 1;
  }

  const excludedUnqualifiedCount = excludedUnqualified;

  return {
    serviceId,
    generatedAt,
    dates: { today, yesterday, sevenStart, weekStart, weekEnd },
    scanned: qualified.length,
    excludedUnqualified: excludedUnqualifiedCount,
    lookbackDays: LOOKBACK_DAYS,
    metrics: {
      todayContract: todayContract.length,
      yesterdayContract: yesterdayContract.length,
      yesterdaySoFar,
      yesterdayLeadIn: yesterdayLeads.length,
      yesterdayRate: rate(todayContract.length, yesterdayLeads.length),
      contract7d: contract7d.length,
      leadIn7d: leads7d.length,
      rate7d: rate(contract7d.length, leads7d.length),
      weeklyContract: weeklyContract.length,
      weeklyLeads: weeklyLeads.length,
      weeklyRate: rate(weeklyContract.length, weeklyLeads.length),
    },
    timetable: {
      dayA, dayB,
      hours: Array.from({ length: 24 }, (_, i) => i),
      aByHour, bByHour,
      aCumulative: cumulative(aByHour),
      bCumulative: cumulative(bByHour),
      aTotal, bTotal,
    },
    range: {
      start: rangeStart, end: rangeEnd,
      days, contractByDay, leadByDay,
      contractTotal: rangeContract,
      leadTotal: rangeLead,
      rate: rate(rangeContract, rangeLead),
    },
    todayItems: todayContract.map((o) => ({
      id: o.id, phone: o.phone, region: o.region, due_date: o.due_date, paymentAt: o.paymentAt,
    })),
  };
}

// 토큰 확보 + 401 시 1회 재로그인 후 재시도
async function computeMetricsWithAuth(auth, serviceId, opts) {
  let token = await getToken(auth, false);
  try {
    return await computeMetrics(token, serviceId, opts);
  } catch (e) {
    if (e.status === 401 && auth.mode === 'login') {
      paymentCache.clear();
      dataCache.clear();
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
      paymentCache.clear();
      dataCache.clear();
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
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-miso-user, x-miso-pass',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');

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
      const data = await computeMetricsWithAuth(auth, serviceId, opts);
      return sendJson(res, 200, data);
    } catch (e) {
      const code = e.status === 401 || e.isAuth ? 401 : 500;
      return sendJson(res, code, { error: e.message || '데이터 조회 실패', status: e.status });
    }
  }

  if (url.pathname === '/api/clear-cache') {
    paymentCache.clear();
    dataCache.clear();
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
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
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
