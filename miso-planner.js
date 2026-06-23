'use strict';

// 플래너 월별 정산(인건비) 설정 — 필요 시 여기만 수정하면 됩니다.
export const PAYROLL_CONFIG = {
  baseSalary: 2330000,   // 계약직 기본급(월)
  visitFee: 18000,       // 프리랜서 방문 1건당
  cm: 52000,             // 인센티브 기여이익
  // 계약직 partner_id → 이름 (기본급 + 계약율 인센티브, 방문비 없음)
  contractPlanners: {
    85103: '김윤경', 85840: '김일신', 78162: '김현옥', 80769: '박원주',
    84706: '안호정', 85842: '이민아', 68545: '이영준', 84710: '하은정',
  },
  // 미소 Ops/내부 인원(이름 기준) → 0원
  opsNames: ['박주희', '유승한', '이지웅', '전영은', '지인호', '최성현', '최휘병'],
  excludeCancel: 'Cancelled by VisitCounsel sync', // 이 사유의 견적은 방문 아님(제외)
  visitingPrefix: '(방문 중)',                       // 주문 사유가 이걸로 시작하면 방문 인정(영상 무관)
};

// 인센티브 지급률 — 계약율(%) 구간
function incentiveRate(ratePct) {
  if (ratePct < 45) return 0;
  if (ratePct < 48) return 0.05;
  if (ratePct < 52) return 0.10;
  if (ratePct < 55) return 0.15;
  return 0.20;
}

export function shortName(n) {
  return String(n || '').replace('미소 ', '').replace(' 이사플래너', '').replace(' 이사 플래너', '').trim();
}

function kstDisp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

function latest(pool) {
  let best = null, bestKey = '';
  for (const q of pool) {
    const k = String(q.updated_at || q.created_at || '');
    if (best === null || k > bestKey) { best = q; bestKey = k; }
  }
  return best;
}

// rawOrders: 미소 requests 원본 배열 / partnerMap: { pid: {name, isPlanner} }
// month: 'YYYY-MM' (계약/방문 = 방문일 기준) / todayYmd: 'YYYY-MM-DD'
export function buildPayroll(rawOrders, partnerMap, month, todayYmd) {
  const m = globalThis.MisoMetrics;
  const PROG = new Set(['confirming', 'complete']);
  const C = PAYROLL_CONFIG;
  const isCurrentMonth = month === todayYmd.slice(0, 7);

  // pid -> { vf(전체방문), vq(상담가능방문), c(계약) }
  const agg = {};
  for (const r of rawOrders) {
    if (r.status === 'unqualified') continue;
    const allvq = (r.quotes || []).filter((q) => q && q.visit_schedule);
    if (!allvq.length) continue;
    const qual = allvq.filter((q) => !q.cancelled_at && !String(q.cancel_reason || '').includes(C.excludeCancel));
    let chosen, contracted = false, isQual = false;
    if (qual.length) {
      chosen = latest(qual); contracted = PROG.has(r.status); isQual = true;
    } else if (String(r.cancel_reason || '').includes(C.visitingPrefix)) {
      chosen = latest(allvq); // (방문 중) — 방문 인정(상담 아님)
    } else {
      continue; // 관리자 취소 등 = 방문 아님
    }
    const vy = m.toSeoulDate(chosen.visit_schedule);
    if (!vy || vy.slice(0, 7) !== month) continue;
    if (isCurrentMonth && vy > todayYmd) continue; // 아직 안 지난 방문 제외
    const pid = chosen.partner_id;
    const a = agg[pid] || (agg[pid] = { vf: 0, vq: 0, c: 0, proc: 0, orders: [] });
    const isContractOrder = isQual && contracted;
    a.vf += 1;
    if (isQual) { a.vq += 1; if (contracted) a.c += 1; }
    if (r.status === 'processing') a.proc += 1;
    a.orders.push({ id: r.id, visitDisp: kstDisp(chosen.visit_schedule), visitYmd: vy, status: r.status, contracted: isContractOrder, kind: isQual ? '상담' : '방문중' });
  }

  const rows = [];
  for (const pid in agg) {
    const a = agg[pid];
    const info = partnerMap[pid] || {};
    const isContract = !!C.contractPlanners[pid];
    if (!info.isPlanner && !isContract) continue;            // 미소플래너 아님 제외
    const fullName = info.name || C.contractPlanners[pid] || String(pid);
    if (/테스트|test/i.test(fullName)) continue;
    const name = shortName(fullName) || String(pid);
    let grp = '프리랜서', base = 0, inc = 0, fee = 0;
    if (C.opsNames.includes(name)) {
      grp = 'Ops';                                           // 0원
    } else if (isContract) {
      grp = '계약직';
      base = C.baseSalary;
      const rate = a.vq ? (a.c / a.vq) * 100 : 0;            // 상담가능 방문 기준 계약율
      inc = Math.round(a.c * C.cm * incentiveRate(rate));
    } else {
      grp = '프리랜서';
      fee = a.vf * C.visitFee;
    }
    rows.push({ pid: Number(pid), name, grp, visits: a.vf, contracts: a.c, proc: a.proc, rate: a.vf ? Math.round((a.c / a.vf) * 1000) / 10 : 0, base, inc, fee, total: base + inc + fee, orders: a.orders });
  }

  const rank = { '계약직': 0, '프리랜서': 1, 'Ops': 2 };
  rows.sort((x, y) => (rank[x.grp] - rank[y.grp]) || (y.total - x.total) || (y.visits - x.visits));
  const totals = rows.reduce((t, r) => ({
    visits: t.visits + r.visits, contracts: t.contracts + r.contracts,
    base: t.base + r.base, inc: t.inc + r.inc, fee: t.fee + r.fee, total: t.total + r.total,
  }), { visits: 0, contracts: 0, base: 0, inc: 0, fee: 0, total: 0 });

  return { month, rows, totals };
}
