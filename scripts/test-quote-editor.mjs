// scripts/test-quote-editor.mjs — 관리자 견적 편집 화면의 입력 모델(src/lib/quote-editor.js) 테스트
//
// 핵심: 화면이 바뀌어도 계산은 엑셀(엔진) 그대로다.
//   ① 카드 → 표(items·layers) 변환이 예전 표 화면과 같은 값을 만든다(번호·칸 변환·빈 줄).
//   ② 저장된 입력 → 카드 → 다시 표 로 돌려도 엔진 결과(상태·금액·규격)가 같다.
// ⚠️ 가격 DB 는 전부 가짜 값이다(test-quote-engine.mjs 와 같은 원칙 — 실제 원가·ID 를 쓰지 않는다).
import { readFileSync } from 'node:fs';
import { computeQuote } from '../src/lib/quote-engine.js';
import {
  conv, newCard, newLayer, isBlankCard, inputFromCards, cardsFromInput, equipmentOptions, recipeOptions, substrateOptions,
  clearForeignRecipes, problemsOf, fieldForItemStatus, fieldForLayerStatus, isPolicyStatus,
  ITEM_STATUS_FIELD, LAYER_STATUS_FIELD, STATUS_HINT, POLICY_STATUSES, METHOD_VALUES, MARGINS, MAX_ITEMS,
} from '../src/lib/quote-editor.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}

// ── 가짜 가격 DB ───────────────────────────────────────────────────────────
const POLICY = [
  ['default_tax_rate', 0.1], ['markup_default', 1.5], ['markup_research', 0.25], ['markup_special', 4],
  ['material_pricing_policy', 'TIER_100NM'], ['material_charge_basis_nm', 100],
  ['material_tier1_limit', 4000], ['material_tier1_amount', 6000],
  ['material_tier2_limit', 9000], ['material_tier2_amount', 13000],
  ['film_rounding_unit', 1000], ['direct_price_markup_enabled', false],
  ['direct_price_rounding', 'PRESERVE_ENTERED_AMOUNT'], ['film_unit_price_rounding', 'FLOOR_1000'],
  ['minimum_charge_enabled', false], ['currency', 'KRW'],
].map(([key, value]) => ({ key, value }));
const EQ = (equipment_id, equipment_name, process_type, rate_per_min, l, p, s, active = true) =>
  ({ equipment_id, equipment_name, process_type, rate_per_min, default_loading_min: l, default_plasma_min: p, default_setup_min: s, active });
const EQUIPMENT = [
  EQ('EQ-A', '스퍼터 가', 'Sputter', 1000, 9, 4, 0),
  EQ('EQ-B', 'ALD 나', 'ALD', 2000, 11, 0, 6),
  EQ('EQ-C', '스퍼터 다', 'Sputter', 1000, 22, 4, 13),
];
const R = (recipe_id, material_name, process_type, equipment_id, over = {}) => ({
  recipe_id, material_name, process_type, equipment_id, method: 'DC Power',
  material_cost_per_nm: 35, growth_nm_per_min: 8, default_temp_c: null,
  loading_override_min: null, plasma_override_min: null, setup_override_min: null,
  legacy_min_charge: 2000, active: true, ...over,
});
const RECIPES = [
  R('R-A1', 'MatA', 'Sputter', 'EQ-A'),
  R('R-A2', 'MatB', 'Sputter', 'EQ-A', { material_cost_per_nm: 70 }),
  R('R-B1', 'MatD', 'ALD', 'EQ-B', { method: 'Ozone', default_temp_c: 180 }),
  R('R-C1', 'MatH', 'Sputter', 'EQ-C'),
  R('R-C2', 'MatJ', 'Sputter', 'EQ-C', { loading_override_min: 30 }),
];
const SUBSTRATES = [{ catalog_id: 'SUB-1', item_name: '가짜 기판', category: 'WAFER', unit: '장', cost_per_unit: 1100, active: true }];
const DB = { policy: POLICY, recipes: RECIPES, equipment: EQUIPMENT, substrates: SUBSTRATES };

// 엔진 결과 비교용 — 화면에 쓰는 값만(상태·금액·규격)
const view = (r) => ({
  status: r.status, supply: r.supply, vat: r.vat, total: r.total,
  items: r.items.filter((x) => x.status !== '').map((x) => [x.status, x.unitPrice, x.supply, x.vat, x.total, x.spec]),
});

// 예전 표 화면이 보내던 모양의 입력(번호 = 줄 순서, 칸 순서 = 엑셀 열 순서)
const ITEM = (no, o) => ({ no, name: null, extraSpec: null, method: null, qty: null, unit: null, amount: null, vat: null, margin: null,
  directMarkup: null, plasma: null, plasmaMin: null, loadingMin: null, setupMin: null, waitMin: null, substrateId: null,
  substratePerRun: null, rawText: null, ...o });
const FILM = (no, o = {}) => ITEM(no, { name: `박막 ${no}`, method: '박막자동', qty: 1, unit: '회', vat: '별도', margin: '기본', plasma: 'N', ...o });
const LAYER = (itemNo, order, recipeId, thicknessNm, o = {}) => ({ itemNo, order, recipeId, thicknessNm, repeat: 1, tempC: null, ...o });

// ── conv — 예전 화면과 같은 변환 ────────────────────────────────────────────────
eq('conv: 빈칸·공백 → null', [conv(''), conv('  '), conv(null), conv(undefined)], [null, null, null, null]);
eq('conv: 숫자', [conv('0'), conv('1,000'), conv('1.5'), conv('-3'), conv(' 12 '), conv('.5'), conv(7)], [0, 1000, 1.5, -3, 12, 0.5, 7]);
eq('conv: 숫자 아닌 글자는 그대로(앞뒤 공백 포함)', [conv('abc'), conv(' 식 '), conv('1,00'), conv('1e3'), conv('R-A1')], ['abc', ' 식 ', '1,00', '1e3', 'R-A1']);

// ── 새 카드·빈 카드 ──────────────────────────────────────────────────────────
{
  const f = newCard('박막자동');
  const d = newCard('단가입력');
  eq('새 박막 카드: 빈 층 1줄 · 수량 1 · 마진 기본 · 플라즈마 N', [f.layers.length, f.qty, f.margin, f.plasma, f.vat], [1, '1', '기본', 'N', '별도']);
  eq('새 단가 카드: 층 없음 · 단위 식', [d.layers.length, d.unit], [0, '식']);
  eq('모르는 방식 → 박막', newCard('???').method, '박막자동');
  eq('열쇠는 서로 다르다', new Set([f.key, d.key, f.layers[0].key]).size, 3);
  eq('빈 카드 판정: 기본값만 → 빈 카드', [isBlankCard(f), isBlankCard(d)], [true, true]);
  eq('빈 카드 판정: 품명·금액·층 중 하나라도 있으면 아님', [
    isBlankCard({ ...f, name: 'x' }), isBlankCard({ ...d, amount: '0' }),
    isBlankCard({ ...f, layers: [newLayer({ recipeId: 'R-A1' })] }), isBlankCard({ ...f, layers: [newLayer({ thicknessNm: '10' })] }),
  ], [false, false, false, false]);
  eq('빈 카드 판정: 단가 카드의 숨은 층은 세지 않는다', isBlankCard({ ...d, layers: [newLayer({ recipeId: 'R-A1' })] }), true);
  eq('빈 카드 판정: 방식을 바꿔 숨은 칸 값은 세지 않는다(보내지 않으니까)', [
    isBlankCard({ ...d, loadingMin: '5', substrateId: 'SUB-1', directMarkup: '0.3' }), isBlankCard({ ...f, amount: '1000' }),
    isBlankCard({ ...f, margin: '기본', directMarkup: '0.3' }), isBlankCard({ ...f, plasma: 'N', plasmaMin: '5' }),
    isBlankCard({ ...f, margin: '직접입력', directMarkup: '0.3' }), isBlankCard({ ...f, plasma: 'Y', plasmaMin: '5' }),
  ], [true, true, true, true, false, false]);
  {
    // 빈 카드로 보는 카드는 엔진에 빈 줄로 간다 — 숨은 칸 값 때문에 '품명 필요'가 뜨지 않게
    const hidden = { ...d, loadingMin: '5' };
    eq('숨은 값만 있는 카드 → 빈 줄', computeQuote(DB, inputFromCards([hidden])).status, '입력 대기');
  }
}

// ── 카드 → 표 ────────────────────────────────────────────────────────────────
{
  const c1 = newCard('박막자동', { name: ' Sputter A ', qty: '2', margin: '직접입력', directMarkup: '0.3', plasma: 'Y', plasmaMin: '5',
    loadingMin: '', setupMin: '0', waitMin: '3', substrateId: 'SUB-1', substratePerRun: '4', extraSpec: '양면', rawText: '원문' });
  c1.layers = [newLayer({ recipeId: 'R-A1', thicknessNm: '10' }), newLayer(), newLayer({ recipeId: 'R-A2', thicknessNm: '1,000', repeat: '2', tempC: '30' })];
  const c2 = newCard('단가입력', { name: '분석', qty: '3', unit: 'pt', amount: '50,000', vat: '포함', extraSpec: 'XPS' });
  c2.layers = [newLayer({ recipeId: 'R-A1', thicknessNm: '5' })]; // 방식을 바꿔도 남아 있는 층 — 보내지 않는다
  const blankCard = newCard('박막자동');
  const c4 = newCard('박막자동', { name: '둘째 박막', margin: '기본', directMarkup: '0.9', plasma: 'N', plasmaMin: '7', substrateId: '', substratePerRun: '9' });
  c4.layers = [newLayer({ recipeId: 'R-B1', thicknessNm: '20' })];
  const { items, layers, layerRefs } = inputFromCards([c1, c2, blankCard, c4]);
  eq('번호 = 카드 순서', items.map((x) => x.no), [1, 2, 3, 4]);
  eq('칸 순서 = 엑셀 열 순서(예전 화면과 같다)', Object.keys(items[0]), Object.keys(ITEM(1, {})));
  eq('박막: 단위 회 · 부가세 별도 · 금액 비움 · 값 변환', [items[0].unit, items[0].vat, items[0].amount, items[0].qty, items[0].name, items[0].directMarkup,
    items[0].plasma, items[0].plasmaMin, items[0].loadingMin, items[0].setupMin, items[0].waitMin, items[0].substrateId, items[0].substratePerRun, items[0].rawText],
  ['회', '별도', null, 2, ' Sputter A ', 0.3, 'Y', 5, null, 0, 3, 'SUB-1', 4, '원문']);
  eq('단가: 공정·마진·기판 칸은 비워 보낸다', [items[1].method, items[1].unit, items[1].amount, items[1].vat, items[1].margin, items[1].plasma, items[1].substrateId,
    items[1].loadingMin, items[1].extraSpec], ['단가입력', 'pt', 50000, '포함', null, null, null, null, 'XPS']);
  eq('빈 카드 → 모든 칸 null(엔진이 건너뛰는 빈 줄)', Object.entries(items[2]).filter(([k, v]) => k !== 'no' && v !== null).length, 0);
  eq('박막: 마진 기본이면 직접 가산율 · 플라즈마 N 이면 분 · 기판 없으면 장수를 보내지 않는다',
    [items[3].directMarkup, items[3].plasma, items[3].plasmaMin, items[3].substrateId, items[3].substratePerRun], [null, 'N', null, null, null]);
  eq('층: 빈 줄은 빼고 순서 1부터 · 품목 번호 = 카드 번호 · 단가 카드의 층은 보내지 않는다',
    layers.map((l) => [l.itemNo, l.order, l.recipeId, l.thicknessNm, l.repeat, l.tempC]),
    [[1, 1, 'R-A1', 10, 1, null], [1, 2, 'R-A2', 1000, 2, 30], [4, 1, 'R-B1', 20, 1, null]]);
  eq('층 칸 순서 = 엑셀 열 순서', Object.keys(layers[0]), ['itemNo', 'order', 'recipeId', 'thicknessNm', 'repeat', 'tempC']);
  eq('layerRefs = [카드 위치, 카드 안 층 위치](빈 줄 건너뜀)', layerRefs, [[0, 0], [0, 2], [3, 0]]);
  eq('빈 입력', inputFromCards([]), { items: [], layers: [], layerRefs: [] });
}

// ── 표 → 카드 ────────────────────────────────────────────────────────────────
{
  const input = {
    items: [FILM(1, { name: 'A', qty: 2 }), ITEM(2, {}), ITEM(3, { name: '박스', method: '단가입력', qty: 1, unit: 'BOX', amount: 40000, vat: '별도' }),
      FILM(4, { name: 'C', plasma: 'Y', plasmaMin: 6, substrateId: 'SUB-1', substratePerRun: 2 })],
    layers: [LAYER(1, 1, 'R-A1', 10), LAYER(4, 1, 'R-C1', 30), LAYER(1, 2, 'R-A2', 20, { repeat: 3 }), LAYER(9, 1, 'R-B1', 5), LAYER(3, 1, 'R-A1', 7)],
  };
  const { cards, orphans } = cardsFromInput(input, RECIPES);
  eq('빈 줄 품목은 카드로 만들지 않는다', cards.map((c) => [c.method, c.name]), [['박막자동', 'A'], ['단가입력', '박스'], ['박막자동', 'C']]);
  eq('층은 같은 번호의 박막 카드에(입력 순서 유지)', cards[0].layers.map((l) => [l.recipeId, l.thicknessNm, l.repeat]), [['R-A1', '10', '1'], ['R-A2', '20', '3']]);
  eq('카드 장비 = 첫 층 레시피의 장비', cards.map((c) => c.equipmentId), ['EQ-A', '', 'EQ-C']);
  eq('붙을 곳 없는 층(없는 번호·단가 품목) → orphans', orphans, [{ itemNo: 9, recipeId: 'R-B1', thicknessNm: '5' }, { itemNo: 3, recipeId: 'R-A1', thicknessNm: '7' }]);
  eq('박막 카드 값', [cards[2].plasma, cards[2].plasmaMin, cards[2].substrateId, cards[2].substratePerRun, cards[2].qty], ['Y', '6', 'SUB-1', '2', '1']);
  eq('단가 카드 값', [cards[1].unit, cards[1].amount, cards[1].vat, cards[1].layers.length], ['BOX', '40000', '별도', 0]);
  // 다시 표로 — 카드 순서로 번호가 다시 매겨지고 층도 따라간다
  const back = inputFromCards(cards);
  eq('되돌린 번호·층 연결', [back.items.map((x) => [x.no, x.name]), back.layers.map((l) => [l.itemNo, l.order, l.recipeId])],
    [[[1, 'A'], [2, '박스'], [3, 'C']], [[1, 1, 'R-A1'], [1, 2, 'R-A2'], [3, 1, 'R-C1']]]);
  const empty = cardsFromInput(null, RECIPES);
  eq('입력 없음 → 카드 0', [empty.cards.length, empty.orphans.length], [0, 0]);
  eq('층 없는 박막 품목 → 빈 층 1줄', cardsFromInput({ items: [FILM(1)], layers: [] }).cards[0].layers.length, 1);
  eq('방식이 비었는데 층이 있으면 박막 · 없으면 단가', cardsFromInput({ items: [ITEM(1, { name: 'x' }), ITEM(2, { name: 'y' })], layers: [LAYER(1, 1, 'R-A1', 1)] }, RECIPES)
    .cards.map((c) => c.method), ['박막자동', '단가입력']);
  eq('같은 번호가 둘이면 층은 앞 카드에(엔진과 같다)', cardsFromInput({ items: [FILM(1, { name: 'a' }), FILM(1, { name: 'b' })], layers: [LAYER(1, 1, 'R-A1', 1)] }, RECIPES)
    .cards.map((c) => c.layers.filter((l) => l.recipeId).length), [1, 0]);
  eq(`품목은 ${MAX_ITEMS}개까지`, cardsFromInput({ items: Array.from({ length: 20 }, (_, i) => FILM(i + 1)), layers: [] }).cards.length, MAX_ITEMS);
  eq('가격 DB 에 없는 레시피만 있으면 장비 비움', cardsFromInput({ items: [FILM(1)], layers: [LAYER(1, 1, 'R-NONE', 1)] }, RECIPES).cards[0].equipmentId, '');
}

// ── 엔진 결과가 같다(저장된 입력 → 카드 → 다시 표) ───────────────────────────────
{
  const cases = {
    '박막 1품목 + 박스(예시 불러오기와 같은 모양)': {
      items: [FILM(1, { name: 'MatA 20nm 증착', qty: 2 }), ITEM(2, { name: '샘플박스', method: '단가입력', qty: 1, unit: 'BOX', amount: 40000, vat: '별도' })],
      layers: [LAYER(1, 1, 'R-A1', 20)],
    },
    '자동 견적 모양(두 장비 → 두 품목, 기판 첫 품목)': {
      items: [FILM(1, { name: 'Sputter MatA/MatB', qty: 1, substrateId: 'SUB-1', substratePerRun: 5 }), FILM(2, { name: 'ALD MatD', plasma: 'Y', plasmaMin: 3 })],
      layers: [LAYER(1, 1, 'R-A1', 10), LAYER(1, 2, 'R-A2', 50), LAYER(2, 1, 'R-B1', 20)],
    },
    '층이 품목 사이에 섞여 들어온 입력(품목 안 순서만 유지하면 같다)': {
      items: [FILM(1, { name: 'a' }), FILM(2, { name: 'b' })],
      layers: [LAYER(1, 1, 'R-A1', 10), LAYER(2, 1, 'R-C1', 30), LAYER(1, 2, 'R-A2', 20)],
    },
    '층 순서 번호가 입력 순서와 다름(규격은 입력 순서)': {
      items: [FILM(1, { name: 'a' })],
      layers: [LAYER(1, 5, 'R-A2', 20), LAYER(1, 2, 'R-A1', 10)],
    },
    '마진·반복·온도·시간 조정': {
      items: [FILM(1, { name: 'a', margin: '직접입력', directMarkup: 0.75, loadingMin: 0, setupMin: 4, waitMin: 10, qty: 3 }),
        FILM(2, { name: 'b', margin: '연구소_대학_할인' }), FILM(3, { name: 'c', margin: '특수물질', plasma: 'Y' })],
      layers: [LAYER(1, 1, 'R-A1', 150, { repeat: 2, tempC: 200 }), LAYER(2, 1, 'R-B1', 33), LAYER(3, 1, 'R-C1', 12), LAYER(3, 2, 'R-C2', 12)],
    },
    '총액 입력 · 부가세 포함 · 단가 입력 소수 수량': {
      items: [ITEM(1, { name: '분석', method: '총액입력', qty: 3, unit: 'pt', amount: 100000, vat: '포함' }),
        ITEM(2, { name: '기판', method: '단가입력', qty: 2.5, unit: '장', amount: 3333, vat: '포함' })],
      layers: [],
    },
    '오류 입력도 같은 오류(다층 공통 로딩 분)': {
      items: [FILM(1, { name: 'a' })],
      layers: [LAYER(1, 1, 'R-C1', 10), LAYER(1, 2, 'R-C2', 10)],
    },
    '오류 입력도 같은 오류(레시피 없음·두께 0)': {
      items: [FILM(1, { name: 'a' })],
      layers: [LAYER(1, 1, 'R-NONE', 10), LAYER(1, 2, 'R-A1', 0)],
    },
  };
  for (const [label, input] of Object.entries(cases)) {
    const before = computeQuote(DB, input);
    const after = computeQuote(DB, inputFromCards(cardsFromInput(input, RECIPES).cards));
    eq(`엔진 결과 같음 — ${label}`, view(after), view(before));
  }
  // 정상 사례는 정말 금액이 나오는지(비교가 둘 다 오류라서 같은 건 아닌지)
  eq('비교 사례 중 정상 5건', Object.values(cases).filter((x) => computeQuote(DB, x).status === '정상').length, 5);
}

// ── 화면이 고칠 수 없게 막는 조합(예전에 오류였던 것)은 엔진에 맞는 값으로 보낸다 ──────
{
  const c = newCard('박막자동', { name: 'a', unit: 'EA', amount: '999', vat: '포함' });
  c.layers = [newLayer({ recipeId: 'R-A1', thicknessNm: '10' })];
  const { items } = inputFromCards([c]);
  eq('박막 카드에 남은 단위·금액·부가세는 무시(회·비움·별도)', [items[0].unit, items[0].amount, items[0].vat], ['회', null, '별도']);
  eq('그 입력은 정상 계산', computeQuote(DB, inputFromCards([c])).status, '정상');
}

// ── 드롭다운 ─────────────────────────────────────────────────────────────────
{
  const eqs = equipmentOptions([...EQUIPMENT, EQ('EQ-Z', '레시피 없는 장비', 'Sputter', 1, 1, 1, 1), EQ('EQ-A', '중복', 'Sputter', 1, 1, 1, 1)],
    [...RECIPES, R('R-X', 'MatX', 'Sputter', 'EQ-MISSING')]);
  eq('장비: 레시피 있는 장비만 · 중복 ID 한 번 · 장비 표에 없는 장비도', eqs.map((o) => o.value), ['EQ-A', 'EQ-B', 'EQ-C', 'EQ-MISSING']);
  eq('장비 이름 = 이름 (공정)', eqs.map((o) => o.label), ['스퍼터 가 (Sputter)', 'ALD 나 (ALD)', '스퍼터 다 (Sputter)', 'EQ-MISSING (장비 정보 없음)']);
  const same = equipmentOptions([EQ('E1', '같은 이름', 'ALD', 1, 1, 1, 1), EQ('E2', '같은 이름', 'ALD', 1, 1, 1, 1, false)], [R('a', 'M', 'ALD', 'E1'), R('b', 'M', 'ALD', 'E2')]);
  eq('이름이 같으면 ID 를 붙인다 · 사용 중지 표시', same.map((o) => o.label), ['같은 이름 (ALD) · E1', '같은 이름 (ALD) · E2 — 사용 중지']);
  const ro = recipeOptions([...RECIPES, R('R-A3', 'MatA', 'Sputter', 'EQ-A'), R('R-A4', 'MatQ', 'Sputter', 'EQ-A', { active: 0 })], 'EQ-A');
  eq('레시피: 그 장비 것만 · 물질 · 방식 · 겹치면 ID · 사용 중지', ro.map((o) => o.label),
    ['MatA · DC Power (R-A1)', 'MatB · DC Power', 'MatA · DC Power (R-A3)', 'MatQ · DC Power — 사용 중지']);
  eq('레시피: 장비를 안 고르면 전부', recipeOptions(RECIPES).length, RECIPES.length);
  eq('active 값 읽기(1·true·"TRUE")', recipeOptions([R('a', 'M', 'S', 'E', { active: 1 }), R('b', 'M2', 'S', 'E', { active: 'TRUE' }), R('c', 'M3', 'S', 'E', { active: null })])
    .map((o) => o.active), [true, true, false]);
  eq('기판: 이름 · 겹치면 ID · 사용 중지 · 같은 ID 한 번', substrateOptions([...SUBSTRATES, { catalog_id: 'SUB-2', item_name: '가짜 기판', active: 0 },
    { catalog_id: 'SUB-1', item_name: '중복' }, { catalog_id: '', item_name: 'ID 없음' }]).map((o) => o.label),
  ['가짜 기판 · SUB-1', '가짜 기판 · SUB-2 — 사용 중지']);
  const card = newCard('박막자동', { equipmentId: 'EQ-C' });
  card.layers = [newLayer({ recipeId: 'R-A1' }), newLayer({ recipeId: 'R-C1' }), newLayer({ recipeId: '' }), newLayer({ recipeId: 'R-NONE' })];
  const n = clearForeignRecipes(card, new Map(RECIPES.map((r) => [r.recipe_id, r.equipment_id])));
  eq('장비를 바꾸면 다른 장비 레시피를 비운다(줄은 남김)', [n, card.layers.map((l) => l.recipeId)], [2, ['', 'R-C1', '', '']]);
}

// ── 계산 결과 → 확인할 곳 ─────────────────────────────────────────────────────
{
  const c1 = newCard('박막자동', { name: '' });
  c1.layers = [newLayer({ recipeId: 'R-A1', thicknessNm: '10' }), newLayer({ recipeId: '', thicknessNm: '5' })];
  const c2 = newCard('단가입력', { name: '박스', unit: '', amount: '100' });
  const c3 = newCard('박막자동', { name: 'ok' });
  c3.layers = [newLayer({ recipeId: 'R-A1', thicknessNm: '10' })];
  const inp = inputFromCards([c1, c2, c3]);
  const r = computeQuote(DB, inp);
  eq('엔진 상태(전제)', [r.status, r.items.map((x) => x.status), r.layers.map((x) => x.status)],
    ['공정 입력 확인', ['품명 필요', '단위 필요', '정상'], ['해당 견적 품명이 비어 있음', '레시피 ID 필요', '정상']]);
  eq('확인할 곳: 품명 문구 하나(층마다 붙는 같은 뜻은 뺌) · 층 오류 · 단위', problemsOf(r, inp.layerRefs),
    [{ card: 0, layer: null, status: '품명 필요' }, { card: 0, layer: 1, status: '레시피 ID 필요' }, { card: 1, layer: null, status: '단위 필요' }]);
  const c4 = newCard('박막자동', { name: 'x' });
  c4.layers = [newLayer({ recipeId: 'R-A1', thicknessNm: '-1' })];
  const i4 = inputFromCards([c4]);
  eq('층 오류만 있으면 품목의 "박막공정 오류 확인"은 빼고 층을 알린다', problemsOf(computeQuote(DB, i4), i4.layerRefs),
    [{ card: 0, layer: 0, status: '두께: 양수 필요' }]);
  const broken = computeQuote({ ...DB, policy: POLICY.filter((p) => p.key !== 'default_tax_rate') }, inputFromCards([c3]));
  eq('가격 정책 문제는 목록에 넣지 않는다(화면이 한 번만 알린다)', [broken.policyStatus !== '정상', problemsOf(broken, [[0, 0]])], [true, []]);
  eq('빈 결과', problemsOf(null, []), []);
}

// ── 상태 문구·값이 엔진 소스와 같다(오타로 칸 표시가 안 되는 일 방지) ──────────────
{
  const src = readFileSync(new URL('../src/lib/quote-engine.js', import.meta.url), 'utf8');
  const missing = [...Object.keys(ITEM_STATUS_FIELD), ...Object.keys(LAYER_STATUS_FIELD), ...Object.keys(STATUS_HINT), ...POLICY_STATUSES]
    .filter((s) => !src.includes(`'${s}'`));
  eq('상태 문구가 모두 엔진에 있다', missing, []);
  eq('가격 방식 값 = 엔진', METHOD_VALUES.every((m) => src.includes(`'${m}'`)), true);
  eq('마진 값 = 엔진', MARGINS.every((m) => src.includes(`'${m.value}'`)), true);
  eq('칸 찾기', [fieldForItemStatus('단위 필요'), fieldForItemStatus('정상'), fieldForItemStatus(''), fieldForLayerStatus('두께: 양수 필요'),
    fieldForLayerStatus('모름'), isPolicyStatus('가격 정책 확인'), isPolicyStatus('품명 필요')], ['unit', null, null, 'thicknessNm', null, true, false]);
}

if (failed) {
  console.error(`\n견적 편집 화면 모델(quote-editor) 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 견적 편집 화면 모델(quote-editor) — ${total}건 통과 · 저장된 입력 → 카드 → 표 의 엔진 결과 동일`);
