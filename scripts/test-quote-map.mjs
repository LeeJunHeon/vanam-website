// scripts/test-quote-map.mjs — 폼 입력 → 엑셀 형식 변환(src/lib/quote-map.js) 단위 테스트
//
// 가짜 레시피 목록으로 규칙만 본다(가격은 보지 않는다 — 금액은 엔진 테스트의 몫).
// 레시피 ID·장비 ID 는 실제 DB 와 겹치지 않는 가짜 이름이다.
import { mapFormToQuote, recipeCandidates, parseThickness, runsOf, conv, QuoteMapError, REASON } from '../src/lib/quote-map.js';

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
  R('T-ALD1-Al2O3', 'ALD', 'Al2O3', 'EQ-ALD1'),
  R('T-ALD2-Al2O3', 'ALD', 'Al2O3', 'EQ-ALD2'),           // 후보 2개
  R('T-ALD1-HfO2', 'ALD', 'HfO2', 'EQ-ALD1'),
  R('T-SP-Off', 'Sputter', 'Mo', 'EQ-SP1', 0),            // 사용 중지 → 후보 아님
];
const S = (process, material, value, extra = {}) => ({ process, material, value, unit: '', etc: '', ...extra });
const form = (steps, over = {}) => ({ steps, sampleCount: 1, delivery: 'direct', test: {}, ...over });
const run = (steps, over) => mapFormToQuote(form(steps, over), RECIPES);

// ── 후보 ────────────────────────────────────────────────────────────────────
const C = recipeCandidates(RECIPES);
eq('후보: Sputter Ti 1개', C['Sputter|Ti'].map((r) => r.recipe_id), ['T-SP-Ti']);
eq('후보: 괄호 뗀 AlN', C['Sputter|AlN'].map((r) => r.recipe_id), ['T-SP-AlN']);
eq('후보: ALD Al2O3 2개', C['ALD|Al2O3'].map((r) => r.recipe_id), ['T-ALD1-Al2O3', 'T-ALD2-Al2O3']);
eq('후보: 사용 중지 제외', C['Sputter|Mo'], undefined);
eq('후보: 원가 필드 없음', Object.keys(C['Sputter|Ti'][0]).sort(), ['equipment_id', 'material_name', 'method', 'recipe_id']);

// ── 단일 층 ─────────────────────────────────────────────────────────────────
{
  const m = run([S('Sputter', 'Pt', '45')], { sampleCount: 3 });
  eq('단일 층: 품목 1', m.items.length, 1);
  eq('단일 층: 품목 필드', [m.items[0].name, m.items[0].method, m.items[0].unit, m.items[0].vat, m.items[0].margin, m.items[0].plasma, m.items[0].qty],
    ['Sputter Pt', '박막자동', '회', '별도', '기본', 'N', 1]);
  eq('단일 층: 층', m.layers, [{ itemNo: 1, order: 1, recipeId: 'T-SP-Pt', thicknessNm: 45, repeat: 1, tempC: null }]);
  eq('단일 층: extras 없음', m.extras, []);
}

// ── 같은 장비 다층 ──────────────────────────────────────────────────────────
{
  const m = run([S('Sputter', 'Ti', '15'), S('Sputter', 'Pt', '45')]);
  eq('같은 장비 다층: 품목 1', m.items.length, 1);
  eq('같은 장비 다층: 이름', m.items[0].name, 'Sputter Ti/Pt');
  eq('같은 장비 다층: 층 순서', m.layers.map((l) => [l.itemNo, l.order, l.recipeId]), [[1, 1, 'T-SP-Ti'], [1, 2, 'T-SP-Pt']]);
}

// ── 장비 전환 분리 ──────────────────────────────────────────────────────────
{
  const m = run([S('Sputter', 'Ti', '10'), S('ALD', 'Al2O3', '20', { recipeId: 'T-ALD1-Al2O3' })]);
  eq('장비 전환: 품목 2', m.items.map((i) => i.name), ['Sputter Ti', 'ALD Al2O3']);
  eq('장비 전환: 층 품목 번호', m.layers.map((l) => [l.itemNo, l.order]), [[1, 1], [2, 1]]);
  const m2 = run([S('Sputter', 'Ti', '10'), S('Sputter', 'Cr', '10')]);
  eq('같은 공정 다른 장비도 분리', m2.items.length, 2);
}

// ── 플라즈마 부착 ───────────────────────────────────────────────────────────
{
  const m = run([S('PlasmaCleaning (In-situ)', 'Ar', '5'), S('Sputter', 'Ti', '10')]);
  eq('플라즈마: 다음 증착 품목에 Y 5분', [m.items[0].plasma, m.items[0].plasmaMin], ['Y', 5]);
  eq('플라즈마: 품목 수 1', m.items.length, 1);
  const m2 = run([S('Sputter', 'Ti', '10'), S('PlasmaCleaning (In-situ)', 'Ar', '5'), S('Sputter', 'Pt', '10')]);
  eq('플라즈마는 품목을 끊지 않는다', [m2.items.length, m2.items[0].plasma, m2.items[0].plasmaMin], [1, 'Y', 5]);
  const m3 = run([S('Sputter', 'Ti', '10'), S('PlasmaCleaning (In-situ)', 'Ar', '3')]);
  eq('뒤에 증착 없으면 직전 품목', [m3.items[0].plasma, m3.items[0].plasmaMin], ['Y', 3]);
  const m4 = run([S('PlasmaCleaning (In-situ)', 'Ar', '2'), S('PlasmaCleaning (In-situ)', 'O2', '3'), S('Sputter', 'Ti', '10')]);
  eq('플라즈마 두 단계는 더한다', m4.items[0].plasmaMin, 5);
  const m5 = run([S('PlasmaCleaning (In-situ)', 'Ar', 'abc'), S('Sputter', 'Ti', '10')]);
  eq('플라즈마 분이 숫자가 아니면 원문', m5.items[0].plasmaMin, 'abc');
  const m6 = run([S('Sputter', 'Ti', '10'), S('ALD', 'HfO2', '5'), S('PlasmaCleaning (In-situ)', 'Ar', '4'), S('Sputter', 'Pt', '5')]);
  eq('플라즈마는 바로 다음 증착의 품목에', m6.items.map((i) => [i.name, i.plasma, i.plasmaMin]),
    [['Sputter Ti', 'N', null], ['ALD HfO2', 'N', null], ['Sputter Pt', 'Y', 4]]);
}

// ── 어닐링 끊기 ─────────────────────────────────────────────────────────────
{
  const m = run([S('Sputter', 'Ti', '10'), S('Annealing', 'N2', '30'), S('Sputter', 'Pt', '10')]);
  eq('어닐링이 끼면 품목 분리', m.items.map((i) => i.name), ['Sputter Ti', 'Sputter Pt']);
  eq('어닐링은 extras', m.extras, [{ step: 2, process: 'Annealing', material: 'N2', reason: REASON.noPrice }]);
  const m2 = run([S('Sputter', 'Ti', '10'), S('Evaporator', 'Au', '45')], { measurements: ['XPS'] });
  eq('Evaporator·분석은 extras', m2.extras.map((e) => [e.process, e.reason]), [['Evaporator', REASON.noPrice], ['XPS', REASON.noPrice]]);
  const m3 = run([S('PlasmaTreatment (Ex-situ)', 'O2', '5'), S('Sputter', 'Ti', '10')]);
  eq('Ex-situ 플라즈마는 extras, 품목은 N', [m3.extras[0].reason, m3.items[0].plasma], [REASON.noPrice, 'N']);
}

// ── 후보 여러 개 미선택 · 레시피 없음 · 잘못된 선택 ─────────────────────────
{
  const m = run([S('ALD', 'Al2O3', '20')]);
  eq('후보 여럿 미선택 → 장비 선택 필요', [m.items.length, m.extras[0]?.reason], [0, REASON.chooseEquipment]);
  const m2 = run([S('Sputter', 'Ti', '10'), S('ALD', 'Al2O3', '20'), S('Sputter', 'Pt', '10')]);
  eq('미선택 단계도 품목을 끊는다', m2.items.map((i) => i.name), ['Sputter Ti', 'Sputter Pt']);
  const m3 = run([S('Sputter', 'Au', '10')]);
  eq('레시피 없음', m3.extras[0]?.reason, REASON.noRecipe);
  eq('사용 중지만 있으면 레시피 없음', run([S('Sputter', 'Mo', '10')]).extras[0]?.reason, REASON.noRecipe);
  eq('후보 밖 recipeId 거부', throwsCode(() => run([S('Sputter', 'Ti', '10', { recipeId: 'T-SP-Pt' })])), 'bad_recipe');
  eq('후보 1개여도 다른 recipeId 거부', throwsCode(() => run([S('ALD', 'HfO2', '5', { recipeId: 'NOPE' })])), 'bad_recipe');
}

// ── 회수 계산 ───────────────────────────────────────────────────────────────
eq('회수: 5 ÷ 2 = 3', runsOf({ sampleCount: 5, test: { perRun: 2 } }), 3);
eq('회수: 투입 장수 비움 → 1', runsOf({ sampleCount: 5, test: {} }), 1);
eq('회수: 직접 입력 우선', runsOf({ sampleCount: 5, test: { perRun: 2, runs: '4' } }), 4);
eq('회수: 모든 품목 같은 값', run([S('Sputter', 'Ti', '10'), S('ALD', 'HfO2', '5')], { sampleCount: 5, test: { perRun: 2 } }).items.map((i) => i.qty), [3, 3]);

// ── 기판 첫 품목만 ──────────────────────────────────────────────────────────
{
  const steps = [S('Sputter', 'Ti', '10'), S('ALD', 'HfO2', '5')];
  const m = run(steps, { delivery: 'purchase', sampleCount: 8, test: { substrateId: 'SUB-X', substratePerRun: 4 } });
  eq('기판: 첫 품목에만', m.items.map((i) => [i.substrateId, i.substratePerRun]), [['SUB-X', 4], [null, null]]);
  const m2 = run(steps, { delivery: 'purchase', sampleCount: 8, test: { substrateId: 'SUB-X', perRun: 2 } });
  eq('기판 장수 비움 → 투입 장수', m2.items[0].substratePerRun, 2);
  const m3 = run(steps, { delivery: 'purchase', sampleCount: 8, test: { substrateId: 'SUB-X' } });
  eq('투입 장수도 비움 → 샘플 수', m3.items[0].substratePerRun, 8);
  const m4 = run(steps, { delivery: 'courier', sampleCount: 8, test: { substrateId: 'SUB-X' } });
  eq('구매 요청이 아니면 기판 없음', m4.items[0].substrateId, null);
}

// ── 두께 문자열 파싱 · 층 필드 ──────────────────────────────────────────────
eq('두께: "1,000 nm"', parseThickness('1,000 nm'), 1000);
eq('두께: "45nm"', parseThickness('45nm'), 45);
eq('두께: "12.5"', parseThickness('12.5'), 12.5);
eq('두께: "100~200" 원문', parseThickness('100~200'), '100~200');
eq('두께: 빈칸 null', parseThickness(' '), null);
{
  const m = run([S('Sputter', 'Ti', '10', { repeat: '3', tempC: '200' })]);
  eq('층 반복·표시 온도', [m.layers[0].repeat, m.layers[0].tempC], [3, 200]);
}
eq('conv: 0 은 0', conv('0'), 0);
eq('conv: 쉼표', conv('40,000'), 40000);
eq('conv: 문자 원문', conv('abc'), 'abc');

// ── 테스트 입력 → 품목 필드 ─────────────────────────────────────────────────
{
  const m = run([S('Sputter', 'Ti', '10', { etc: '조건 A' }), S('Sputter', 'Pt', '10', { etc: '조건 B' })],
    { test: { margin: '직접입력', directMarkup: '0.5', loadingMin: '0', setupMin: '', waitMin: '3' } });
  const it = m.items[0];
  eq('테스트 입력 반영', [it.margin, it.directMarkup, it.loadingMin, it.setupMin, it.waitMin, it.extraSpec],
    ['직접입력', 0.5, 0, null, 3, '조건 A; 조건 B']);
}

// ── 한도 초과 ───────────────────────────────────────────────────────────────
{
  // 장비를 번갈아 16품목
  const many = Array.from({ length: 16 }, (_, i) => (i % 2 ? S('Sputter', 'Cr', '1') : S('Sputter', 'Ti', '1')));
  eq('품목 16개 거부', throwsCode(() => run(many)), 'too_many_items');
  const deep = Array.from({ length: 101 }, () => S('Sputter', 'Ti', '1'));
  eq('층 101개 거부', throwsCode(() => run(deep)), 'too_many_layers');
  eq('품목 15개는 허용', run(many.slice(0, 15)).items.length, 15);
}

if (failed) {
  console.error(`\n견적 변환(quote-map) 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 견적 변환(quote-map) — ${total}건 통과`);
