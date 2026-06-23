'use strict';

function m() { return globalThis.MisoMetrics; }

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

function toCommissionRow(o) {
  return {
    paymentYmd: o.paymentYmd || null,
    id: o.id,
    status: o.status || '',
    quotePrice: o.quotePrice ?? null,
    commissionFee: o.commissionFee ?? null,
    partnerPayout: o.partnerPayout ?? null,
    remainingBalance: o.remainingBalance ?? null,
    paymentAt: o.paymentAt || null,
  };
}

export function sortOrders(rows, field, dir) {
  const mul = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[field], bv = b[field];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
    if (field === 'id') return (Number(av) - Number(bv)) * mul;
    if (field.endsWith('Ymd') || field.endsWith('_at') || field.endsWith('At')) {
      return String(av).localeCompare(String(bv)) * mul;
    }
    return String(av).localeCompare(String(bv), 'ko') * mul;
  });
}

export function buildSheet(type, data, params) {
  params = params || {};
  const { qualified, context: ctx } = data;
  const { inRange, toSeoulHour, shiftDate, clampYmd } = m();
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
    return { sheetType: 'orders', title: '오늘 계약', subtitle: ctx.today + ' · 결제 일시 기준 · unqualified 제외', total: rows.length, columns: orderCols, rows: filterOrders(rows) };
  }
  if (type === 'yesterdayLeads') {
    const rows = qualified.filter((o) => o.createdYmd === ctx.yesterday);
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { sheetType: 'orders', title: '어제 접수', subtitle: ctx.yesterday + ' · 접수일(created_at) 기준 · unqualified 제외', total: rows.length, columns: orderCols, rows: filterOrders(rows) };
  }
  if (type === 'sevenDayContracts') {
    const rows = qualified.filter((o) => inRange(o.paymentYmd, ctx.sevenStart, ctx.today));
    rows.sort((a, b) => new Date(b.paymentAt || 0) - new Date(a.paymentAt || 0));
    return { sheetType: 'orders', title: '최근 7일 계약', subtitle: ctx.sevenStart + ' ~ ' + ctx.today + ' · 결제 일시 기준', total: rows.length, columns: orderCols, rows: filterOrders(rows) };
  }
  if (type === 'sevenDayLeads') {
    const rows = qualified.filter((o) => inRange(o.createdYmd, ctx.sevenStart, ctx.today));
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { sheetType: 'orders', title: '최근 7일 접수', subtitle: ctx.sevenStart + ' ~ ' + ctx.today + ' · 접수일 기준', total: rows.length, columns: orderCols, rows: filterOrders(rows) };
  }
  if (type === 'rangeContracts') {
    const rows = qualified.filter((o) => inRange(o.paymentYmd, ctx.rangeStart, ctx.rangeEnd));
    rows.sort((a, b) => new Date(b.paymentAt || 0) - new Date(a.paymentAt || 0));
    return { sheetType: 'orders', title: '기간 계약', subtitle: ctx.rangeStart + ' ~ ' + ctx.rangeEnd + ' · 결제 일시 기준', total: rows.length, columns: orderCols, rows: filterOrders(rows) };
  }
  if (type === 'rangeLeads') {
    const rows = qualified.filter((o) => inRange(o.createdYmd, ctx.rangeStart, ctx.rangeEnd));
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { sheetType: 'orders', title: '기간 접수', subtitle: ctx.rangeStart + ' ~ ' + ctx.rangeEnd + ' · 접수일 기준', total: rows.length, columns: orderCols, rows: filterOrders(rows) };
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
      ? ' · ' + params.hour + '시' : '';
    return { sheetType: 'orders', title: day + ' 계약' + hourLabel, subtitle: '결제 일시 기준 · unqualified 제외', total: rows.length, columns: orderCols, rows: filterOrders(rows) };
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
      sheetType: 'summary', title: '시간대별 계약 요약', subtitle: ctx.dayA + ' vs ' + ctx.dayB, total: rows.length,
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
      sheetType: 'summary', title: '기간별 계약 · 접수 요약', subtitle: ctx.rangeStart + ' ~ ' + ctx.rangeEnd, total: rows.length,
      columns: [
        { key: 'date', label: '날짜' },
        { key: 'contract', label: '계약' },
        { key: 'lead', label: '접수' },
        { key: 'rate', label: '일별 전환율(%)' },
      ],
      rows: rows.map((r) => ({ ...r, rate: r.rate === null ? '–' : (r.rate * 100).toFixed(2) })),
      summary: { contractTotal: totalContract, leadTotal: totalLead, rate: rate(totalContract, totalLead) },
    };
  }
  if (type === 'dayContracts') {
    const day = clampYmd(params.day, ctx.rangeStart);
    const rows = qualified.filter((o) => o.paymentYmd === day);
    rows.sort((a, b) => new Date(b.paymentAt || 0) - new Date(a.paymentAt || 0));
    return { sheetType: 'orders', title: day + ' 계약', subtitle: '결제 일시 기준', total: rows.length, columns: orderCols, rows: filterOrders(rows) };
  }
  if (type === 'dayLeads') {
    const day = clampYmd(params.day, ctx.rangeStart);
    const rows = qualified.filter((o) => o.createdYmd === day);
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { sheetType: 'orders', title: day + ' 접수', subtitle: '접수일(created_at) 기준', total: rows.length, columns: orderCols, rows: filterOrders(rows) };
  }
  if (type === 'commissionOrders') {
    const won = (n) => (n == null ? 0 : n);
    let rows = qualified.filter((o) => o.commissionFee != null && inRange(o.paymentYmd, ctx.rangeStart, ctx.rangeEnd));
    if (params.day) { const day = clampYmd(params.day, ctx.rangeStart); rows = rows.filter((o) => o.paymentYmd === day); }
    rows.sort((a, b) => new Date(b.paymentAt || 0) - new Date(a.paymentAt || 0));
    const cTotal = rows.reduce((s, o) => s + won(o.commissionFee), 0);
    const qTotal = rows.reduce((s, o) => s + won(o.quotePrice), 0);
    const span = params.day ? clampYmd(params.day, ctx.rangeStart) : (ctx.rangeStart + ' ~ ' + ctx.rangeEnd);
    return {
      sheetType: 'orders',
      title: '수수료 내역',
      subtitle: span + ' · 계약일 기준 · 총 수수료 ' + cTotal.toLocaleString() + '원 · 견적합 ' + qTotal.toLocaleString() + '원 · ' + rows.length + '건',
      total: rows.length,
      columns: [
        { key: 'paymentYmd', label: '계약일' },
        { key: 'id', label: '주문 ID' },
        { key: 'quotePrice', label: '견적금액(원)', won: true },
        { key: 'commissionFee', label: '수수료(원)', won: true },
        { key: 'partnerPayout', label: '파트너정산(원)', won: true },
        { key: 'remainingBalance', label: '잔금(원)', won: true },
        { key: 'status', label: '상태' },
      ],
      rows: rows.map(toCommissionRow),
    };
  }
  if (type === 'commissionByDay') {
    const won = (n) => (n == null ? 0 : n);
    const pos = {}; const days = [];
    for (let d = ctx.rangeStart; d <= ctx.rangeEnd; d = shiftDate(d, 1)) { pos[d] = days.length; days.push(d); if (days.length > 370) break; }
    const comm = new Array(days.length).fill(0), cnt = new Array(days.length).fill(0), quo = new Array(days.length).fill(0);
    for (const o of qualified) {
      if (o.commissionFee == null) continue;
      const i = pos[o.paymentYmd]; if (i === undefined) continue;
      comm[i] += won(o.commissionFee); cnt[i] += 1; quo[i] += won(o.quotePrice);
    }
    const rows = days.map((d, i) => ({
      date: d, count: cnt[i], commission: comm[i],
      avg: cnt[i] ? Math.round(comm[i] / cnt[i]) : 0,
      rate: quo[i] ? Math.round((comm[i] / quo[i]) * 10000) / 100 : null,
    }));
    const cTotal = comm.reduce((a, b) => a + b, 0), n = cnt.reduce((a, b) => a + b, 0), qTotal = quo.reduce((a, b) => a + b, 0);
    return {
      sheetType: 'summary',
      title: '일자별 수수료',
      subtitle: ctx.rangeStart + ' ~ ' + ctx.rangeEnd + ' · 총 ' + cTotal.toLocaleString() + '원 · ' + n + '건 · 평균율 ' + (qTotal ? ((cTotal / qTotal) * 100).toFixed(2) : '–') + '%',
      total: rows.length,
      columns: [
        { key: 'date', label: '날짜' },
        { key: 'count', label: '계약' },
        { key: 'commission', label: '수수료합계(원)', won: true },
        { key: 'avg', label: '건당평균(원)', won: true },
        { key: 'rate', label: '수수료율(%)' },
      ],
      rows,
    };
  }

  const err = new Error('알 수 없는 시트 유형: ' + type);
  err.status = 400;
  throw err;
}
