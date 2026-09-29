// 관리자 견적 편집 — 순수 모듈 (DB·네트워크 없음, node 테스트가 빌드 없이 import).
//
//   sanitizeDocInfo     견적서 머리 정보 10칸을 허용 목록·길이 제한으로 정리한다
//   planInquirySync     담당자 저장 뒤 문의(inquiries)의 확정 금액·상태를 어떻게 맞출지
//   summarizeRevisions  견적 탭 카드용 개정 요약(접수 시 자동 견적 · 현재 견적)
//
// ⚠️ 저장 금액의 근거는 항상 서버 계산(computeQuote) 결과다. 여기 함수는 그 결과를 받아 정리만 한다.
import { manualLabelAdmin } from './quote-customer.js';

const LIMITS = {
  customer: 200, ref: 200, title: 200, delivery: 200, payment: 200,
  quoteNo: 60, manager: 60, contact: 60,
};
const INFO_KEYS = ['customer', 'ref', 'title', 'date', 'quoteNo', 'manager', 'contact', 'delivery', 'validDays', 'payment'];

/** 문자열·숫자만 문자열로(객체·배열·null 은 빈 문자열), 앞뒤 공백 제거 */
const text = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

/** 실제로 있는 날짜인가(YYYY-MM-DD, 2월 30일 같은 값은 거짓) */
const isYmd = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/**
 * 견적서 머리 정보 — 10개 키만, 문자열로.
 * @param {unknown} info
 * @param {{today: string}} opts today = 한국 날짜 YYYY-MM-DD
 * @returns {Record<string, string>}
 */
export function sanitizeDocInfo(info, { today }) {
  const src = info !== null && typeof info === 'object' && !Array.isArray(info) ? info : {};
  const out = {};
  for (const k of INFO_KEYS) {
    const v = text(src[k]);
    out[k] = LIMITS[k] ? v.slice(0, LIMITS[k]) : v;
  }
  if (!isYmd(out.date)) out.date = String(today ?? '');
  out.validDays = /^\d{1,3}$/.test(out.validDays) && Number(out.validDays) >= 1 && Number(out.validDays) <= 365
    ? String(Number(out.validDays))
    : '';
  return out;
}

/**
 * 담당자 저장 뒤 문의 행을 어떻게 맞출지.
 *   결제됨                     → { error: 'already_paid' }
 *   합계가 양수가 아님          → { error: 'bad_total' }   (엔진 '정상' 결과면 생기지 않는다 — 방어)
 *   확정 요청                  → 확정 금액 = 합계 · KRW · 상태 quoted
 *   이미 확정(KRW·통화 비움)    → 확정 금액도 새 합계로(고객 화면 실시간 반영)
 *   이미 확정(USD 등)          → 건드리지 않고 경고
 *   미확정                     → 문의 행은 그대로
 * @param {{inquiry: {quoted_amount?: unknown, quote_currency?: unknown, paid_at?: unknown}, total: unknown, confirm: boolean}} a
 */
export function planInquirySync({ inquiry, total, confirm }) {
  if (inquiry?.paid_at) return { error: 'already_paid' };
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return { error: 'bad_total' };
  if (confirm === true) return { update: { quoted_amount: total, quote_currency: 'KRW', status: 'quoted' } };
  const q = inquiry?.quoted_amount;
  const confirmed = typeof q === 'number' && Number.isFinite(q) && q > 0;
  if (!confirmed) return { update: null };
  const cur = String(inquiry?.quote_currency ?? '').trim().toUpperCase();
  if (cur === 'KRW' || cur === '') return { update: { quoted_amount: total } };
  return { update: null, warning: 'usd_confirmed' };
}

const parseArr = (s) => {
  try {
    const v = JSON.parse(String(s ?? ''));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const summary = (r) => ({
  rev: r.rev,
  source: r.source,
  kind: r.kind,
  total: typeof r.total === 'number' ? r.total : null,
  seenTotal: typeof r.seen_total === 'number' ? r.seen_total : null,
  createdAt: r.created_at ?? null,
  manualAdmin: parseArr(r.manual_json).map(manualLabelAdmin),
});

/**
 * 한 문의의 개정 행들 → 요약.
 * @param {{rev:number, source:string, kind:string, total:number|null, seen_total:number|null, manual_json:string|null, created_at:string}[]} rows
 */
export function summarizeRevisions(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r === 'object' && Number.isInteger(r.rev))
    .slice()
    .sort((a, b) => a.rev - b.rev);
  const firstAuto = list.find((r) => r.source === 'auto') ?? null;
  const last = list.length ? list[list.length - 1] : null;
  return {
    first: firstAuto ? summary(firstAuto) : null,
    latest: last ? summary(last) : null,
    count: list.length,
  };
}
