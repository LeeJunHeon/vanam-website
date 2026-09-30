// scripts/test-quote-map.mjs — 폼 입력 → 엑셀 형식 변환(quote-map.js)·고객 판정(quote-customer.js) 단위 테스트
//
// 가짜 레시피·기판·금액으로 규칙만 본다(실제 가격 계산은 엔진 테스트의 몫).
// 레시피·장비·기판 ID 와 금액은 실제 DB 와 겹치지 않는 가짜 값이다.
import { mapFormToQuote, recipeCandidates, parseThickness, runsOf, conv, QuoteMapError, REASON } from '../src/lib/quote-map.js';
import {
  estimateForCustomer, matchSubstrate, planRuns, prettyFormula, addDays, SAMPLE_MANUAL_MIN, FORBIDDEN_CUSTOMER_KEYS,
  manualLabel, manualLabelAdmin, GRADES, GRADED_TYPES, MAX_FORM_ERRORS,
} from '../src/lib/quote-customer.js';
import { buildAutoRevision } from '../src/lib/quote-revision.js';
import { SUBSTRATE_GRADES, GRADED_SUBSTRATES } from '../src/lib/quote-fields.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}
const throwsCode = (fn) => { try { fn(); return '예외 없음'; } catch (e) { return e instanceof QuoteMapError ? e.code : `다른 예외: ${e.message}`; } };

// ── 가짜 레시피 ─────────────────────────────────────────────────────────────
const R = (recipe_id, process_type, material_name, equipment_id, active = 1) =>
  ({ recipe_id, process_type, material_name, equipment_id, method: 'M', active });
const RECIPES = [
  R('T-SP-Ti', 'Sputter', 'Ti', 'EQ-SP1'),
  R('T-SP-Pt', 'Sputter', 'Pt', 'EQ-SP1'),
  R('T-SP2-Cr', 'Sputter', 'Cr', 'EQ-SP2'),
  R('T-SP-AlN', 'Sputter', 'AlN(Fake)', 'EQ-SP1'),       // 괄호는 떼고 AlN 으로 매칭
  R('T-ALD1-Al2O3', 'ALD', 'Al2O3(X)', 'EQ-ALD1'),
  R('T-ALD2-Al2O3', 'ALD', 'Al2O3(Y)', 'EQ-ALD2'),        // 후보 2개
  R('T-ALD1-HfO2', 'ALD', 'HfO2', 'EQ-ALD1'),
  R('T-SP-Off', 'Sputter', 'Mo', 'EQ-SP1', 0),            // 사용 중지 → 후보 아님
];
const S = (process, material, value) => ({ process, material, value, unit: '', etc: '' });
const form = (steps, over = {}) => ({ steps, sampleCount: 1, ...over });
const run = (steps, over, opts) => mapFormToQuote(form(steps, over), RECIPES, opts);

// ── 후보 ────────────────────────────────────────────────────────────────────
const C = recipeCandidates(RECIPES);
eq('후보: Sputter Ti 1개', C['Sputter|Ti'].map((r) => r.recipe_id), ['T-SP-Ti']);
eq('후보: 괄호 뗀 AlN', C['Sputter|AlN'].map((r) => r.recipe_id), ['T-SP-AlN']);
eq('후보: ALD Al2O3 2개(괄호 뗀 뒤 같음)', C['ALD|Al2O3'].map((r) => r.recipe_id), ['T-ALD1-Al2O3', 'T-ALD2-Al2O3']);
eq('후보: 사용 중지 제외', C['Sputter|Mo'], undefined);

// ── 변환: 품목 묶기 ─────────────────────────────────────────────────────────
{
  const m = run([S('Sputter', 'Pt', '45')], { sampleCount: 3 });
  eq('단일 층: 품목 필드', [m.items[0].name, m.items[0].method, m.items[0].unit, m.items[0].vat, m.items[0].margin, m.items[0].plasma, m.items[0].qty],
    ['Sputter Pt', '박막자동', '회', '별도', '기본', 'N', 1]);
  eq('단일 층: 층', m.layers, [{ itemNo: 1, order: 1, recipeId: 'T-SP-Pt', thicknessNm: 45, repeat: 1, tempC: null }]);
  eq('조정값 칸은 비움', [m.items[0].directMarkup, m.items[0].loadingMin, m.items[0].setupMin, m.items[0].waitMin], [null, null, null, null]);
  const m2 = run([S('Sputter', 'Ti', '15'), S('Sputter', 'Pt', '45')]);
  eq('같은 장비 다층: 품목 1', [m2.items.length, m2.items[0].name], [1, 'Sputter Ti/Pt']);
  const m3 = run([S('Sputter', 'Ti', '10'), S('ALD', 'HfO2', '5')]);
  eq('장비 전환: 품목 2', m3.items.map((i) => i.name), ['Sputter Ti', 'ALD HfO2']);
  eq('같은 공정 다른 장비도 분리', run([S('Sputter', 'Ti', '10'), S('Sputter', 'Cr', '10')]).items.length, 2);
}
// ── 변환: 플라즈마 · 끊기 · 제외 ─────────────────────────────────────────────
{
  const m = run([S('PlasmaCleaning (In-situ)', 'Ar', '5'), S('Sputter', 'Ti', '10')]);
  eq('플라즈마: 다음 증착 품목에 Y 5분', [m.items[0].plasma, m.items[0].plasmaMin], ['Y', 5]);
  const m2 = run([S('Sputter', 'Ti', '10'), S('PlasmaCleaning (In-situ)', 'Ar', '5'), S('Sputter', 'Pt', '10')]);
  eq('플라즈마는 품목을 끊지 않는다', [m2.items.length, m2.items[0].plasmaMin], [1, 5]);
  const m3 = run([S('Sputter', 'Ti', '10'), S('Annealing', 'N2', '30'), S('Sputter', 'Pt', '10')]);
  eq('어닐링이 끼면 품목 분리', m3.items.map((i) => i.name), ['Sputter Ti', 'Sputter Pt']);
  eq('어닐링은 extras(kind)', m3.extras.map((e) => [e.step, e.kind]), [[2, 'noPrice']]);
  eq('후보 2개 → chooseEquipment', run([S('ALD', 'Al2O3', '20')]).extras.map((e) => e.kind), ['chooseEquipment']);
  eq('레시피 없음 → noRecipe', run([S('Sputter', 'Au', '10')]).extras.map((e) => e.kind), ['noRecipe']);
  eq('분석 → measurement', run([S('Sputter', 'Ti', '10')], { measurements: ['XPS'] }).extras.map((e) => [e.process, e.kind]), [['XPS', 'measurement']]);
}
// ── 변환: 옵션 ──────────────────────────────────────────────────────────────
{
  // 반복 구간은 운영 범위 밖 — 옵션이 와도 층 반복은 항상 1
  const m = run([S('Sputter', 'Ti', '10'), S('Sputter', 'Pt', '10')], {}, { layerRepeats: { 1: 7, 2: 7 } });
  eq('층 반복은 항상 1(옛 옵션 무시)', m.layers.map((l) => l.repeat), [1, 1]);
  eq('마진 옵션 비우면 기본', run([S('Sputter', 'Ti', '10')], {}, {}).items[0].margin, '기본');
  const steps = [S('Sputter', 'Ti', '10'), S('ALD', 'HfO2', '5')];
  const s1 = run(steps, { sampleCount: 8 }, { substrateId: 'SUB-X', substratePerRun: 4 });
  eq('기판: 첫 품목에만', s1.items.map((i) => [i.substrateId, i.substratePerRun]), [['SUB-X', 4], [null, null]]);
  eq('기판 장수 비움 → 투입 장수', run(steps, { sampleCount: 8 }, { substrateId: 'SUB-X', perRun: 2 }).items[0].substratePerRun, 2);
  eq('투입 장수도 비움 → 샘플 수', run(steps, { sampleCount: 8 }, { substrateId: 'SUB-X' }).items[0].substratePerRun, 8);
  eq('회수: runs 옵션 우선', runsOf(8, { runs: 1, perRun: 2 }), 1);
  eq('회수: 5 ÷ 2 = 3', runsOf(5, { perRun: 2 }), 3);
  eq('회수: 투입 장수 비움 → 1', runsOf(5, {}), 1);
}
eq('두께: "1,000 nm"', parseThickness('1,000 nm'), 1000);
eq('두께: "100~200" 원문', parseThickness('100~200'), '100~200');
eq('conv: 0 은 0', conv('0'), 0);
{
  const many = Array.from({ length: 16 }, (_, i) => (i % 2 ? S('Sputter', 'Cr', '1') : S('Sputter', 'Ti', '1')));
  eq('품목 16개 거부', throwsCode(() => run(many)), 'too_many_items');
  eq('층 101개 거부', throwsCode(() => run(Array.from({ length: 101 }, () => S('Sputter', 'Ti', '1')))), 'too_many_layers');
}

// ── 고객 판정 ───────────────────────────────────────────────────────────────
const SUB = (catalog_id, item_name, size_inch, oxide_nm, cost_per_unit, active = 1) => ({ catalog_id, item_name, size_inch, oxide_nm, cost_per_unit, active });
const SUBSTRATES = [
  SUB('FS-01', '4in Fake Sapphire', 4, null, 11),
  SUB('FS-02', '4in Boron TEST bare', 4, null, 12),
  SUB('FS-03', '6in Boron test bare', 6, null, 13),
  SUB('FS-04', '6in Boron TEST bare copy', 6, null, 13),     // 원가 같은 중복 → 가장 작은 ID
  SUB('FS-05', '6in Boron PRIME bare', 6, null, 14),
  SUB('FS-06', '6in Boron Prime bare other', 6, null, 15),  // 원가 다른 중복 → 담당자 확인
  SUB('FS-07', '6in Boron TEST oxide', 6, 90, 16),
  SUB('FS-08', '4in Boron TEST oxide', 4, 90, 17, 0),        // 사용 중지
];
eq('기판: Sapphire 4', matchSubstrate(SUBSTRATES, { type: 'Sapphire', size: '4inch' }).row?.catalog_id, 'FS-01');
eq('기판: Silicon 4 Test', matchSubstrate(SUBSTRATES, { type: 'Silicon', size: '4inch', grade: 'Test' }).row?.catalog_id, 'FS-02');
eq('기판: 원가 같은 중복 → 작은 ID', matchSubstrate(SUBSTRATES, { type: 'Silicon', size: '6inch', grade: 'Test' }).row?.catalog_id, 'FS-03');
eq('기판: 원가 다른 중복 → ambiguous', matchSubstrate(SUBSTRATES, { type: 'Silicon', size: '6inch', grade: 'Prime' }).status, 'ambiguous');
eq('기판: Silicon oxide 6 Test', matchSubstrate(SUBSTRATES, { type: 'Silicon oxide', size: '6inch', grade: 'Test' }).row?.catalog_id, 'FS-07');
eq('기판: 사용 중지 제외 → none', matchSubstrate(SUBSTRATES, { type: 'Silicon oxide', size: '4inch', grade: 'Test' }).status, 'none');
eq('기판: Silicon 4 Prime → none', matchSubstrate(SUBSTRATES, { type: 'Silicon', size: '4inch', grade: 'Prime' }).status, 'none');
eq('기판: Glass → none', matchSubstrate(SUBSTRATES, { type: 'Glass', size: '4inch' }).status, 'none');
eq('기판: 기타 크기 → none', matchSubstrate(SUBSTRATES, { type: 'Sapphire', size: '__other__' }).status, 'none');

// 엔진 대역: 품목이 있으면 정상 + 가짜 합계. computeQuote 가 받은 입력을 기록한다.
let seen = null;
const fakeEngine = (_db, q) => { seen = q; return { status: '정상', total: 1234, supply: 1122, vat: 112, items: q.items.map(() => ({ status: '정상' })) }; };
const badEngine = () => ({ status: '공정 입력 확인', total: null, items: [] });
const DB = { policy: [{ key: 'quote_valid_days', value: '7', vtype: 'number' }], recipes: RECIPES, equipment: [], substrates: SUBSTRATES };
const est = (f, engine = fakeEngine) => estimateForCustomer({
  form: { locale: 'ko', delivery: 'direct', ...f }, priceDb: DB, computeQuote: engine, formatUsd: (k, r) => `$${(k / r).toFixed(2)}`, usdRate: 1000, today: '2026-01-10',
});
const cust = (f, e) => est(f, e).customer;

eq('estimate: 합계·USD·유효기간', cust({ steps: [S('Sputter', 'Ti', '10')], sampleCount: 1 }),
  { kind: 'estimate', totalKrw: 1234, totalKrwText: '₩1,234', totalUsdText: '$1.23', usdRate: 1000, validDays: 7, validUntil: '2026-01-17' });
est({ steps: [S('Sputter', 'Ti', '10')], sampleCount: 1 });
eq('마진 항상 기본·회수 1', [seen.items[0].margin, seen.items[0].qty], ['기본', 1]);
eq(`샘플 ${SAMPLE_MANUAL_MIN - 1} → estimate`, cust({ steps: [S('Sputter', 'Ti', '10')], sampleCount: SAMPLE_MANUAL_MIN - 1 }).kind, 'estimate');
eq(`샘플 ${SAMPLE_MANUAL_MIN} → manual`, cust({ steps: [S('Sputter', 'Ti', '10')], sampleCount: SAMPLE_MANUAL_MIN }), { kind: 'manual', manual: ['샘플 수량 10개 이상'] });
eq('planRuns 경계', [planRuns(9), planRuns(10)], [{ runs: 1, manual: false }, { runs: 1, manual: true }]);

// 반복 구간 입력은 받지 않는다 — 와도 무시(층 반복 1, 오류 없음)
{
  const r = est({ steps: [S('Sputter', 'Ti', '5'), S('Sputter', 'Pt', '5')], sampleCount: 1, repeatGroup: { from: 2, to: 1, count: 1 } });
  eq('반복 구간 입력 무시 → estimate · 층 반복 1', [r.customer.kind, r.debug.input.layers.map((l) => l.repeat)], ['estimate', [1, 1]]);
  eq('debug 에 반복 구간 표시 없음', 'repeatGroup' in r.debug.flags, false);
}

// 담당자 확인 항목
eq('후보 2개 → manual', cust({ steps: [S('ALD', 'Al2O3', '10')], sampleCount: 1 }), { kind: 'manual', manual: ['1단계 ALD Al₂O₃'] });
eq('분석 → manual', cust({ steps: [S('Sputter', 'Ti', '10')], measurements: ['XPS'], sampleCount: 1 }), { kind: 'manual', manual: ['분석: XPS'] });
eq('어닐링 → manual', cust({ steps: [S('Sputter', 'Ti', '10'), S('Annealing', 'N2', '60'), S('Sputter', 'Pt', '10')], sampleCount: 1 }), { kind: 'manual', manual: ['2단계 Annealing N₂'] });
// 공정 시퀀스 물질 변경 — Annealing O2·Ar 추가, Ag·Te 는 Evaporator 로(가격 자료가 없어 담당자 확인)
eq('어닐링 O2 → manual', cust({ steps: [S('Sputter', 'Ti', '10'), S('Annealing', 'O2', '30')], sampleCount: 1 }), { kind: 'manual', manual: ['2단계 Annealing O₂'] });
eq('어닐링 Ar → manual', cust({ steps: [S('Annealing', 'Ar', '30'), S('Sputter', 'Pt', '10')], sampleCount: 1 }), { kind: 'manual', manual: ['1단계 Annealing Ar'] });
eq('Evaporator Ag → manual', cust({ steps: [S('Evaporator', 'Ag', '50')], sampleCount: 1 }), { kind: 'manual', manual: ['1단계 Evaporator Ag'] });
eq('Evaporator Te → manual', cust({ steps: [S('Sputter', 'Ti', '10'), S('Evaporator', 'Te', '20')], sampleCount: 1 }), { kind: 'manual', manual: ['2단계 Evaporator Te'] });
eq('엔진 오류(가격 자료) → manual', cust({ steps: [S('Sputter', 'Ti', '10')], sampleCount: 1 }, badEngine), { kind: 'manual', manual: ['가격 자료 확인'] });

// 기판(구매 요청)
const buy = (type, size, grade) => est({ steps: [S('Sputter', 'Ti', '10')], sampleCount: 2, delivery: 'purchase', substrateType: type, substrateSize: size, substrateGrade: grade });
{
  const r = buy('Sapphire', '4inch');
  eq('구매 Sapphire 4 → estimate + 기판 첫 품목', [r.customer.kind, r.debug.input.items[0].substrateId, r.debug.input.items[0].substratePerRun], ['estimate', 'FS-01', 2]);
  eq('구매 Silicon 6 Test(원가 같은 중복) → estimate', buy('Silicon', '6inch', 'Test').customer.kind, 'estimate');
  eq('구매 Silicon 6 Prime(원가 다른 중복) → manual', buy('Silicon', '6inch', 'Prime').customer, { kind: 'manual', manual: ['기판: Silicon 6 inch Prime'] });
  eq('구매 Glass 4 → manual', buy('Glass', '4inch').customer, { kind: 'manual', manual: ['기판: Glass 4 inch'] });
  eq('구매 Silicon 등급 없음 → invalid', buy('Silicon', '6inch', '').customer.errors.map((e) => e.field), ['substrateGrade']);
  eq('방문 전달이면 기판 없음', est({ steps: [S('Sputter', 'Ti', '10')], sampleCount: 2, substrateType: 'Glass', substrateSize: '4inch' }).debug.input.items[0].substrateId, null);
}

// 입력 오류
eq('두께 "100~200" → invalid 1단계', cust({ steps: [S('Sputter', 'Pt', '100~200')], sampleCount: 1 }).errors, [{ step: 1, field: 'value', message: '1단계 두께를 숫자로 입력해 주세요.' }]);
eq('샘플 0 → invalid', cust({ steps: [S('Sputter', 'Ti', '10')], sampleCount: '0' }).errors.map((e) => e.field), ['sampleCount']);
eq('샘플 2.5 → invalid', cust({ steps: [S('Sputter', 'Ti', '10')], sampleCount: '2.5' }).kind, 'invalid');
eq('공정 없음 → invalid', cust({ steps: [], sampleCount: 1 }).errors.map((e) => e.field), ['process']);
eq('물질 없음 → invalid', cust({ steps: [S('Sputter', '', '10')], sampleCount: 1 }).errors.map((e) => [e.step, e.field]), [[1, 'material']]);
eq('플라즈마 시간 문자 → invalid', cust({ steps: [S('PlasmaCleaning (In-situ)', 'Ar', 'abc'), S('Sputter', 'Ti', '10')], sampleCount: 1 }).errors.map((e) => [e.step, e.field]), [[1, 'value']]);
eq('영문 문구', estimateForCustomer({ form: { locale: 'en', steps: [S('Sputter', 'Pt', 'x')], sampleCount: 1 }, priceDb: DB, computeQuote: fakeEngine, formatUsd: () => '', usdRate: 1, today: '2026-01-01' }).customer.errors[0].message,
  'Enter the thickness for step 1 as a number.');

// 고객 응답에 금지 필드·ID 없음 (여러 사례 모두)
{
  const ids = [...RECIPES.flatMap((r) => [r.recipe_id, r.equipment_id]), ...SUBSTRATES.map((s) => s.catalog_id)];
  const all = [
    cust({ steps: [S('Sputter', 'Ti', '10')], sampleCount: 1 }),
    buy('Sapphire', '4inch').customer, buy('Silicon', '6inch', 'Prime').customer,
    cust({ steps: [S('ALD', 'Al2O3', '10')], measurements: ['XPS'], sampleCount: 12 }),
    cust({ steps: [S('Sputter', 'Pt', 'x')], sampleCount: 0 }),
  ];
  const keys = new Set();
  (function walk(o) { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { keys.add(k); walk(v); } })(all);
  eq('금지 키 0건', FORBIDDEN_CUSTOMER_KEYS.filter((k) => keys.has(k)), []);
  const text = JSON.stringify(all);
  eq('ID 문자열 0건', ids.filter((id) => text.includes(id)), []);
}
eq('표기: Al2O3 → Al₂O₃', prettyFormula('Al2O3'), 'Al₂O₃');
eq('날짜 더하기(월 넘김)', addDays('2026-01-25', 14), '2026-02-08');

// ── 담당자 확인 사유: 구조화 항목 · 고객 문구 · 담당자 문구 ──────────────────
{
  const r = est({ steps: [S('Sputter', 'Ti', '10'), S('Annealing', 'N2', '60'), S('ALD', 'Al2O3', '10')], measurements: ['XPS'], sampleCount: 12 });
  eq('debug.manual 은 구조화 항목(중복 없음)', r.debug.manual, [
    { code: 'samples' },
    { code: 'step', step: 2, process: 'Annealing', material: 'N2', reason: 'noPrice' },
    { code: 'step', step: 3, process: 'ALD', material: 'Al2O3', reason: 'chooseEquipment' },
    { code: 'measure', name: 'XPS' },
  ]);
  eq('customer.manual 은 고객 문구(지금과 같음)', r.customer.manual, ['샘플 수량 10개 이상', '2단계 Annealing N₂', '3단계 ALD Al₂O₃', '분석: XPS']);
  const inv = est({ steps: [S('Sputter', 'Pt', 'x')], sampleCount: 1 });
  eq('invalid 이면 debug.errors 도 남김', inv.debug.errors.map((e) => [e.step, e.field]), [[1, 'value']]);
}
const SUBE = { code: 'substrate', type: 'Silicon', size: '4inch', grade: 'Prime', status: 'none' };
eq('manualLabel ko', [
  manualLabel({ code: 'samples' }, 'ko'), manualLabel({ code: 'step', step: 1, process: 'ALD', material: 'Al2O3', reason: 'chooseEquipment' }, 'ko'),
  manualLabel({ code: 'measure', name: 'XPS' }, 'ko'), manualLabel({ ...SUBE, size: '6inch' }, 'ko'), manualLabel({ code: 'pricing', engineStatus: 'X' }, 'ko'),
], ['샘플 수량 10개 이상', '1단계 ALD Al₂O₃', '분석: XPS', '기판: Silicon 6 inch Prime', '가격 자료 확인']);
eq('manualLabel en', [
  manualLabel({ code: 'samples' }, 'en'), manualLabel({ code: 'step', step: 1, process: 'ALD', material: 'Al2O3', reason: 'chooseEquipment' }, 'en'),
  manualLabel({ code: 'measure', name: 'XPS' }, 'en'), manualLabel({ ...SUBE, size: '6inch' }, 'en'), manualLabel({ code: 'pricing', engineStatus: 'X' }, 'en'),
], ['10 or more samples', 'Step 1 ALD Al₂O₃', 'Analysis: XPS', 'Substrate: Silicon 6 inch Prime', 'Pricing data review']);
eq('manualLabel input ko/en', [
  manualLabel({ code: 'input', step: 2, field: 'value' }, 'ko'), manualLabel({ code: 'input', field: 'sampleCount' }, 'ko'),
  manualLabel({ code: 'input', field: 'substrateGrade' }, 'ko'), manualLabel({ code: 'input', field: 'process' }, 'ko'),
  manualLabel({ code: 'input', step: 2, field: 'value' }, 'en'), manualLabel({ code: 'input', field: 'sampleCount' }, 'en'),
  manualLabel({ code: 'input', field: 'substrateGrade' }, 'en'), manualLabel({ code: 'input', field: 'process' }, 'en'),
], ['2단계 입력 확인', '샘플 수량 확인', '기판 등급 확인', '입력 확인',
  'Check the input for step 2', 'Check the number of samples', 'Check the substrate grade', 'Check your input']);
{
  const reasons = [{ code: 'step', step: 1, process: 'ALD', material: 'Al2O3', reason: 'chooseEquipment' }, { ...SUBE, status: 'ambiguous' }, { code: 'pricing', engineStatus: '공정 입력 확인' }];
  const txt = ['ko', 'en'].flatMap((l) => reasons.map((e) => manualLabel(e, l))).join(' ');
  eq('고객 문구에 사유 없음', ['장비 선택', 'ambiguous', '원가', '공정 입력 확인', 'chooseEquipment'].filter((w) => txt.includes(w)), []);
}
eq('manualLabelAdmin', [
  manualLabelAdmin({ code: 'step', step: 1, process: 'ALD', material: 'Al2O3', reason: 'chooseEquipment' }),
  manualLabelAdmin({ code: 'measure', name: 'XPS' }),
  manualLabelAdmin(SUBE),
  manualLabelAdmin({ ...SUBE, status: 'ambiguous' }),
  manualLabelAdmin({ code: 'pricing', engineStatus: '공정 입력 확인' }),
  manualLabelAdmin({ code: 'samples' }),
  manualLabelAdmin({ code: 'input', step: 3, field: 'value' }),
  manualLabelAdmin({ code: 'input', step: 3, field: 'material' }),
  manualLabelAdmin({ code: 'input', step: 3, field: 'process' }),
  manualLabelAdmin({ code: 'input', field: 'sampleCount' }),
  manualLabelAdmin({ code: 'input', field: 'substrateGrade' }),
], ['1단계 ALD Al₂O₃ — 장비 선택 필요', '분석: XPS — 가격 자료 없음', '기판: Silicon 4 inch Prime — 목록에 없음',
  '기판: Silicon 4 inch Prime — 같은 사양 원가가 다름', '가격 자료 확인 — 엔진 상태: 공정 입력 확인', '샘플 수량 10개 이상',
  '3단계 입력 확인(두께·시간)', '3단계 입력 확인(물질)', '3단계 입력 확인(공정)', '샘플 수량 확인', '기판 등급 확인']);

// ── 큰 견적: 품목 16개↑·층 101개↑ → 던지지 않고 담당자 확인('size') ─────────────
{
  // 서로 다른 가짜 장비(EQ-SP1 Ti · EQ-SP2 Cr)를 번갈아 → 단계마다 새 품목
  const alt = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? S('Sputter', 'Cr', '1') : S('Sputter', 'Ti', '1')));
  const same = (n) => Array.from({ length: n }, () => S('Sputter', 'Ti', '1'));
  const e = new QuoteMapError('too_many_items', 'x', { count: 16, max: 15 });
  eq('QuoteMapError.name · detail', [e.name, e.detail, new QuoteMapError('c', 'm').detail], ['QuoteMapError', { count: 16, max: 15 }, null]);
  let err = null;
  try { run(alt(16)); } catch (x) { err = x; }
  eq('변환 자체는 여전히 던진다(detail 포함)', [err?.code, err?.detail], ['too_many_items', { count: 16, max: 15 }]);

  const r16 = est({ steps: alt(16), sampleCount: 1 });
  eq('16품목 → manual size items', [r16.customer.kind, r16.debug.manual, r16.debug.input],
    ['manual', [{ code: 'size', what: 'items', count: 16, max: 15 }], null]);
  eq('16품목 → 고객 문구', r16.customer.manual, ['공정 단계가 많아 담당자가 직접 계산합니다']);
  const r101 = est({ steps: same(101), sampleCount: 1 });
  eq('101층 → manual size layers', [r101.customer.kind, r101.debug.manual], ['manual', [{ code: 'size', what: 'layers', count: 101, max: 100 }]]);
  eq('15품목 → estimate', est({ steps: alt(15), sampleCount: 1 }).customer.kind, 'estimate');
  eq('100층 → estimate', est({ steps: same(100), sampleCount: 1 }).customer.kind, 'estimate');
  eq('size 와 다른 사유는 함께', est({ steps: alt(16), sampleCount: SAMPLE_MANUAL_MIN }).debug.manual.map((m) => m.code), ['samples', 'size']);

  const details = { v: 1, sampleCount: '1', delivery: 'direct', seq: alt(16), measures: [] };
  let auto = null, autoErr = null;
  try { auto = buildAutoRevision({ details, locale: 'ko', priceDb: DB, computeQuote: fakeEngine, today: '2026-01-10', info: {} }); } catch (x) { autoErr = x?.name; }
  eq('buildAutoRevision 16품목 → 던지지 않고 manual · input null', [autoErr, auto?.kind, auto?.input, auto?.manual],
    [null, 'manual', null, [{ code: 'size', what: 'items', count: 16, max: 15 }]]);

  eq('size 문구(고객 ko·en)', [manualLabel({ code: 'size', what: 'items', count: 16, max: 15 }, 'ko'), manualLabel({ code: 'size', what: 'layers', count: 101, max: 100 }, 'en')],
    ['공정 단계가 많아 담당자가 직접 계산합니다', 'Many process steps — our team will calculate this quote']);
  eq('size 문구(담당자)', [manualLabelAdmin({ code: 'size', what: 'items', count: 16, max: 15 }), manualLabelAdmin({ code: 'size', what: 'layers', count: 101, max: 100 })],
    ['자동 계산 한도 초과 — 품목 16개(최대 15) · 편집기에서 품목을 묶어 입력', '자동 계산 한도 초과 — 층 101개(최대 100) · 편집기에서 품목을 묶어 입력']);
  eq('입력 오류는 앞 30개까지', [MAX_FORM_ERRORS, cust({ steps: Array.from({ length: 40 }, () => S('Sputter', 'Ti', 'x')), sampleCount: 1 }).errors.length], [30, 30]);
}
eq('등급 상수는 quote-fields 단일 출처', [GRADES === SUBSTRATE_GRADES, GRADED_TYPES === GRADED_SUBSTRATES], [true, true]);

if (failed) {
  console.error(`\n견적 변환·고객 판정 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 견적 변환(quote-map)·고객 판정(quote-customer) — ${total}건 통과`);
