// scripts/test-quote-engine.mjs — 견적 계산 엔진(src/lib/quote-engine.js) 단위 테스트.
//
// ⚠️ 이 파일의 숫자는 **전부 가짜**다. 실제 원가·요율은 GitHub 공개 저장소에 들어가면 안 되므로
//    1000·2000 처럼 딱 떨어지는 값만 쓴다. 실제 엑셀 값으로 하는 재현 검증은
//    저장소 밖(~/vanam-data/test-excel-cases.mjs)에 있다.
//
// 기대값은 모두 손계산 과정을 주석으로 남긴다 — 숫자만 있으면
// 나중에 "엔진이 바뀐 건지 기대값이 틀린 건지" 알 수 없다.
//
// ⚠️ 가짜 값은 실제 DB 값과 **겹치지 않게** 골랐다. 우연히 같은 숫자가 들어가면
//    "이게 실제 단가인가?" 를 나중에 판별할 수 없다. 겹치지 않음은 원가 데이터를
//    다루는 로컬 검사(~/vanam-data/)에서 전수 대조한다.
//    구조상 실제와 같을 수밖에 없는 값만 예외로 둔다:
//      material_charge_basis_nm 100 · film_rounding_unit 1000
//        → 정책 이름 TIER_100NM / FLOOR_1000 이 이미 못 박은 값이고, 그 이름은 엔진 소스에 있다.
//      default_tax_rate 0.1 → 법정 부가세율(공개값). ROUND 0.5 경계 시험의 유일한 레버이기도 하다.
//
// 가짜 DB 의 고정 상수:
//   기준두께 100nm · 1구간 한도 4000/정액 6000 · 2구간 한도 9000/정액 13000 · 절삭 1000원 · 세율 0.1
//   마진 기본 1.5 · 연구소 0.25 · 특수 4
//   레시피 기본: 재료원가 35원/nm · 증착속도 8nm/min
//   EQ-A: 요율 1000 · 로딩 9 · 플라즈마 4 · 셋업 0
//   EQ-B: 요율 2000 · 로딩 11 · 플라즈마 0 · 셋업 6 (ALD)
//   EQ-C: 요율 1000 · 로딩 22 · 플라즈마 4 · 셋업 13
//   EQ-F: 요율 1000 · 로딩 21 · 플라즈마 0 · 셋업 0
import { computeQuote, koreanAmount } from '../src/lib/quote-engine.js';

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

const EQ = (equipment_id, process_type, rate_per_min, l, p, s, active = true) =>
  ({ equipment_id, equipment_name: equipment_id, process_type, rate_per_min,
    default_loading_min: l, default_plasma_min: p, default_setup_min: s, active });

const EQUIPMENT = [
  EQ('EQ-A', 'Sputter', 1000, 9, 4, 0),
  EQ('EQ-B', 'ALD', 2000, 11, 0, 6),
  EQ('EQ-C', 'Sputter', 1000, 22, 4, 13),
  EQ('EQ-F', 'Sputter', 1000, 21, 0, 0),
  EQ('EQ-EVAP', 'Evaporation', 1000, 9, 0, 0),
  EQ('EQ-OFF', 'Sputter', 1000, 9, 0, 0, false),
  EQ('EQ-NORATE', 'Sputter', null, 9, 0, 0),
  EQ('EQ-BADTIME', 'Sputter', 1000, null, 0, 0),
  EQ('EQ-MISMATCH', 'ALD', 1000, 9, 0, 0),    // 레시피는 Sputter 라고 말한다
  EQ('EQ-DUP', 'Sputter', 1000, 9, 0, 0),
  EQ('EQ-DUP', 'Sputter', 1000, 9, 0, 0),     // 중복 등록
];

const R = (recipe_id, material_name, process_type, equipment_id, over = {}) => ({
  recipe_id, material_name, process_type, equipment_id, method: 'DC Power',
  material_cost_per_nm: 35, growth_nm_per_min: 8, default_temp_c: null,
  loading_override_min: null, plasma_override_min: null, setup_override_min: null,
  legacy_min_charge: 2000, active: true, ...over,
});

const RECIPES = [
  R('R-T1', 'MatA', 'Sputter', 'EQ-A'),                                  // 원가/nm 35  → 기준 3500  → 1구간
  R('R-T2', 'MatB', 'Sputter', 'EQ-A', { material_cost_per_nm: 70 }),    // 기준 7000  → 2구간
  R('R-T3', 'MatC', 'Sputter', 'EQ-A', { material_cost_per_nm: 120 }),   // 기준 12000 → 구간 초과
  R('R-ZERO', 'MatZ', 'Sputter', 'EQ-A', { material_cost_per_nm: 0 }),   // 기준 0     → 0원
  R('R-ALD', 'MatD', 'ALD', 'EQ-B', { method: 'Ozone', default_temp_c: 180 }),
  R('R-RT', 'MatE', 'Sputter', 'EQ-A', { default_temp_c: 30 }),          // 30 → R.T 로 읽는다
  R('R-EVAP', 'MatG', 'Evaporation', 'EQ-EVAP', { method: 'Thermal' }),  // Sputter/ALD 아님 → 규격에 방법 표기
  R('R-C', 'MatH', 'Sputter', 'EQ-C'),
  R('R-OV', 'MatJ', 'Sputter', 'EQ-C',
    { loading_override_min: 0, plasma_override_min: 0, setup_override_min: 0 }), // 레시피 override 0
  R('R-F', 'MatI', 'Sputter', 'EQ-F', { material_cost_per_nm: 110, growth_nm_per_min: 0.9 }),
  R('R-OFF', 'MatK', 'Sputter', 'EQ-A', { active: false }),
  R('R-EQOFF', 'MatL', 'Sputter', 'EQ-OFF'),
  R('R-MISMATCH', 'MatM', 'Sputter', 'EQ-MISMATCH'),
  R('R-NOCOST', 'MatN', 'Sputter', 'EQ-A', { material_cost_per_nm: null }),
  R('R-NOGROWTH', 'MatO', 'Sputter', 'EQ-A', { growth_nm_per_min: null }),
  R('R-NORATE', 'MatP', 'Sputter', 'EQ-NORATE'),
  R('R-BADTIME', 'MatQ', 'Sputter', 'EQ-BADTIME'),
  R('R-NOEQ', 'MatR', 'Sputter', 'EQ-MISSING'),                          // 장비DB 에 없는 장비
  R('R-DUPEQ', 'MatT', 'Sputter', 'EQ-DUP'),                             // 장비가 2줄
  R('R-DUP', 'MatS', 'Sputter', 'EQ-A'),
  R('R-DUP', 'MatS', 'Sputter', 'EQ-A'),                                 // 레시피 자체가 2줄
];

const SUB = (catalog_id, cost_per_unit, active = true) =>
  ({ catalog_id, item_name: catalog_id, category: 'WAFER', unit: '장', cost_per_unit, active });
const SUBSTRATES = [
  SUB('SUB-1', 1100), SUB('SUB-OFF', 1100, false), SUB('SUB-NEG', -1100),
  SUB('SUB-NOCOST', null), SUB('SUB-DUP', 1100), SUB('SUB-DUP', 1100),
];

const DB = { policy: POLICY, recipes: RECIPES, equipment: EQUIPMENT, substrates: SUBSTRATES };
/** 정책만 바꾼 DB 사본. @param {[string, unknown][]} changes @param {string[]} [drop] */
const dbWith = (changes, drop = []) => ({
  ...DB,
  policy: [...POLICY.filter((p) => !drop.includes(p.key) && !changes.some(([k]) => k === p.key)),
    ...changes.map(([key, value]) => ({ key, value }))],
});

// ── 테스트 틀 ──────────────────────────────────────────────────────────────
let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) { failed++; console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`); }
}

const film = (over = {}) => ({ no: 1, name: '테스트', method: '박막자동', qty: 1, unit: '회', vat: '별도', margin: '기본', plasma: 'N', ...over });
const direct = (over = {}) => ({ no: 1, name: '테스트', method: '단가입력', qty: 1, unit: '개', vat: '별도', ...over });
const L = (over = {}) => ({ itemNo: 1, order: 1, repeat: 1, ...over });

/** 품목 1개 + 층들을 계산한다. */
const calc = (item, layers = [], db = DB) => computeQuote(db, { items: [item], layers });
/** 단가 하나만 뽑는다. */
const price = (item, layers = [], db = DB) => calc(item, layers, db).items[0].unitPrice;
/** 품목 검증 결과 */
const istat = (item, layers = [], db = DB) => calc(item, layers, db).items[0].status;
/** 층 검증 결과(n번째) */
const lstat = (layers, item = film(), n = 0, db = DB) => calc(item, layers, db).layers[n].status;

// ═══ 4-3 재료비 구간 ═══════════════════════════════════════════════════════
// 공통(EQ-A, 100nm, growth 8, plasma N, 로딩·셋업 비움, 마진 기본 1.5):
//   증착시간 = 100/8 = 12.5분 → 증착장비비 = 12.5 × 1000 = 12,500
//   공정시간비 = (로딩 9 + 셋업 0 + 플라즈마 0 + 대기 0) × 1000 = 9,000
console.log('4-3 재료비 구간');
// 원가/nm 35 → 기준두께 원가 3,500 ≤ 1구간 한도 4,000 → 구간단가 6,000 × 구간수 1 = 6,000
// 원가 = 6,000 + 12,500 + 9,000 = 27,500 → ×(1+1.5) = 68,750 → 천원 절삭 68,000
eq('1구간', price(film(), [L({ recipeId: 'R-T1', thicknessNm: 100 })]), 68000);
// 원가/nm 70 → 기준 7,000 (4,000 초과 · 2구간 한도 9,000 이하) → 구간단가 13,000
// 원가 = 13,000 + 12,500 + 9,000 = 34,500 → ×2.5 = 86,250 → 86,000
eq('2구간', price(film(), [L({ recipeId: 'R-T2', thicknessNm: 100 })]), 86000);
// 원가/nm 120 → 기준 12,000 > 9,000 → 구간단가 = 기준두께 원가 12,000
// 원가 = 12,000 + 12,500 + 9,000 = 33,500 → ×2.5 = 83,750 → 83,000
eq('구간 초과', price(film(), [L({ recipeId: 'R-T3', thicknessNm: 100 })]), 83000);
// 원가/nm 0 → 기준 0 → 구간단가 0 → 재료비 0
// 원가 = 0 + 12,500 + 9,000 = 21,500 → ×2.5 = 53,750 → 53,000
eq('재료비 0원', price(film(), [L({ recipeId: 'R-ZERO', thicknessNm: 100 })]), 53000);

console.log('4-3 100nm 경계');
// 100nm: 구간수 CEILING(100/100)=1 → 재료비 6,000 → 원가 27,500 → 68,000
eq('100nm', price(film(), [L({ recipeId: 'R-T1', thicknessNm: 100 })]), 68000);
// 101nm: 구간수 CEILING(101/100)=2 → 재료비 6,000×2 = 12,000
//        증착 101/8 = 12.625분 → 12,625 / 공정시간비 9,000
//        원가 = 12,000 + 12,625 + 9,000 = 33,625 → ×2.5 = 84,062.5 → 천원 절삭 84,000
eq('101nm', price(film(), [L({ recipeId: 'R-T1', thicknessNm: 101 })]), 84000);

console.log('4-3 층 반복');
// 반복 3: 재료비 6,000×1×3 = 18,000 / 증착 100/8×3 = 37.5분 → 37,500 / 공정시간비 9,000(1회)
// 원가 = 18,000 + 37,500 + 9,000 = 64,500 → ×2.5 = 161,250 → 161,000
eq('층 반복 3', price(film(), [L({ recipeId: 'R-T1', thicknessNm: 100, repeat: 3 })]), 161000);

console.log('4-5 같은 장비 다층 — 로딩은 1회만');
// R-T1 + R-T2 둘 다 EQ-A: 재료비 6,000+13,000 = 19,000 / 증착비 12,500+12,500 = 25,000
// 로딩은 MAX(9,9) = 9 → 공정시간비 9,000 (층마다 더하지 않는다)
// 원가 = 19,000 + 25,000 + 9,000 = 53,000 → ×2.5 = 132,500 → 132,000
eq('다층 로딩 1회', price(film(), [
  L({ order: 1, recipeId: 'R-T1', thicknessNm: 100 }),
  L({ order: 2, recipeId: 'R-T2', thicknessNm: 100 }),
]), 132000);

// ═══ 4-5 플라즈마 ══════════════════════════════════════════════════════════
console.log('4-5 플라즈마 N/Y/분 지정/비움');
// N: 입력이 있든 없든 0분 → (9+0+0+0)×1000 = 9,000 → 원가 27,500 → 68,000
eq('플라즈마 N', price(film({ plasma: 'N' }), [L({ recipeId: 'R-T1', thicknessNm: 100 })]), 68000);
// Y + 분 비움: 층별 기본 플라즈마 MAX = 4 → (9+0+4+0)×1000 = 13,000
//   원가 = 6,000 + 12,500 + 13,000 = 31,500 → ×2.5 = 78,750 → 78,000
eq('플라즈마 Y 비움', price(film({ plasma: 'Y' }), [L({ recipeId: 'R-T1', thicknessNm: 100 })]), 78000);
// Y + 8분: (9+0+8+0)×1000 = 17,000 → 원가 = 6,000+12,500+17,000 = 35,500 → ×2.5 = 88,750 → 88,000
eq('플라즈마 Y 8분', price(film({ plasma: 'Y', plasmaMin: 8 }), [L({ recipeId: 'R-T1', thicknessNm: 100 })]), 88000);
// Y + 0분: 0 을 넣으면 0분 (비움과 다르다) → N 과 같은 68,000
eq('플라즈마 Y 0분', price(film({ plasma: 'Y', plasmaMin: 0 }), [L({ recipeId: 'R-T1', thicknessNm: 100 })]), 68000);

console.log('4-5 로딩·셋업 0 과 비움의 차이');
// EQ-C 기본: 로딩 22 · 셋업 13. 둘 다 비움 → (22+13+0+0)×1000 = 35,000
//   원가 = 6,000 + 12,500 + 35,000 = 53,500 → ×2.5 = 133,750 → 133,000
eq('로딩·셋업 비움', price(film(), [L({ recipeId: 'R-C', thicknessNm: 100 })]), 133000);
// 셋업 0 만 지정 → (22+0+0+0)×1000 = 22,000
//   원가 = 6,000 + 12,500 + 22,000 = 40,500 → ×2.5 = 101,250 → 101,000
eq('셋업 0', price(film({ setupMin: 0 }), [L({ recipeId: 'R-C', thicknessNm: 100 })]), 101000);
// 로딩 0 + 셋업 0 → 공정시간비 0 → 원가 = 6,000 + 12,500 = 18,500 → ×2.5 = 46,250 → 46,000
eq('로딩 0 + 셋업 0', price(film({ loadingMin: 0, setupMin: 0 }), [L({ recipeId: 'R-C', thicknessNm: 100 })]), 46000);
// 레시피 override 0 (R-OV) 은 장비 기본값(로딩 22·셋업 13)을 덮는다 → 0 → 46,000
eq('레시피 override 0', price(film(), [L({ recipeId: 'R-OV', thicknessNm: 100 })]), 46000);
// 대기 6분: (9+0+0+6)×1000 = 15,000 → 원가 = 6,000+12,500+15,000 = 33,500 → ×2.5 = 83,750 → 83,000
eq('대기 6분', price(film({ waitMin: 6 }), [L({ recipeId: 'R-T1', thicknessNm: 100 })]), 83000);

console.log('4-5 기판원가');
// SUB-1 낱장 1,100 × 3장 = 3,300 → 원가 27,500+3,300 = 30,800 → ×2.5 = 77,000
eq('기판 3장', price(film({ substrateId: 'SUB-1', substratePerRun: 3 }),
  [L({ recipeId: 'R-T1', thicknessNm: 100 })]), 77000);
eq('기판 없음', calc(film(), [L({ recipeId: 'R-T1', thicknessNm: 100 })]).items[0].breakdown.substrateCost, 0);

console.log('4-5 마진 4종 · 천원 절삭');
const l1 = [L({ recipeId: 'R-T1', thicknessNm: 100 })]; // 원가 27,500
eq('기본 150%', price(film({ margin: '기본' }), l1), 68000);                        // 27,500×2.5 = 68,750
eq('연구소 25%', price(film({ margin: '연구소_대학_할인' }), l1), 34000);            // 27,500×1.25 = 34,375
eq('특수물질 400%', price(film({ margin: '특수물질' }), l1), 137000);                // 27,500×5 = 137,500
eq('직접입력 0', price(film({ margin: '직접입력', directMarkup: 0 }), l1), 27000);   // 27,500×1 = 27,500
// 직접입력 35%: 27,500 × 1.35 = 37,125 → 천원 절삭 → 37,000
eq('직접입력 35% + 천원 절삭', price(film({ margin: '직접입력', directMarkup: 0.35 }), l1), 37000);

console.log('4-7 부동소수 오차 제거(fix)');
// R-F: 원가/nm 110 → 기준 11,000 > 9,000 → 구간단가 11,000 / 구간수 CEILING(40/100)=1 → 재료비 11,000
// 증착 40/0.9 = 44.444…분 × 1000 = 44,444.444444444445
// EQ-F 로딩 21 · 플라즈마 0 · 셋업 0 → 공정시간비 21 × 1000 = 21,000
// 원가 = 11,000 + 44,444.444444444445 + 21,000 = 76,444.44444444444  (JS 부동소수)
// 직접입력 마진 3.5 → 가산 267,555.5555555555 → 절삭 전 단가 = 343,999.99999999994
//   fix 없이 FLOOR 하면 343,000 이 된다. fix(…)=344,000 → 344,000 이 맞다.
eq('절삭 전 343999.99999999994 → 344000',
  price(film({ margin: '직접입력', directMarkup: 3.5 }), [L({ recipeId: 'R-F', thicknessNm: 40 })]), 344000);

// ═══ 4-5 직접 금액 · 부가세 ════════════════════════════════════════════════
console.log('4-5 단가입력 · 총액입력 · 부가세 별도/포함');
const m = (item, layers = []) => { const i = calc(item, layers).items[0]; return [i.unitPrice, i.supply, i.vat, i.total]; };
// 단가입력 40,000 · 1개 · 별도 → 단가 40,000 / 공급가 40,000 / 세액 4,000 / 합계 44,000
eq('단가입력 별도 1개', m(direct({ amount: 40000 })), [40000, 40000, 4000, 44000]);
// 단가입력 40,000 · 3개 → 공급가 120,000 / 세액 12,000
eq('단가입력 별도 3개', m(direct({ amount: 40000, qty: 3 })), [40000, 120000, 12000, 132000]);
// 총액입력 120,000 · 3개 → 단가 = 120,000/3 = 40,000
eq('총액입력 별도 3개', m(direct({ method: '총액입력', amount: 120000, qty: 3 })), [40000, 120000, 12000, 132000]);
// 단가입력 1,000 · 1개 · 포함 → 단가 1,000/1.1 = 909.0909…
//   공급가 = ROUND(909.09) = 909 / 세액 = ROUND(1,000×1) − 909 = 91 / 합계 = 1,000 (입력 총액 보존)
eq('단가입력 포함 1개', m(direct({ amount: 1000, vat: '포함' })), [1000 / 1.1, 909, 91, 1000]);
// 총액입력 1,000 · 2개 · 포함 → 단가 = (1,000/1.1)/2 = 454.5454…
//   공급가 = ROUND(909.09) = 909 / 세액 = ROUND(1,000×1) − 909 = 91 (총액입력은 수량을 곱하지 않는다)
eq('총액입력 포함 2개', m(direct({ method: '총액입력', amount: 1000, qty: 2, vat: '포함' })), [(1000 / 1.1) / 2, 909, 91, 1000]);
// 금액 0 → 전부 0 (0 은 비움이 아니다)
eq('단가입력 0원', m(direct({ amount: 0 })), [0, 0, 0, 0]);
// 박막자동은 항상 부가세 별도: 원가 27,500 → ×2.5 = 68,750 → 단가 68,000 / 세액 6,800 / 합계 74,800
eq('박막자동 별도', m(film(), l1), [68000, 68000, 6800, 74800]);

console.log('4-7 ROUND 0.5 경계 (0에서 먼 쪽)');
// 단가 5 · 1개 · 별도 → 공급가 5 / 세액 = ROUND(5×0.1) = ROUND(0.5) = 1 (은행가 반올림이면 0)
eq('ROUND(0.5)=1', m(direct({ amount: 5 })), [5, 5, 1, 6]);
// 세액 = ROUND(1.5) = 2
eq('ROUND(1.5)=2', m(direct({ amount: 15 })), [15, 15, 2, 17]);
// 세액 = ROUND(2.5) = 3 (은행가 반올림이면 2)
eq('ROUND(2.5)=3', m(direct({ amount: 25 })), [25, 25, 3, 28]);

// ═══ 4-3 · 4-5 규격 문구 ═══════════════════════════════════════════════════
console.log('4-3 층 규격 문구');
const lspec = (layer) => calc(film(), [L(layer)]).layers[0].spec;
// Sputter 는 방법(DC Power)을 붙이지 않는다
eq('Sputter 규격', lspec({ recipeId: 'R-T1', thicknessNm: 100 }), 'MatA 100 nm');
// ALD 도 방법을 붙이지 않는다. 레시피 기본 온도 180 → " / 180°C"
eq('ALD 규격', lspec({ recipeId: 'R-ALD', thicknessNm: 100 }), 'MatD 100 nm / 180°C');
// Sputter/ALD 가 아니면 방법을 괄호로 붙인다
eq('기타 공정 규격', lspec({ recipeId: 'R-EVAP', thicknessNm: 100 }), 'MatG 100 nm (Thermal)');
// 레시피 기본 온도 30 → R.T
eq('30°C → R.T', lspec({ recipeId: 'R-RT', thicknessNm: 100 }), 'MatE 100 nm / R.T');
// 표시 온도를 넣으면 레시피 기본값을 덮는다
eq('표시 온도 우선', lspec({ recipeId: 'R-ALD', thicknessNm: 100, tempC: 25 }), 'MatD 100 nm / 25°C');
// 반복 1 은 표기하지 않고, 2 이상만 붙인다
eq('반복 2 표기', lspec({ recipeId: 'R-T1', thicknessNm: 100, repeat: 2 }), 'MatA 100 nm × 2');

console.log('4-5 품목 규격 문구');
// 층 규격 + 플라즈마 + 대기 + 추가 규격을 줄바꿈으로 잇는다
eq('품목 규격 전체',
  calc(film({ plasma: 'Y', plasmaMin: 7, waitMin: 5, extraSpec: '메모' }),
    [L({ order: 1, recipeId: 'R-T1', thicknessNm: 100 }), L({ order: 2, recipeId: 'R-T2', thicknessNm: 100 })]).items[0].spec,
  'MatA 100 nm\nMatB 100 nm\nPlasma Cleaning: 7 min\nWaiting: 5 min\n메모');
// 플라즈마 0 · 대기 0 이면 줄을 넣지 않는다
eq('품목 규격 0분 생략', calc(film(), l1).items[0].spec, 'MatA 100 nm');
// 직접 금액 품목의 규격은 추가 규격 그대로
eq('직접 금액 규격', calc(direct({ amount: 1000, extraSpec: '샘플박스' })).items[0].spec, '샘플박스');

// ═══ 4-6 한글 금액 ═════════════════════════════════════════════════════════
console.log('4-6 한글 금액');
eq('0 → 영', koreanAmount(0), '영');
eq('110', koreanAmount(110), '일백일십');                 // 1 도 "일"을 붙인다
eq('9999', koreanAmount(9999), '구천구백구십구');
eq('30000', koreanAmount(30000), '삼만');                 // 원 묶음 0 → 생략
eq('1203300', koreanAmount(1203300), '일백이십만삼천삼백');
eq('100002200 (만 묶음 0)', koreanAmount(100002200), '일억이천이백');
eq('100000000 (억만 원 0)', koreanAmount(100000000), '일억');
eq('1000000010000 (억 묶음 0)', koreanAmount(1000000010000), '일조일만');
eq('1000000000000', koreanAmount(1000000000000), '일조');
// 견적 합계에도 같은 규칙이 붙는다 (원가 27,500 → 단가 68,000 → 합계 74,800)
eq('견적 합계 한글', calc(film(), l1).totalKorean, '칠만사천팔백');

// ═══ 4-1 가격 정책 상태 ════════════════════════════════════════════════════
console.log('4-1 가격 정책 상태');
const pstat = (changes, drop = []) => computeQuote(dbWith(changes, drop), { items: [], layers: [] }).policyStatus;
eq('정상', pstat([]), '정상');
eq('키 누락', pstat([], ['currency']), '정책 키 누락 또는 중복');
// 같은 키가 두 줄이면 INDEX/MATCH 가 첫 줄만 집어 조용히 틀린 값을 쓴다 → 막는다
eq('키 중복', computeQuote({ ...DB, policy: [...POLICY, { key: 'currency', value: 'KRW' }] },
  { items: [], layers: [] }).policyStatus, '정책 키 누락 또는 중복');
eq('세율 음수', pstat([['default_tax_rate', -0.1]]), '가격 정책 숫자 확인');
eq('마진 음수', pstat([['markup_default', -1]]), '가격 정책 숫자 확인');
eq('기준두께 0', pstat([['material_charge_basis_nm', 0]]), '가격 정책 숫자 확인');
eq('절삭 단위 0', pstat([['film_rounding_unit', 0]]), '가격 정책 숫자 확인');
eq('세율이 문자', pstat([['default_tax_rate', '0.1']]), '가격 정책 숫자 확인');
// 2구간 한도 3,000 < 1구간 한도 4,000 → 역전
eq('구간 순서 역전', pstat([['material_tier2_limit', 3000]]), '재료비 구간 순서 확인');
eq('직접가산 켜짐', pstat([['direct_price_markup_enabled', true]]), '지원하지 않는 가격 정책');
eq('절삭 규칙 다름', pstat([['film_unit_price_rounding', 'ROUND_1000']]), '지원하지 않는 가격 정책');
eq('통화 다름', pstat([['currency', 'USD']]), '지원하지 않는 가격 정책');
// 순서: 키 누락이 숫자 오류보다 먼저 (둘 다 틀렸을 때)
eq('첫 오류만 — 키 누락 우선', pstat([['film_rounding_unit', 0]], ['currency']), '정책 키 누락 또는 중복');
// 정책이 깨지면 층·품목이 계산을 멈춘다
const badPol = dbWith([['currency', 'USD']]);
eq('정책 깨짐 → 층', lstat([L({ recipeId: 'R-T1', thicknessNm: 100 })], film(), 0, badPol), '가격 정책 확인');
eq('정책 깨짐 → 품목', istat(film(), [L({ recipeId: 'R-T1', thicknessNm: 100 })], badPol), '가격 정책 확인');
eq('정책 깨짐 → 금액 차단', calc(film(), [L({ recipeId: 'R-T1', thicknessNm: 100 })], badPol).total, null);

// ═══ 4-2 층 검증 문구 ══════════════════════════════════════════════════════
console.log('4-2 층 검증');
const ok = { recipeId: 'R-T1', thicknessNm: 100 };
eq('빈 행 → 빈 상태', lstat([{}]), '');
eq('품목 번호 16', lstat([L({ ...ok, itemNo: 16 })]), '품목 번호는 1~15 정수');
eq('품목 번호 0', lstat([L({ ...ok, itemNo: 0 })]), '품목 번호는 1~15 정수');
eq('품목 번호 1.5', lstat([L({ ...ok, itemNo: 1.5 })]), '품목 번호는 1~15 정수');
eq('층 순서 0', lstat([L({ ...ok, order: 0 })]), '층 순서: 양의 정수 필요');
eq('층 순서 문자', lstat([L({ ...ok, order: 'x' })]), '층 순서: 양의 정수 필요');
eq('층 순서 1.5', lstat([L({ ...ok, order: 1.5 })]), '층 순서: 정수 필요');
eq('층 순서 중복', lstat([L({ ...ok, order: 1 }), L({ recipeId: 'R-T2', thicknessNm: 100, order: 1 })]), '같은 품목의 층 순서 중복');
eq('레시피 비움', lstat([L({ thicknessNm: 100 })]), '레시피 ID 필요');
eq('미등록 레시피', lstat([L({ ...ok, recipeId: 'R-NONE' })]), '등록되지 않은 레시피');
eq('레시피 중복', lstat([L({ ...ok, recipeId: 'R-DUP' })]), '레시피 ID 중복');
eq('두께 0', lstat([L({ ...ok, thicknessNm: 0 })]), '두께: 양수 필요');
eq('두께 비움', lstat([L({ recipeId: 'R-T1', order: 1, repeat: 1, itemNo: 1 })]), '두께: 양수 필요');
eq('층 반복 0', lstat([L({ ...ok, repeat: 0 })]), '층 반복: 양의 정수 필요');
eq('층 반복 1.5', lstat([L({ ...ok, repeat: 1.5 })]), '층 반복: 정수 필요');
eq('표시 온도 문자', lstat([L({ ...ok, tempC: 'abc' })]), '표시 온도: 숫자 필요');
eq('품목이 박막자동 아님', lstat([L(ok)], direct({ amount: 1000 })), '해당 품목이 박막자동 아님');
eq('품목 번호가 가리키는 품목 없음', lstat([L({ ...ok, itemNo: 5 })]), '해당 품목이 박막자동 아님');
eq('품명 비어 있음', lstat([L(ok)], film({ name: '' })), '해당 견적 품명이 비어 있음');
eq('사용 중지 레시피', lstat([L({ ...ok, recipeId: 'R-OFF' })]), '사용 중지 레시피');
eq('장비 ID 누락', lstat([L({ ...ok, recipeId: 'R-NOEQ' })]), '장비 ID 누락 또는 중복');
eq('장비 ID 중복', lstat([L({ ...ok, recipeId: 'R-DUPEQ' })]), '장비 ID 누락 또는 중복');
eq('사용 중지 장비', lstat([L({ ...ok, recipeId: 'R-EQOFF' })]), '사용 중지 장비');
eq('공정 불일치', lstat([L({ ...ok, recipeId: 'R-MISMATCH' })]), '레시피와 장비 공정 불일치');
eq('재료 원가 비움', lstat([L({ ...ok, recipeId: 'R-NOCOST' })]), '재료 원가 확인 필요');
eq('증착속도 비움', lstat([L({ ...ok, recipeId: 'R-NOGROWTH' })]), '증착속도 확인 필요');
eq('장비요율 비움', lstat([L({ ...ok, recipeId: 'R-NORATE' })]), '장비요율 확인 필요');
eq('장비 기본시간 비움', lstat([L({ ...ok, recipeId: 'R-BADTIME' })]), '장비 기본시간 확인 필요');
eq('정상', lstat([L(ok)]), '정상');
// 여러 오류가 겹치면 첫 번째만
eq('첫 오류만 — 품목번호 > 층순서', lstat([L({ ...ok, itemNo: 16, order: 0, recipeId: null })]), '품목 번호는 1~15 정수');
eq('첫 오류만 — 층순서 > 두께', lstat([L({ ...ok, order: 0, thicknessNm: 0 })]), '층 순서: 양의 정수 필요');
eq('첫 오류만 — 레시피 > 두께', lstat([L({ recipeId: 'R-NONE', thicknessNm: 0, itemNo: 1, order: 1, repeat: 1 })]), '등록되지 않은 레시피');

// ═══ 4-4 품목 검증 문구 ════════════════════════════════════════════════════
console.log('4-4 품목 검증 — 공통');
eq('빈 행 → 빈 상태', istat({ no: 1 }), '');
eq('번호 16', istat(film({ no: 16 }), [L({ ...ok, itemNo: 16 })]), '품목 번호 변경 금지');
eq('번호 0', istat(film({ no: 0 }), [L({ ...ok, itemNo: 0 })]), '품목 번호 변경 금지');
eq('번호 1.5', istat(film({ no: 1.5 })), '품목 번호 변경 금지');
eq('번호 중복', computeQuote(DB, { items: [film({ no: 1 }), film({ no: 1 })], layers: [] }).items[0].status, '품목 번호 변경 금지');
eq('품명 필요', istat(film({ name: '' }), [L(ok)]), '품명 필요');
eq('가격 방식 확인', istat(film({ method: 'X' })), '가격 방식 확인');
eq('수량 0', istat(film({ qty: 0 }), [L(ok)]), '수량은 양수');
eq('수량 문자', istat(film({ qty: 'x' }), [L(ok)]), '수량은 양수');
eq('단위 필요', istat(film({ unit: '' }), [L(ok)]), '단위 필요');
eq('부가세 기준 확인', istat(film({ vat: 'X' }), [L(ok)]), '부가세 기준 확인');
eq('부가세율 확인 필요', istat(film(), [L(ok)], dbWith([], ['default_tax_rate'])), '부가세율 확인 필요');
eq('첫 오류만 — 품명 > 수량', istat(film({ name: '', qty: 0 }), [L(ok)]), '품명 필요');
eq('첫 오류만 — 가격방식 > 수량', istat(film({ method: 'X', qty: 0 })), '가격 방식 확인');

console.log('4-4 품목 검증 — 박막자동');
eq('단위는 회', istat(film({ unit: '개' }), [L(ok)]), '박막 수량 단위는 회');
eq('횟수는 정수', istat(film({ qty: 1.5 }), [L(ok)]), '박막 횟수는 정수');
eq('부가세 별도만', istat(film({ vat: '포함' }), [L(ok)]), '박막자동은 부가세 별도 계산');
eq('입력 금액 비우기', istat(film({ amount: 1000 }), [L(ok)]), '박막자동 입력 금액은 비워주세요');
eq('입력 금액 0 도 금지', istat(film({ amount: 0 }), [L(ok)]), '박막자동 입력 금액은 비워주세요');
eq('박막공정 입력 필요', istat(film(), []), '박막공정 입력 필요');
eq('박막공정 오류 확인', istat(film(), [L({ ...ok, thicknessNm: 0 })]), '박막공정 오류 확인');
eq('서로 다른 장비', istat(film(), [L({ order: 1, recipeId: 'R-T1', thicknessNm: 100 }), L({ order: 2, recipeId: 'R-ALD', thicknessNm: 100 })]), '서로 다른 장비는 품목을 나누세요');
eq('마진 비움', istat(film({ margin: null }), [L(ok)]), '마진 구분/직접 가산율 확인');
eq('마진 알 수 없는 값', istat(film({ margin: 'X' }), [L(ok)]), '마진 구분/직접 가산율 확인');
eq('직접입력인데 가산율 비움', istat(film({ margin: '직접입력' }), [L(ok)]), '마진 구분/직접 가산율 확인');
eq('가산율 음수', istat(film({ margin: '직접입력', directMarkup: -1 }), [L(ok)]), '마진 구분/직접 가산율 확인');
eq('직접입력 아닌데 가산율 입력', istat(film({ margin: '기본', directMarkup: 0.5 }), [L(ok)]), '직접 가산율은 직접입력 선택 시 사용');
eq('플라즈마 Y/N 확인 (비움)', istat(film({ plasma: null }), [L(ok)]), '플라즈마 Y/N 확인');
eq('플라즈마 Y/N 확인 (다른 값)', istat(film({ plasma: 'X' }), [L(ok)]), '플라즈마 Y/N 확인');
eq('플라즈마 N + 시간', istat(film({ plasma: 'N', plasmaMin: 5 }), [L(ok)]), '플라즈마 N인데 시간이 입력됨');
eq('플라즈마 N + 0분은 허용', istat(film({ plasma: 'N', plasmaMin: 0 }), [L(ok)]), '정상');
eq('로딩 문자', istat(film({ loadingMin: 'abc' }), [L(ok)]), '공정 시간은 0 이상 숫자');
eq('셋업 음수', istat(film({ setupMin: -1 }), [L(ok)]), '공정 시간은 0 이상 숫자');
eq('플라즈마 분 문자', istat(film({ plasma: 'Y', plasmaMin: 'abc' }), [L(ok)]), '공정 시간은 0 이상 숫자');
eq('대기 문자', istat(film({ waitMin: 'abc' }), [L(ok)]), '공정 시간은 0 이상 숫자');
eq('기판 ID 필요', istat(film({ substratePerRun: 3 }), [L(ok)]), '기판 ID 필요');
eq('기판 장수 0 은 ID 없이 허용', istat(film({ substratePerRun: 0 }), [L(ok)]), '정상');
eq('미등록 기판', istat(film({ substrateId: 'SUB-NONE', substratePerRun: 3 }), [L(ok)]), '기판 ID 누락 또는 중복');
eq('기판 중복', istat(film({ substrateId: 'SUB-DUP', substratePerRun: 3 }), [L(ok)]), '기판 ID 누락 또는 중복');
eq('기판 장수 0', istat(film({ substrateId: 'SUB-1', substratePerRun: 0 }), [L(ok)]), '기판 장수/회는 양수');
eq('기판 장수 비움', istat(film({ substrateId: 'SUB-1' }), [L(ok)]), '기판 장수/회는 양수');
eq('기판 장수 1.5', istat(film({ substrateId: 'SUB-1', substratePerRun: 1.5 }), [L(ok)]), '기판 장수는 정수');
eq('사용 중지 기판', istat(film({ substrateId: 'SUB-OFF', substratePerRun: 1 }), [L(ok)]), '사용 중지 기판');
eq('기판 원가 음수', istat(film({ substrateId: 'SUB-NEG', substratePerRun: 1 }), [L(ok)]), '기판 원가 확인 필요');
eq('기판 원가 비움', istat(film({ substrateId: 'SUB-NOCOST', substratePerRun: 1 }), [L(ok)]), '기판 원가 확인 필요');
eq('최소청구 정책', istat(film(), [L(ok)], dbWith([['minimum_charge_enabled', true]])), '최소청구 정책 확정 필요');
eq('재료비 정책', istat(film(), [L(ok)], dbWith([['material_pricing_policy', 'X']])), '재료비 정책 확인');
// 같은 장비(EQ-C)인데 층별 기본 로딩이 22(R-C)과 0(R-OV override)으로 다르다 → 사람이 골라야 한다
const twoC = [L({ order: 1, recipeId: 'R-C', thicknessNm: 100 }), L({ order: 2, recipeId: 'R-OV', thicknessNm: 100 })];
eq('다층 공통 로딩', istat(film(), twoC), '다층 공통 로딩 분을 지정하세요');
eq('다층 공통 셋업', istat(film({ loadingMin: 14 }), twoC), '다층 공통 셋업 분을 지정하세요');
eq('둘 다 지정하면 정상', istat(film({ loadingMin: 14, setupMin: 0 }), twoC), '정상');
// 재료비 6,000+6,000 = 12,000 / 증착 (100/8)+(100/8) = 25분 × 1000 = 25,000
// 공정시간비 (14+0+0+0)×1000 = 14,000 → 원가 = 12,000+25,000+14,000 = 51,000 → ×2.5 = 127,500 → 127,000
eq('다층 공통 지정 단가', price(film({ loadingMin: 14, setupMin: 0 }), twoC), 127000);
eq('박막자동 정상', istat(film(), [L(ok)]), '정상');
eq('첫 오류만 — 단위 > 부가세', istat(film({ unit: '개', vat: '포함' }), [L(ok)]), '박막 수량 단위는 회');
eq('첫 오류만 — 층 오류 > 마진', istat(film({ margin: null }), [L({ ...ok, thicknessNm: 0 })]), '박막공정 오류 확인');

console.log('4-4 품목 검증 — 단가입력 · 총액입력');
eq('금액 비움', istat(direct()), '입력 금액은 0 이상 숫자');
eq('금액 음수', istat(direct({ amount: -1 })), '입력 금액은 0 이상 숫자');
eq('금액 문자', istat(direct({ amount: 'abc' })), '입력 금액은 0 이상 숫자');
eq('금액 소수', istat(direct({ amount: 100.5 })), '입력 금액은 원 단위 정수');
for (const f of ['margin', 'directMarkup', 'plasma', 'plasmaMin', 'loadingMin', 'setupMin', 'waitMin', 'substrateId', 'substratePerRun']) {
  eq(`공정/마진 칸 비우기 (${f})`, istat(direct({ amount: 1000, [f]: f === 'plasma' ? 'N' : 0 })), '직접 금액 품목의 공정/마진 칸은 비워주세요');
}
eq('박막공정이 연결됨', istat(direct({ amount: 1000 }), [L(ok)]), '직접 금액 품목에 박막공정이 연결됨');
eq('단가입력 정상', istat(direct({ amount: 1000 })), '정상');
eq('총액입력 정상', istat(direct({ method: '총액입력', amount: 1000 })), '정상');

// ═══ 4-6 견적 상태·합계 ════════════════════════════════════════════════════
console.log('4-6 견적 상태·합계');
eq('품목 없음', computeQuote(DB, { items: [], layers: [] }).status, '입력 대기');
eq('빈 품목만', computeQuote(DB, { items: [{ no: 1 }], layers: [] }).status, '입력 대기');
eq('층 오류', calc(film(), [L({ ...ok, thicknessNm: 0 })]).status, '공정 입력 확인');
eq('품목 오류', calc(film({ qty: 0 }), [L(ok)]).status, '품목 입력 확인');
// 층 오류가 품목 오류보다 먼저 보고된다
eq('층 오류 우선', calc(film({ qty: 0 }), [L({ ...ok, thicknessNm: 0 })]).status, '공정 입력 확인');
eq('정상', calc(film(), [L(ok)]).status, '정상');
// 오류가 있으면 금액을 전부 비운다(엑셀처럼 출력 차단)
const errRes = calc(film({ qty: 0 }), [L(ok)]);
eq('오류 시 금액 차단', [errRes.supply, errRes.vat, errRes.total, errRes.totalKorean], [null, null, null, null]);
// 두 품목 합계: 박막자동 68,000 + 단가입력 40,000 = 공급가 108,000 / 세액 10,800 / 합계 118,800
const two = computeQuote(DB, {
  items: [film({ no: 1 }), direct({ no: 2, amount: 40000 })],
  layers: [L({ itemNo: 1, recipeId: 'R-T1', thicknessNm: 100 })],
});
eq('두 품목 합계', [two.status, two.supply, two.vat, two.total, two.totalKorean],
  ['정상', 108000, 10800, 118800, '일십일만팔천팔백']);

// ═══ breakdown (V3_계산 I~W) ═══════════════════════════════════════════════
console.log('breakdown — V3_계산 I~W 열');
// R-T1 100nm, 기판 SUB-1 3장, 플라즈마 Y 7분, 대기 5분, 마진 기본
//   재료비 6,000 / 증착 12.5분 · 12,500 / 로딩 9 · 셋업 0 · 플라즈마 7 · 대기 5 / 요율 1,000
//   기판 1,100×3 = 3,300 → 원가 = 6,000+12,500+(9+0+7+5)×1,000+3,300 = 42,800
//   가산 42,800×1.5 = 64,200 → 절삭 전 107,000
eq('breakdown', calc(film({ plasma: 'Y', plasmaMin: 7, waitMin: 5, substrateId: 'SUB-1', substratePerRun: 3 }),
  [L({ recipeId: 'R-T1', thicknessNm: 100 })]).items[0].breakdown, {
  layerCount: 1, equipmentId: 'EQ-A', materialCost: 6000, depositMin: 12.5, depositCost: 12500,
  loadingMin: 9, setupMin: 0, plasmaMin: 7, waitMin: 5, ratePerMin: 1000, substrateCost: 3300,
  cost: 42800, markup: 1.5, markupAmount: 64200, priceBeforeFloor: 107000,
});

// ── 결과 ───────────────────────────────────────────────────────────────────
if (failed) {
  console.error(`\n견적 엔진 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`\n✓ 견적 엔진 — ${total}건 통과`);
