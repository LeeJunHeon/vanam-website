// scripts/test-quote-revision.mjs — 견적 개정 조립(quote-revision.js)·자동 견적 알림 문구(chat-message.js) 단위 테스트
//
// 가짜 레시피·금액만 쓴다(실제 가격 DB 와 겹치지 않는 값). 엔진은 가짜 결과를 돌려주는 대역으로 대신한다.
import {
  formFromDetails, defaultDocInfo, buildDoc, buildAutoRevision, customerQuoteView, VIEW_FORBIDDEN_KEYS, contactFor,
} from '../src/lib/quote-revision.js';
import { buildInquiryChatText, buildEstimateChatLine, ESTIMATE_LINE_MAX } from '../src/lib/chat-message.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}
/** 객체 깊이 검사 — 금지 키 목록 중 나온 것 */
const forbiddenIn = (o, keys) => {
  const found = new Set();
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (keys.includes(k)) found.add(k); walk(x); }
  })(o);
  return [...found];
};

// ── 가짜 가격 DB · 엔진 대역 ─────────────────────────────────────────────────
const R = (recipe_id, process_type, material_name, equipment_id) => ({ recipe_id, process_type, material_name, equipment_id, method: 'M', active: 1 });
const RECIPES = [R('T-SP-Ti', 'Sputter', 'Ti', 'EQ-SP1'), R('T-SP-Pt', 'Sputter', 'Pt', 'EQ-SP1'),
  R('T-ALD1-Al2O3', 'ALD', 'Al2O3(X)', 'EQ-ALD1'), R('T-ALD2-Al2O3', 'ALD', 'Al2O3(Y)', 'EQ-ALD2')];
const POLICY = [
  { key: 'quote_valid_days', value: '7', vtype: 'number' },
  { key: 'default_delivery_due', value: '계약 후 협의', vtype: 'string' },
];
const PRICE_DB = { policy: POLICY, recipes: RECIPES, equipment: [], substrates: [] };
const FAKE_IDS = ['T-SP-Ti', 'T-SP-Pt', 'T-ALD1-Al2O3', 'T-ALD2-Al2O3', 'EQ-SP1', 'EQ-ALD1', 'EQ-ALD2'];
/** 엔진 대역 — 품목마다 가짜 금액과 원가 내역(breakdown)까지 붙여, 새어 나가는지 본다 */
const fakeEngine = (_db, q) => ({
  status: '정상', supply: 222, vat: 22, total: 244, totalKorean: '이백사십사',
  items: q.items.map((it, i) => ({ no: it.no, status: '정상', unitPrice: 111, supply: 111, vat: 11, total: 122, spec: `S${i + 1}`,
    breakdown: { cost: 55, markup: 1, equipmentId: 'EQ-SP1' } })),
  layers: q.layers.map((l) => ({ ...l, status: '정상', materialCost: 5 })),
});
const badEngine = () => ({ status: '공정 입력 확인', supply: null, vat: null, total: null, totalKorean: null, items: [], layers: [] });

// ── contactFor ──────────────────────────────────────────────────────────────
eq('contactFor: en 국제 표기 그대로 · ko 국내 표기', [contactFor('en', '+82-0-0000-0000'), contactFor('ko', '+82-0-0000-0000'), contactFor('ko', '')],
  ['+82-0-0000-0000', '00-0000-0000', '']);

// ── formFromDetails ─────────────────────────────────────────────────────────
const PROC = {
  v: 1, sampleCount: '3', delivery: 'direct', substrateType: 'Silicon', substrateSize: '4inch',
  seq: [{ process: 'Sputter', material: 'Ti', value: '10', unit: 'nm', etc: '' }, { process: 'Sputter', material: 'Pt', value: '45', unit: 'nm', etc: 'x' }],
  measures: ['XPS'],
};
eq('formFromDetails: 공정 견적', formFromDetails(PROC, 'ko'), {
  steps: [{ process: 'Sputter', material: 'Ti', value: '10', unit: 'nm', etc: '' }, { process: 'Sputter', material: 'Pt', value: '45', unit: 'nm', etc: 'x' }],
  measurements: ['XPS'], sampleCount: '3', delivery: 'direct', substrateType: 'Silicon', substrateSize: '4inch', substrateGrade: '', locale: 'ko',
});
eq('formFromDetails: 등급·measures 없음 기본값', [formFromDetails({ seq: [] }, 'en').substrateGrade, formFromDetails({ seq: [] }, 'en').measurements, formFromDetails({ seq: [] }, 'fr').locale], ['', [], 'ko']);
eq('formFromDetails: 웨이퍼 → null', formFromDetails({ wafer: { sku: 'x' }, seq: [] }, 'ko'), null);
eq('formFromDetails: 깨진 값 → null', [formFromDetails(null, 'ko'), formFromDetails('text', 'ko'), formFromDetails([1], 'ko')], [null, null, null]);
eq('formFromDetails: seq 없음 → null', formFromDetails({ v: 1, delivery: 'direct' }, 'ko'), null);

// ── defaultDocInfo ──────────────────────────────────────────────────────────
const INQ = { id: 'INQ-20260101-TEST', name: '홍길동', company: '테스트대학', productName: 'Multilayers' };
const infoKo = defaultDocInfo({ inquiry: INQ, policy: POLICY, today: '2026-01-10', contact: '02-0000-0000', locale: 'ko' });
eq('defaultDocInfo ko', infoKo, { customer: '테스트대학 홍길동', ref: '', title: 'Multilayers', date: '2026-01-10', quoteNo: 'INQ-20260101-TEST',
  manager: '', contact: '02-0000-0000', delivery: '계약 후 협의', validDays: '7', payment: '' });
eq('defaultDocInfo en — 납기 한국어 문장 제외', defaultDocInfo({ inquiry: { ...INQ, company: '' }, policy: POLICY, today: '2026-01-10', contact: 'c', locale: 'en' }).delivery, '');
eq('defaultDocInfo — 회사 없으면 이름만 · 정책 없으면 유효 일수 빈 값',
  [defaultDocInfo({ inquiry: { ...INQ, company: '' }, policy: [], today: 't', contact: 'c', locale: 'ko' }).customer,
    defaultDocInfo({ inquiry: INQ, policy: [], today: 't', contact: 'c', locale: 'ko' }).validDays], ['홍길동', '']);

// ── buildDoc ────────────────────────────────────────────────────────────────
{
  const input = { items: [{ name: 'A', qty: 1, unit: '회', rawText: 'raw', margin: '기본' }, { name: 'B', qty: 1, unit: '회' }, { name: 'C', qty: 2, unit: '회' }] };
  const result = { status: '정상', supply: 300, vat: 30, total: 330, totalKorean: '삼백삼십', cost: 9,
    items: [
      { status: '정상', unitPrice: 100, supply: 100, vat: 10, spec: 'sa', breakdown: { cost: 1 } },
      { status: '', unitPrice: null, supply: null, vat: null, spec: '' },
      { status: '정상', unitPrice: 100, supply: 200, vat: 20, spec: 'sc', recipeId: 'T-SP-Ti' },
    ] };
  const doc = buildDoc({ input, result, info: { ...infoKo, extra: 'x', cost: 1 } });
  eq('buildDoc: 정상 품목만 입력 순서대로', doc.items.map((i) => i.name), ['A', 'C']);
  eq('buildDoc: 품목 허용 필드만', Object.keys(doc.items[0]), ['name', 'spec', 'qty', 'unit', 'unitPrice', 'supply', 'vat']);
  eq('buildDoc: info 10개 키만', Object.keys(doc.info), ['customer', 'ref', 'title', 'date', 'quoteNo', 'manager', 'contact', 'delivery', 'validDays', 'payment']);
  eq('buildDoc: 최상위 키', Object.keys(doc), ['info', 'items', 'supply', 'vat', 'total', 'totalKorean']);
  eq('buildDoc: 금지 키 0건', forbiddenIn(doc, VIEW_FORBIDDEN_KEYS), []);
  eq('buildDoc: 비정상 결과·결과 없음 → null', [buildDoc({ input, result: { ...result, status: '품목 입력 확인' }, info: infoKo }), buildDoc({ input, result: null, info: infoKo })], [null, null]);
}

// ── buildAutoRevision ───────────────────────────────────────────────────────
const auto = (details, engine = fakeEngine, locale = 'ko') =>
  buildAutoRevision({ details, locale, priceDb: PRICE_DB, computeQuote: engine, today: '2026-01-10', info: infoKo });
{
  const a = auto({ ...PROC, measures: [] });
  eq('buildAutoRevision estimate', [a.kind, a.total, a.manual, a.doc?.total, a.input.items.length], ['estimate', 244, [], 244, 1]);
  eq('estimate doc 에 원가·ID 없음', [forbiddenIn(a.doc, VIEW_FORBIDDEN_KEYS), FAKE_IDS.filter((id) => JSON.stringify(a.doc).includes(id))], [[], []]);
  const m = auto(PROC); // 분석 XPS 포함 → manual
  eq('buildAutoRevision manual', [m.kind, m.total, m.doc, m.manual], ['manual', null, null, [{ code: 'measure', name: 'XPS' }]]);
  const m2 = auto({ ...PROC, seq: [{ process: 'ALD', material: 'Al2O3', value: '10' }], measures: [] });
  eq('후보 2개 → manual step', m2.manual, [{ code: 'step', step: 1, process: 'ALD', material: 'Al2O3', reason: 'chooseEquipment' }]);
  const inv = auto({ ...PROC, sampleCount: '0', seq: [{ process: 'Sputter', material: 'Ti', value: 'abc' }], measures: [] });
  eq('invalid → manual(입력 확인 항목)', [inv.kind, inv.total, inv.result, inv.doc, inv.manual],
    ['manual', null, null, null, [{ code: 'input', field: 'sampleCount' }, { code: 'input', step: 1, field: 'value' }]]);
  eq('invalid 여도 입력(items·layers)은 남긴다', inv.input?.items.length, 1);
  eq('엔진 오류 → manual pricing', auto({ ...PROC, measures: [] }, badEngine).manual, [{ code: 'pricing', engineStatus: '공정 입력 확인' }]);
  eq('비공정(웨이퍼) → null', auto({ wafer: { sku: 'x' } }), null);
}

// ── customerQuoteView ───────────────────────────────────────────────────────
const DOC = buildDoc({ input: { items: [{ name: 'A', qty: 1, unit: '회' }] },
  result: { status: '정상', supply: 300, vat: 30, total: 330, totalKorean: '삼백삼십', items: [{ status: '정상', unitPrice: 300, supply: 300, vat: 30, spec: 's' }] }, info: infoKo });
const REV = { rev: 1, source: 'auto', kind: 'estimate', total: 330, doc_json: JSON.stringify(DOC), manual_json: '[]', created_at: '2026-01-10T00:00:00.000Z',
  input_json: '{"cost":1}', result_json: '{"breakdown":1}', note: '메모', seen_total: 1, price_sha: 'abc' };
const MREV = { ...REV, kind: 'manual', total: null, doc_json: null, manual_json: JSON.stringify([{ code: 'measure', name: 'XPS' }, { code: 'samples' }]) };
const usd = (k, r) => `$${(k / r).toFixed(2)}`;
const view = (revision, inquiry, locale = 'ko') => customerQuoteView({ revision, inquiry, locale, usdRate: 10, formatUsd: usd });
{
  const e = view(REV, { quoted_amount: null, quote_currency: 'KRW', paid_at: null });
  eq('estimate: 금액·유효기간·doc', [e.state, e.totalKrw, e.totalKrwText, e.totalUsdText, e.validDays, e.validUntil, e.doc?.total, e.manual, e.byStaff, e.rev],
    ['estimate', 330, '₩330', '$33.00', 7, '2026-01-17', 330, [], false, 1]);
  const r = view(MREV, { quoted_amount: null });
  eq('reviewing: 문구만·금액 없음', [r.state, r.manual, r.totalKrw, r.doc], ['reviewing', ['분석: XPS', '샘플 수량 10개 이상'], null, null]);
  eq('reviewing en', view(MREV, { quoted_amount: null }, 'en').manual, ['Analysis: XPS', '10 or more samples']);
  const c1 = view(REV, { quoted_amount: 330, quote_currency: 'KRW' });
  eq('confirmed + KRW 금액 일치 → doc 있음', [c1.state, c1.doc?.total, c1.totalKrw], ['confirmed', 330, 330]);
  const c1b = view(REV, { quoted_amount: 330, quote_currency: null });
  eq('confirmed + 통화 비어 있음·금액 일치 → doc 있음', [c1b.state, Boolean(c1b.doc)], ['confirmed', true]);
  const c2 = view(REV, { quoted_amount: 999, quote_currency: 'KRW' });
  eq('confirmed + 금액 불일치 → doc null·금액 null', [c2.state, c2.doc, c2.totalKrw, c2.validUntil], ['confirmed', null, null, null]);
  const c3 = view(REV, { quoted_amount: 330, quote_currency: 'USD' });
  eq('confirmed + USD → doc null', [c3.state, c3.doc], ['confirmed', null]);
  const c4 = view(MREV, { quoted_amount: 500, quote_currency: 'KRW' });
  eq('manual + confirmed → 문구 없음·doc null', [c4.state, c4.manual, c4.doc], ['confirmed', [], null]);
  eq('revision 없음 → null', view(null, { quoted_amount: null }), null);
  const broken = view({ ...REV, doc_json: '{broken', manual_json: '[oops' }, { quoted_amount: null });
  eq('깨진 doc JSON → 예외 없이 doc null', [broken.state, broken.doc, broken.totalKrw], ['estimate', null, null]);
  eq('깨진 manual JSON → 예외 없이 빈 목록', view({ ...MREV, manual_json: '[oops' }, { quoted_amount: null }).manual, []);
  eq('byStaff', view({ ...REV, source: 'admin' }, { quoted_amount: null }).byStaff, true);
  eq('유효 일수 없으면 validUntil null', view({ ...REV, doc_json: JSON.stringify({ ...DOC, info: { ...DOC.info, validDays: '' } }) }, { quoted_amount: null }).validUntil, null);
  eq('월 넘김 유효기간', view({ ...REV, doc_json: JSON.stringify({ ...DOC, info: { ...DOC.info, date: '2026-01-28' } }) }, { quoted_amount: null }).validUntil, '2026-02-04');
  // 저장된 doc 에 금지 키가 섞여 있어도 조회 응답에서는 걸러진다
  const dirty = view({ ...REV, doc_json: JSON.stringify({ ...DOC, cost: 1, items: [{ ...DOC.items[0], breakdown: { cost: 1 }, recipeId: 'T-SP-Ti' }] }) }, { quoted_amount: null });
  eq('저장된 doc 의 금지 키도 걸러짐', [forbiddenIn(dirty, VIEW_FORBIDDEN_KEYS), FAKE_IDS.filter((id) => JSON.stringify(dirty).includes(id))], [[], []]);
  const all = [e, r, c1, c2, c3, c4, broken];
  eq('모든 view: 금지 키 0건', forbiddenIn(all, VIEW_FORBIDDEN_KEYS), []);
  eq('모든 view: 가짜 ID 0건', FAKE_IDS.filter((id) => JSON.stringify(all).includes(id)), []);
  eq('view 최상위 키(허용 목록)', Object.keys(e), ['state', 'rev', 'updatedAt', 'byStaff', 'totalKrw', 'totalKrwText', 'totalUsdText', 'validDays', 'validUntil', 'manual', 'doc']);
}

// ── 자동 견적 알림 한 줄 ─────────────────────────────────────────────────────
eq('buildEstimateChatLine estimate', buildEstimateChatLine({ kind: 'estimate', total: 12345, seenTotal: null }), '💰 예상 견적(자동): ₩12,345 (부가세 포함 · 확정 전)');
eq('buildEstimateChatLine estimate 같은 금액', buildEstimateChatLine({ kind: 'estimate', total: 12345, seenTotal: 12345 }), '💰 예상 견적(자동): ₩12,345 (부가세 포함 · 확정 전)');
eq('buildEstimateChatLine estimate 고객 화면 금액 다름', buildEstimateChatLine({ kind: 'estimate', total: 12345, seenTotal: 11111 }),
  '💰 예상 견적(자동): ₩12,345 (부가세 포함 · 확정 전) · 고객 화면 금액 ₩11,111 과 다름');
eq('buildEstimateChatLine manual', buildEstimateChatLine({ kind: 'manual', total: null, manualAdmin: ['분석: XPS — 가격 자료 없음', '샘플 수량 10개 이상'] }),
  '💰 예상 견적(자동): 담당자 확인 필요 — 분석: XPS — 가격 자료 없음 / 샘플 수량 10개 이상');
{
  const many = Array.from({ length: 30 }, (_, i) => `${i + 1}단계 X`);
  const line = buildEstimateChatLine({ kind: 'manual', total: null, manualAdmin: many });
  eq('buildEstimateChatLine manual 사유 많음 → 앞 8개 + 외 N건', [ESTIMATE_LINE_MAX, line.endsWith('8단계 X 외 22건'), line.includes('9단계 X')], [8, true, false]);
}

// ── 알림 본문: estimateLine 이 없으면 수정 전과 바이트 단위로 같다 ──────────────
// 아래 기대값은 수정 전 chat-message.js 의 출력을 그대로 떠서 고정한 것이다(가짜 입력).
const who = '담당: 홍길동 (테스트대학) · test@example.invalid · 010-0000-0000';
const meta = '접수번호 INQ-20260101-ABCD · ko · 2026-01-01 09:00 KST';
const IN_A = { type: 'quote', productName: '다층 박막', product: 'multilayers', who, substrate: 'Silicon · 4 inch', sampleCount: '5', details: '공정 1. Sputter Ti 10 nm\n공정 2. Sputter Pt 45 nm', meta };
const IN_B = { type: 'quote', productName: 'Oxides', product: 'oxides', who, substrate: '', sampleCount: '', details: '공정 1. ALD Al2O3 20 nm\n배송[KR]: 홍길동 · 010-0000-0000\n  (00000) 서울시 어딘가 1', meta };
const IN_C = { type: 'general', who, waferLine: '상품: 4인치 테스트 웨이퍼 (wafer-x) × 2박스 · 다이싱: 불필요', message: '웨이퍼 대량 구매 문의', meta };
const OUT_A = '📩 *새 견적 요청*\n상품: 다층 박막 (multilayers)\n담당: 홍길동 (테스트대학) · test@example.invalid · 010-0000-0000\n기판: Silicon · 4 inch | 총 샘플: 5\n\n공정 1. Sputter Ti 10 nm\n공정 2. Sputter Pt 45 nm\n접수번호 INQ-20260101-ABCD · ko · 2026-01-01 09:00 KST';
const OUT_B = '📩 *새 견적 요청*\n상품: Oxides (oxides)\n담당: 홍길동 (테스트대학) · test@example.invalid · 010-0000-0000\n기판: — | 총 샘플: —\n\n공정 1. ALD Al2O3 20 nm\n배송[KR]: 홍길동 · 010-0000-0000\n  (00000) 서울시 어딘가 1\n접수번호 INQ-20260101-ABCD · ko · 2026-01-01 09:00 KST';
const OUT_C = '✉️ *새 문의*\n담당: 홍길동 (테스트대학) · test@example.invalid · 010-0000-0000\n상품: 4인치 테스트 웨이퍼 (wafer-x) × 2박스 · 다이싱: 불필요\n내용: 웨이퍼 대량 구매 문의\n접수번호 INQ-20260101-ABCD · ko · 2026-01-01 09:00 KST';
eq('알림 본문 A 바이트 동일(공정 견적)', buildInquiryChatText(IN_A), OUT_A);
eq('알림 본문 B 바이트 동일(배송 주소)', buildInquiryChatText(IN_B), OUT_B);
eq('알림 본문 C 바이트 동일(웨이퍼 문의)', buildInquiryChatText(IN_C), OUT_C);
eq('estimateLine 빈 값·undefined 도 바이트 동일', [buildInquiryChatText({ ...IN_A, estimateLine: '' }), buildInquiryChatText({ ...IN_A, estimateLine: undefined })], [OUT_A, OUT_A]);
{
  const line = '💰 예상 견적(자동): ₩12,345 (부가세 포함 · 확정 전)';
  const withLine = buildInquiryChatText({ ...IN_A, estimateLine: line });
  eq('estimateLine 위치: 요청 본문 다음·meta 앞(빈 줄 하나)', withLine,
    OUT_A.replace('\n접수번호 INQ-20260101-ABCD', `\n\n${line}\n접수번호 INQ-20260101-ABCD`));
  eq('일반 문의는 estimateLine 을 쓰지 않는다', buildInquiryChatText({ ...IN_C, estimateLine: line }), OUT_C);
}

if (failed) {
  console.error(`\n견적 개정·알림 문구 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 견적 개정(quote-revision)·자동 견적 알림 문구 — ${total}건 통과`);
