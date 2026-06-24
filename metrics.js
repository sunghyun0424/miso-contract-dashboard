'use strict';

const TIMEZONE = 'Asia/Seoul';
const EXCLUDED_STATUSES = ['unqualified'];
// 오늘 계약 타겟 = 전일 접수 × 이 비율 (올림). 정책 변경 시 여기만 수정.
const TARGET_RATIO = 0.35;

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
  let commTotal = 0, commCount = 0, quoteTotal = 0, depositTotal = 0;
  for (const o of qualified) {
    if (o.commissionFee == null) continue;
    const i = dayPos[o.paymentYmd];
    if (i === undefined) continue;
    commByDay[i] += o.commissionFee;
    commTotal += o.commissionFee;
    commCount += 1;
    if (o.quotePrice != null) quoteTotal += o.quotePrice;
    if (o.depositAmount != null) depositTotal += o.depositAmount;
  }

  // 월별 매출 (계약일 기준, 선택 기간 내 달)
  const months = []; const monthPos = {};
  {
    let [my, mm] = rangeStart.split('-').map(Number);
    const endKey = rangeEnd.slice(0, 7);
    for (let guard = 0; guard < 60; guard++) {
      const key = my + '-' + String(mm).padStart(2, '0');
      monthPos[key] = months.length; months.push(key);
      if (key >= endKey) break;
      mm++; if (mm > 12) { mm = 1; my++; }
    }
  }
  const commByMonth = new Array(months.length).fill(0);
  const domMap = {}; // 'YYYY-MM' -> [32] (day-of-month 일별 매출)
  for (const o of qualified) {
    if (o.commissionFee == null || !o.paymentYmd) continue;
    if (!inRange(o.paymentYmd, rangeStart, rangeEnd)) continue;
    const mk = o.paymentYmd.slice(0, 7);
    const i = monthPos[mk];
    if (i === undefined) continue;
    commByMonth[i] += o.commissionFee;
    const dd = Number(o.paymentYmd.slice(8, 10));
    (domMap[mk] || (domMap[mk] = new Array(32).fill(0)))[dd] += o.commissionFee;
  }
  // 같은 시점(일) 비교 — 각 달 1일부터 누적. 마지막(현재) 달은 비교일까지만, 그 외는 말일까지.
  const compareDom = Number(rangeEnd.slice(8, 10));
  const lastMonthKey = rangeEnd.slice(0, 7);
  const monthsCum = months.map((mk) => {
    const daily = domMap[mk] || new Array(32).fill(0);
    const [yy, mo2] = mk.split('-').map(Number);
    const lastDay = (mk === lastMonthKey) ? compareDom : new Date(Date.UTC(yy, mo2, 0)).getUTCDate();
    const cum = []; let s = 0;
    for (let d = 1; d <= 31; d++) { s += daily[d]; cum.push(d <= lastDay ? s : null); }
    return { month: mk, cum };
  });

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
      todayTarget: Math.ceil(yesterdayLeads.length * TARGET_RATIO),
      targetRatio: TARGET_RATIO,
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
      quoteTotal, depositTotal,
      aov: commCount ? Math.round(quoteTotal / commCount) : 0,
      rate: quoteTotal ? commTotal / quoteTotal : null,
      byDay: commByDay,
      months, byMonth: commByMonth,
      monthsCum, compareDom,
    },
    todayItems: todayContract.map((o) => ({
      id: o.id, phone: o.phone, region: o.region, due_date: o.due_date, paymentAt: o.paymentAt,
    })),
  };
}

function filterQualified(orders) {
  return orders.filter((o) => !EXCLUDED_STATUSES.includes(o.status));
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

// 일/주/월 기간별 집계 — 접수=createdYmd, 계약·매출=paymentYmd 기준.
// granularity: 'day' | 'week'(월요일 시작) | 'month'. 최근 count개 버킷을 최신순으로 반환.
// rate(계약율) = 계약 ÷ 접수 (같은 기간 기준 — 기존 '기간 전환율'과 동일 정의).
// revenue = commissionFee(우리 수수료) 합. rows[0] 은 진행 중(부분) 기간.
function buildPeriodStats(qualified, granularity, todayYmd, count) {
  const keyOf = (ymd) => {
    if (!ymd) return null;
    if (granularity === 'month') return ymd.slice(0, 7);
    if (granularity === 'week') return shiftDate(ymd, -mondayIndex(ymd));
    return ymd;
  };
  const lead = {}, contract = {}, rev = {};
  for (const o of qualified) {
    const lk = keyOf(o.createdYmd);
    if (lk) lead[lk] = (lead[lk] || 0) + 1;
    const ck = keyOf(o.paymentYmd);
    if (ck) {
      contract[ck] = (contract[ck] || 0) + 1;
      if (o.commissionFee != null) rev[ck] = (rev[ck] || 0) + o.commissionFee;
    }
  }
  const keys = [];
  if (granularity === 'month') {
    let [y, mo] = todayYmd.split('-').map(Number);
    for (let i = 0; i < count; i++) { keys.push(y + '-' + String(mo).padStart(2, '0')); mo--; if (mo < 1) { mo = 12; y--; } }
  } else if (granularity === 'week') {
    let ws = shiftDate(todayYmd, -mondayIndex(todayYmd));
    for (let i = 0; i < count; i++) { keys.push(ws); ws = shiftDate(ws, -7); }
  } else {
    let d = todayYmd;
    for (let i = 0; i < count; i++) { keys.push(d); d = shiftDate(d, -1); }
  }
  const labelOf = (key) => {
    if (granularity === 'month') return { label: Number(key.slice(5, 7)) + '월', sub: '' };
    if (granularity === 'week') {
      const end = shiftDate(key, 6);
      return { label: key.slice(5).replace('-', '/') + ' ~ ' + end.slice(5).replace('-', '/'), sub: '' };
    }
    const dow = WEEKDAY_KO[new Date(key + 'T00:00:00Z').getUTCDay()];
    return { label: key.slice(5).replace('-', '/'), sub: dow };
  };
  const rows = keys.map((key, i) => {
    const lc = lead[key] || 0, cc = contract[key] || 0;
    const lab = labelOf(key);
    return { key, label: lab.label, sub: lab.sub, lead: lc, contract: cc, rate: lc ? cc / lc : null, revenue: rev[key] || 0, partial: i === 0 };
  });
  return { granularity, rows };
}

const api = {
  TIMEZONE, EXCLUDED_STATUSES,
  resolveOpts, buildDashboardFromOrders, filterQualified, buildPeriodStats,
  toSeoulDate, todaySeoul, shiftDate, clampYmd, inRange, toSeoulHour,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else if (typeof globalThis !== 'undefined') {
  globalThis.MisoMetrics = api;
}
