'use strict';

const TIMEZONE = 'Asia/Seoul';
const EXCLUDED_STATUSES = ['unqualified'];

function toSeoulDate(input) {
  if (!input) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function todaySeoul() {
  return toSeoulDate(new Date());
}

function shiftDate(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mondayIndex(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  return (d.getUTCDay() + 6) % 7;
}

function inRange(d, a, b) {
  return !!d && d >= a && d <= b;
}

function toSeoulHour(input) {
  if (!input) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, hour: '2-digit', hourCycle: 'h23',
  }).format(d);
  const n = parseInt(h, 10);
  return isNaN(n) ? null : n % 24;
}

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

function resolveOpts(opts, cfg) {
  cfg = cfg || {};
  // 선택한 과거 날짜를 덮기 위한 절대 스캔 상한(일). 기본 2년. (폭주 방지용)
  const maxScanDays = cfg.maxScanDays ?? 730;
  const paymentLagDays = cfg.paymentLagDays ?? 21;
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
  const leadStart = minYmd(sevenStart, weekStart, yesterday, dayB, rangeStart);
  const paymentStart = minYmd(today, yesterday, dayA, dayB, rangeStart, sevenStart, weekStart);
  const paymentEnd = maxYmd(today, dayA, dayB, rangeEnd, weekEnd);
  const neededStart = minYmd(leadStart, shiftDate(paymentStart, -paymentLagDays));
  // 선택한 날짜(dayA/dayB/range)가 과거면 그만큼 더 스캔해 과거 비교를 지원한다.
  // lookback 으로 자르지 않고, 폭주 방지용 maxScanDays 까지만 허용.
  const fetchStart = maxYmd(neededStart, shiftDate(today, -maxScanDays));
  return {
    today, yesterday, sevenStart, weekStart, weekEnd,
    dayA, dayB, rangeStart, rangeEnd,
    leadStart, paymentStart, paymentEnd, fetchStart,
  };
}

function buildDashboardFromOrders(qualified, ctx, serviceId, meta) {
  meta = meta || {};
  const { today, yesterday, sevenStart, weekStart, weekEnd, dayA, dayB, rangeStart, rangeEnd } = ctx;
  const todayContract = qualified.filter((o) => o.paymentYmd === today);
  const contract7d = qualified.filter((o) => inRange(o.paymentYmd, sevenStart, today));
  const weeklyContract = qualified.filter((o) => inRange(o.paymentYmd, weekStart, weekEnd));
  const yesterdayLeads = qualified.filter((o) => o.createdYmd === yesterday);
  const leads7d = qualified.filter((o) => inRange(o.createdYmd, sevenStart, today));
  const weeklyLeads = qualified.filter((o) => inRange(o.createdYmd, weekStart, weekEnd));
  const yesterdayContract = qualified.filter((o) => o.paymentYmd === yesterday);
  todayContract.sort((a, b) => new Date(b.paymentAt) - new Date(a.paymentAt));
  const rate = (num, den) => (den ? num / den : null);
  const cumulative = (arr) => { let s = 0; return arr.map((v) => (s += v)); };
  const aByHour = new Array(24).fill(0);
  const bByHour = new Array(24).fill(0);
  for (const o of qualified) {
    if (!o.paymentAt) continue;
    const h = toSeoulHour(o.paymentAt);
    if (h === null) continue;
    if (o.paymentYmd === dayA) aByHour[h] += 1;
    if (o.paymentYmd === dayB) bByHour[h] += 1;
  }
  const days = [];
  const contractByDay = [];
  const leadByDay = [];
  for (let d = rangeStart; d <= rangeEnd; d = shiftDate(d, 1)) {
    days.push(d);
    contractByDay.push(qualified.filter((o) => o.paymentYmd === d).length);
    leadByDay.push(qualified.filter((o) => o.createdYmd === d).length);
    if (days.length > 370) break;
  }
  const rangeContract = contractByDay.reduce((a, b) => a + b, 0);
  const rangeLead = leadByDay.reduce((a, b) => a + b, 0);

  // 수수료(매출) — 선택 기간, 계약일(paymentYmd) 기준. commissionFee = 우리 수수료.
  const dayPos = {};
  days.forEach((d, i) => { dayPos[d] = i; });
  const commByDay = new Array(days.length).fill(0);
  let commTotal = 0, commCount = 0, quoteTotal = 0;
  for (const o of qualified) {
    if (o.commissionFee == null) continue;
    const i = dayPos[o.paymentYmd];
    if (i === undefined) continue;
    commByDay[i] += o.commissionFee;
    commTotal += o.commissionFee;
    commCount += 1;
    if (o.quotePrice != null) quoteTotal += o.quotePrice;
  }

  const nowHour = toSeoulHour(new Date());
  let yesterdaySoFar = 0;
  for (const o of qualified) {
    if (o.paymentYmd !== yesterday) continue;
    const h = toSeoulHour(o.paymentAt);
    if (h !== null && h <= nowHour) yesterdaySoFar += 1;
  }
  return {
    serviceId,
    generatedAt: meta.generatedAt || new Date().toISOString(),
    dates: { today, yesterday, sevenStart, weekStart, weekEnd },
    scanned: qualified.length,
    excludedUnqualified: meta.excludedUnqualified || 0,
    lookbackDays: meta.lookbackDays ?? 45,
    fromCache: !!meta.fromCache,
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
      aTotal: qualified.filter((o) => o.paymentYmd === dayA).length,
      bTotal: qualified.filter((o) => o.paymentYmd === dayB).length,
    },
    range: {
      start: rangeStart, end: rangeEnd,
      days, contractByDay, leadByDay,
      contractTotal: rangeContract,
      leadTotal: rangeLead,
      rate: rate(rangeContract, rangeLead),
    },
    commission: {
      start: rangeStart, end: rangeEnd,
      total: commTotal, count: commCount,
      avg: commCount ? Math.round(commTotal / commCount) : 0,
      quoteTotal, rate: quoteTotal ? commTotal / quoteTotal : null,
      byDay: commByDay,
    },
    todayItems: todayContract.map((o) => ({
      id: o.id, phone: o.phone, region: o.region, due_date: o.due_date, paymentAt: o.paymentAt,
    })),
  };
}

function filterQualified(orders) {
  return orders.filter((o) => !EXCLUDED_STATUSES.includes(o.status));
}

const api = {
  TIMEZONE, EXCLUDED_STATUSES,
  resolveOpts, buildDashboardFromOrders, filterQualified,
  toSeoulDate, todaySeoul, shiftDate, clampYmd, inRange, toSeoulHour,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof globalThis !== 'undefined') {
  globalThis.MisoMetrics = api;
}
