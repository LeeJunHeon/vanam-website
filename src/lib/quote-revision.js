// 견적 개정(quote_revisions) 조립 — 순수 모듈 (DB·네트워크 없음, node 테스트가 빌드 없이 import).
//
//   formFromDetails   접수된 구조화 사본(details_json) → 예상 견적 입력(폼 모양)
//   defaultDocInfo    견적서 머리 정보(고객·견적번호·납기·유효 일수…)
//   buildDoc          고객용 견적서 데이터 — 고객에게 나가는 금액의 유일한 원천(doc_json)
//   buildAutoRevision 접수 시 자동 견적 한 건(저장할 개정의 내용)
//   customerQuoteView 조회 화면에 내보낼 견적 요약
//
// ⚠️ 고객에게 나가는 객체(buildDoc·customerQuoteView)는 **허용 목록으로 새로 만든다.**
//    스프레드·원본 객체 재사용 금지 — 원가·가산율·마진·ID·breakdown 이 섞여 나가는 사고를 구조로 막는다.
import { estimateForCustomer, manualLabel, addDays } from './quote-customer.js';
import { mapFormToQuote, QuoteMapError } from './quote-map.js';
import { telKr, customerLine } from './doc-excel.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * 공정 견적 구조화 사본이면 예상 견적 입력으로 바꾼다. 아니면 null.
 * @param {unknown} dj 파싱된 details_json
 * @param {'ko'|'en'|string} locale
 */
export function formFromDetails(dj, locale) {
  if (!isObj(dj) || dj.wafer || !Array.isArray(dj.seq)) return null;
  return {
    steps: dj.seq.map((s) => ({
      process: str(s?.process),
      material: str(s?.material),
      value: str(s?.value),
      unit: str(s?.unit),
      etc: str(s?.etc),
    })),
    measurements: Array.isArray(dj.measures) ? dj.measures.map(str) : [],
    sampleCount: dj.sampleCount,
    delivery: str(dj.delivery),
    substrateType: str(dj.substrateType),
    substrateSize: str(dj.substrateSize),
    substrateGrade: str(dj.substrateGrade),
    locale: locale === 'en' ? 'en' : 'ko',
  };
}

/** 가격 정책 한 줄의 값 */
const policyValue = (policy, key) => (Array.isArray(policy) ? policy : []).find((p) => p?.key === key)?.value;

/**
 * 견적서 연락처 — 영문 견적서는 국제 표기(+82-…) 그대로, 한글 견적서는 국내 표기(0…).
 * @param {string} locale @param {string} tel company.json 의 tel
 */
export function contactFor(locale, tel) {
  return locale === 'en' ? str(tel) : telKr(tel);
}

/**
 * 견적서 머리 정보.
 * @param {{inquiry:{id:string, name?:string, company?:string, productName?:string}, policy:any[], today:string, contact:string, locale:string}} a
 */
export function defaultDocInfo({ inquiry, policy, today, contact, locale }) {
  const days = Number(policyValue(policy, 'quote_valid_days'));
  return {
    // 한글 '소속 이름' · 영문 'Name, Company'
    customer: customerLine(inquiry?.company, inquiry?.name, locale),
    ref: '',
    title: str(inquiry?.productName),
    date: str(today),
    quoteNo: str(inquiry?.id),
    manager: '',
    contact: str(contact),
    // 영문 견적서에 한글 문장이 들어가지 않게 — 납기 문구는 정책값이 한국어다
    delivery: locale === 'ko' ? str(policyValue(policy, 'default_delivery_due')) : '',
    validDays: Number.isFinite(days) && days > 0 ? String(Math.trunc(days)) : '',
    payment: '',
  };
}

const INFO_KEYS = ['customer', 'ref', 'title', 'date', 'quoteNo', 'manager', 'contact', 'delivery', 'validDays', 'payment'];

/**
 * 고객용 견적서 데이터(doc_json). 엔진 결과가 정상일 때만.
 * @param {{input: {items:any[]}|null, result: any, info: Record<string, unknown>}} a
 */
export function buildDoc({ input, result, info }) {
  if (!result || result.status !== '정상') return null;
  const docInfo = {};
  for (const k of INFO_KEYS) docInfo[k] = str(info?.[k]);
  const inItems = Array.isArray(input?.items) ? input.items : [];
  const items = [];
  (Array.isArray(result.items) ? result.items : []).forEach((it, i) => {
    if (it?.status !== '정상') return;
    items.push({
      name: str(inItems[i]?.name),
      spec: str(it.spec),
      qty: inItems[i]?.qty ?? null,
      unit: str(inItems[i]?.unit),
      unitPrice: it.unitPrice ?? null,
      supply: it.supply ?? null,
      vat: it.vat ?? null,
    });
  });
  return {
    info: docInfo,
    items,
    supply: result.supply ?? null,
    vat: result.vat ?? null,
    total: result.total ?? null,
    totalKorean: str(result.totalKorean),
  };
}

/**
 * 접수 시 자동 견적 — 저장할 개정의 내용. 공정 견적이 아니면 null.
 * @param {{details: unknown, locale: string, priceDb: any, computeQuote: Function, today: string, info: Record<string, unknown>}} a
 */
export function buildAutoRevision({ details, locale, priceDb, computeQuote, today, info }) {
  const form = formFromDetails(details, locale);
  if (!form) return null;
  // USD 는 저장에 필요 없다 — 조회할 때 그때 환율로 다시 표기한다
  const { customer, debug } = estimateForCustomer({ form, priceDb, computeQuote, formatUsd: () => '', usdRate: 1, today });

  if (customer.kind === 'estimate') {
    return { kind: 'estimate', total: customer.totalKrw, input: debug.input, result: debug.result,
      doc: buildDoc({ input: debug.input, result: debug.result, info }), manual: [] };
  }
  if (customer.kind === 'manual') {
    return { kind: 'manual', total: null, input: debug.input, result: debug.result, doc: null, manual: debug.manual };
  }
  // invalid — 접수는 이미 됐으니 담당자 확인으로 넘긴다(입력 오류 항목을 사유로)
  let input = null;
  try {
    const m = mapFormToQuote(form, priceDb.recipes, { margin: '기본', runs: 1 });
    input = { items: m.items, layers: m.layers };
  } catch (e) {
    if (!(e instanceof QuoteMapError)) throw e;
  }
  return {
    kind: 'manual', total: null, input, result: null, doc: null,
    manual: (debug.errors ?? []).map((e) => (e.step ? { code: 'input', step: e.step, field: e.field } : { code: 'input', field: e.field })),
  };
}

/** 저장된 견적서 데이터를 같은 허용 목록으로 다시 만든다(저장 경로가 늘어나도 새는 키가 없게). */
function sanitizeDoc(doc) {
  if (!isObj(doc)) return null;
  const info = {};
  for (const k of INFO_KEYS) info[k] = str(doc.info?.[k]);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    info,
    items: (Array.isArray(doc.items) ? doc.items : []).filter(isObj).map((it) => ({
      name: str(it.name), spec: str(it.spec), qty: num(it.qty), unit: str(it.unit),
      unitPrice: num(it.unitPrice), supply: num(it.supply), vat: num(it.vat),
    })),
    supply: num(doc.supply),
    vat: num(doc.vat),
    total: num(doc.total),
    totalKorean: str(doc.totalKorean),
  };
}

const parse = (s) => {
  if (s === null || s === undefined || s === '') return null;
  try { return JSON.parse(String(s)); } catch { return null; }
};

/**
 * 조회 화면용 견적 요약 — 허용 목록으로 새로 만든다.
 * @param {{revision: {rev:number, source:string, kind:string, total:number|null, doc_json:string|null, manual_json:string|null, created_at:string}|null,
 *          inquiry: {quoted_amount?: unknown, quote_currency?: unknown, paid_at?: unknown},
 *          locale: string, usdRate: number, formatUsd: (krw:number, rate:number)=>string}} a
 */
export function customerQuoteView({ revision, inquiry, locale, usdRate, formatUsd }) {
  if (!revision) return null;
  const quoted = inquiry?.quoted_amount;
  const confirmed = typeof quoted === 'number' && Number.isFinite(quoted) && quoted > 0;
  const kind = revision.kind === 'manual' ? 'manual' : 'estimate';
  const state = kind === 'manual' ? (confirmed ? 'confirmed' : 'reviewing') : (confirmed ? 'confirmed' : 'estimate');
  const doc = kind === 'estimate' ? sanitizeDoc(parse(revision.doc_json)) : null;
  const total = typeof revision.total === 'number' ? revision.total : null;
  const cur = str(inquiry?.quote_currency).toUpperCase();
  const showDoc = kind === 'estimate' && isObj(doc) && total !== null
    && (state === 'estimate' || ((cur === 'KRW' || cur === '') && quoted === total));

  let validDays = null;
  let validUntil = null;
  if (showDoc) {
    const d = Number(doc?.info?.validDays);
    validDays = Number.isInteger(d) && d > 0 ? d : null;
    const date = str(doc?.info?.date);
    if (validDays !== null && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      try { validUntil = addDays(date, validDays); } catch { validUntil = null; }
    }
  }

  const manualEntries = state === 'reviewing' ? parse(revision.manual_json) : null;
  return {
    state,
    rev: revision.rev,
    updatedAt: revision.created_at,
    byStaff: revision.source === 'admin',
    totalKrw: showDoc ? total : null,
    totalKrwText: showDoc ? `₩${total.toLocaleString('ko-KR')}` : null,
    totalUsdText: showDoc ? formatUsd(total, usdRate) : null,
    validDays,
    validUntil,
    manual: Array.isArray(manualEntries) ? [...new Set(manualEntries.map((e) => manualLabel(e, locale)))] : [],
    doc: showDoc ? doc : null,
  };
}

/** 조회 응답(quote)에 절대 들어가면 안 되는 키 — 테스트·점검 스크립트가 쓴다 */
export const VIEW_FORBIDDEN_KEYS = ['cost', 'breakdown', 'markup', 'markupAmount', 'priceBeforeFloor', 'materialCost', 'depositCost',
  'depositMin', 'ratePerMin', 'substrateCost', 'loadingMin', 'setupMin', 'plasmaMin', 'waitMin', 'recipeId', 'recipe_id',
  'equipmentId', 'equipment_id', 'substrateId', 'catalog_id', 'layers', 'plan', 'result', 'input', 'input_json', 'result_json',
  'manual_json', 'margin', 'directMarkup', 'rawText', 'note', 'seen_total', 'price_sha', 'status'];
