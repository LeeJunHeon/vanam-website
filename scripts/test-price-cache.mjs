// scripts/test-price-cache.mjs — 가격 DB 메모리 캐시(src/lib/price-cache.js) · 얼린 DB 로 계산 테스트
//
// ⚠️ 숫자는 전부 가짜다(test-quote-engine.mjs 와 같은 딱 떨어지는 값). 실제 원가·요율을 넣지 않는다.
//   1) 깊게 얼린 가짜 가격 DB 로 computeQuote · estimateForCustomer · buildAutoRevision 이
//      예외 없이 얼리지 않은 DB 와 같은 결과를 낸다(계산 코드가 가격 DB 를 고치지 않는다).
//   2) 캐시: 번호 같음 → 가격 표 조회 0번 / 번호 바뀜 → 다시 읽음 / 번호 없음 → 매번 읽음 (가짜 D1)
//   3) 배선: price-db.ts 의 loadPriceDbCached · 네 호출부가 캐시를 쓰고, 올리기 비교·지문은 쓰지 않는다.
import { readFileSync } from 'node:fs';
import { createPriceDbCache, deepFreeze } from '../src/lib/price-cache.js';
import { computeQuote } from '../src/lib/quote-engine.js';
import { estimateForCustomer } from '../src/lib/quote-customer.js';
import { buildAutoRevision, defaultDocInfo } from '../src/lib/quote-revision.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}

// ── 가짜 가격 DB ─────────────────────────────────────────────────────────────
const makeDb = () => ({
  policy: [
    ['default_tax_rate', 0.1], ['markup_default', 1.5], ['markup_research', 0.25], ['markup_special', 4],
    ['material_pricing_policy', 'TIER_100NM'], ['material_charge_basis_nm', 100],
    ['material_tier1_limit', 4000], ['material_tier1_amount', 6000],
    ['material_tier2_limit', 9000], ['material_tier2_amount', 13000],
    ['film_rounding_unit', 1000], ['direct_price_markup_enabled', false],
    ['direct_price_rounding', 'PRESERVE_ENTERED_AMOUNT'], ['film_unit_price_rounding', 'FLOOR_1000'],
    ['minimum_charge_enabled', false], ['currency', 'KRW'],
    ['quote_valid_days', 7], ['default_delivery_due', '계약 후 협의'],
  ].map(([key, value]) => ({ key, value })),
  equipment: [
    { equipment_id: 'EQ-SP1', equipment_name: 'EQ-SP1', process_type: 'Sputter', rate_per_min: 1000,
      default_loading_min: 9, default_plasma_min: 4, default_setup_min: 0, active: 1 },
    { equipment_id: 'EQ-ALD1', equipment_name: 'EQ-ALD1', process_type: 'ALD', rate_per_min: 2000,
      default_loading_min: 11, default_plasma_min: 0, default_setup_min: 6, active: 1 },
  ],
  recipes: [
    ['T-SP-Ti', 'Ti', 'Sputter', 'EQ-SP1'], ['T-SP-Pt', 'Pt', 'Sputter', 'EQ-SP1'], ['T-ALD1-Al2O3', 'Al2O3(X)', 'ALD', 'EQ-ALD1'],
  ].map(([recipe_id, material_name, process_type, equipment_id]) => ({
    recipe_id, material_name, process_type, equipment_id, method: process_type === 'ALD' ? 'Ozone' : 'DC Power',
    material_cost_per_nm: 35, growth_nm_per_min: 8, default_temp_c: null,
    loading_override_min: null, plasma_override_min: null, setup_override_min: null, legacy_min_charge: 2000, active: 1,
  })),
  substrates: [
    { catalog_id: 'FS-02', item_name: '4in Boron TEST bare', category: 'WAFER', unit: '장', cost_per_unit: 1100, size_inch: 4, oxide_nm: null, active: 1 },
  ],
});

// ── 1) 얼린 DB 로 계산 ───────────────────────────────────────────────────────
const plain = makeDb();
const frozen = deepFreeze(makeDb());
eq('deepFreeze: 겉·표 배열·행 객체 전부', [Object.isFrozen(frozen), Object.isFrozen(frozen.recipes), Object.isFrozen(frozen.recipes[0]),
  Object.isFrozen(frozen.policy.at(-1))], [true, true, true, true]);
eq('deepFreeze: 고치면 TypeError(strict)', (() => { try { frozen.recipes[0].material_cost_per_nm = 1; return 'no'; } catch (e) { return e.constructor.name; } })(), 'TypeError');
eq('deepFreeze: push 도 TypeError', (() => { try { frozen.policy.push({}); return 'no'; } catch (e) { return e.constructor.name; } })(), 'TypeError');

/** 예외는 결과로 바꿔 비교한다 */
const run = (f) => { try { return { ok: f() }; } catch (e) { return { threw: `${e.constructor.name}: ${e.message}` }; } };

const QUOTE = {
  items: [{ no: 1, name: '테스트', method: '박막자동', qty: 1, unit: '회', vat: '별도', margin: '기본', plasma: 'N' }],
  layers: [{ itemNo: 1, order: 1, repeat: 1, recipeId: 'T-SP-Ti', thicknessNm: 100 }],
};
const q0 = run(() => computeQuote(plain, QUOTE));
eq('computeQuote: 얼린 DB = 얼리지 않은 DB', run(() => computeQuote(frozen, QUOTE)), q0);
eq('computeQuote: 가짜 DB 로 정상 계산', q0.ok?.status, '정상');

const FORM = {
  locale: 'ko', delivery: 'purchase', substrateType: 'Silicon', substrateSize: '4inch', substrateGrade: 'Test', sampleCount: '3',
  steps: [{ process: 'Sputter', material: 'Ti', value: '10', unit: 'nm', etc: '' }, { process: 'ALD', material: 'Al2O3', value: '20', unit: 'nm', etc: '' }],
  measurements: [],
};
const est = (db) => estimateForCustomer({ form: FORM, priceDb: db, computeQuote, formatUsd: (k, r) => `$${(k / r).toFixed(2)}`, usdRate: 1000, today: '2026-01-10' });
const e0 = run(() => est(plain));
eq('estimateForCustomer: 얼린 DB = 얼리지 않은 DB', run(() => est(frozen)), e0);
eq('estimateForCustomer: 가짜 DB 로 예상 견적(기판 포함)', [e0.ok?.customer?.kind, e0.threw], ['estimate', undefined]);

const DETAILS = {
  v: 1, sampleCount: '3', delivery: 'purchase', substrateType: 'Silicon', substrateSize: '4inch', substrateGrade: 'Test',
  seq: FORM.steps, measures: [],
};
const auto = (db) => {
  const info = defaultDocInfo({ inquiry: { id: 'Q-TEST', name: '가', company: '나', productName: '다' }, policy: db.policy, today: '2026-01-10', contact: '000', locale: 'ko' });
  return buildAutoRevision({ details: DETAILS, locale: 'ko', priceDb: db, computeQuote, today: '2026-01-10', info });
};
const a0 = run(() => auto(plain));
eq('buildAutoRevision: 얼린 DB = 얼리지 않은 DB', run(() => auto(frozen)), a0);
eq('buildAutoRevision: 가짜 DB 로 estimate', [a0.ok?.kind, typeof a0.ok?.total], ['estimate', 'number']);
eq('계산 뒤 가짜 DB 불변', JSON.stringify(plain), JSON.stringify(makeDb()));

// ── 2) 캐시 · 가짜 D1 ────────────────────────────────────────────────────────
function fakeD1() {
  const st = { importId: null, tableReads: 0, idReads: 0, version: 1 };
  const d = {
    prepare(sql) {
      return {
        first: async () => {
          if (!/FROM price_import_log/.test(sql)) throw new Error(`예상 밖 first: ${sql}`);
          st.idReads++;
          return st.importId === null ? null : { id: st.importId };
        },
        all: async () => {
          if (!/FROM price_(policy|recipe|equipment|substrate)\b/.test(sql)) throw new Error(`예상 밖 all: ${sql}`);
          st.tableReads++;
          return { results: [{ v: st.version }] };
        },
      };
    },
  };
  return { d, st };
}
// price-db.ts 의 loadPriceDbCached 와 같은 모양(SQL 은 아래 3) 에서 원문 대조)
const wire = (cache, d) => cache({
  latestId: async () => (await d.prepare(`SELECT id FROM price_import_log ORDER BY id DESC LIMIT 1`).first())?.id ?? null,
  load: async () => ({
    policy: (await d.prepare('SELECT key FROM price_policy').all()).results,
    recipes: (await d.prepare('SELECT recipe_id FROM price_recipe').all()).results,
    equipment: (await d.prepare('SELECT equipment_id FROM price_equipment').all()).results,
    substrates: (await d.prepare('SELECT catalog_id FROM price_substrate').all()).results,
  }),
});
{
  const { d, st } = fakeD1();
  const cache = createPriceDbCache();

  st.importId = 5;
  const r1 = await wire(cache, d);
  eq('첫 요청 → 가격 표 4번 · 번호 1번', [st.tableReads, st.idReads], [4, 1]);
  eq('캐시 값은 깊게 얼어 있다', [Object.isFrozen(r1), Object.isFrozen(r1.policy), Object.isFrozen(r1.policy[0])], [true, true, true]);

  st.version = 2; // 손으로 고친 경우 — 번호가 같아 캐시가 모른다(주석대로)
  const r2 = await wire(cache, d);
  eq('번호 같음 → 가격 표 조회 0번 · 같은 객체', [st.tableReads, st.idReads, r2 === r1, r2.policy[0].v], [4, 2, true, 1]);

  st.importId = 6; // 올리기 apply · price:import
  const r3 = await wire(cache, d);
  eq('번호 바뀜 → 다시 읽음', [st.tableReads, r3 === r1, r3.policy[0].v], [8, false, 2]);
  await wire(cache, d);
  eq('바뀐 번호로 다시 → 조회 0번', st.tableReads, 8);

  st.importId = null; // 가져오기 기록 없음
  const r5 = await wire(cache, d);
  const r6 = await wire(cache, d);
  eq('번호 없음 → 매번 읽음(얼리기는 같다)', [st.tableReads, r5 === r6, Object.isFrozen(r5.recipes[0])], [16, false, true]);

  st.importId = 6; // 기록 없음을 지나면 캐시는 비었다 → 다시 읽음
  await wire(cache, d);
  eq('번호 없음 뒤 같은 번호 → 다시 읽음', st.tableReads, 20);
}
{
  const { d, st } = fakeD1();
  const cache = createPriceDbCache();
  st.importId = 1;
  let err = null;
  const bad = cache({ latestId: async () => 1, load: async () => { throw new Error('D1 down'); } });
  try { await bad; } catch (e) { err = e.message; }
  await wire(cache, d);
  eq('읽기 실패 → 오류 그대로 · 캐시 안 됨 → 다음 요청 다시 읽음', [err, st.tableReads], ['D1 down', 4]);
}

// ── 3) 배선(원문 대조) ────────────────────────────────────────────────────────
const src = (p) => readFileSync(p, 'utf8');
const priceDbSrc = src('src/lib/price-db.ts');
eq('price-db.ts: loadPriceDbCached 가 캐시·최신 번호 SQL·loadPriceDb 를 쓴다', [
  /export async function loadPriceDbCached\(d: D1\)/.test(priceDbSrc),
  priceDbSrc.includes('SELECT id FROM price_import_log ORDER BY id DESC LIMIT 1'),
  /load: \(\) => loadPriceDb\(d\)/.test(priceDbSrc),
  /createPriceDbCache\(\)/.test(priceDbSrc),
], [true, true, true, true]);
for (const f of ['src/pages/api/quote-estimate.ts', 'src/pages/api/inquiry.ts', 'src/pages/api/admin/quote-calc.ts', 'src/pages/api/admin/quote-rev.ts']) {
  const s = src(f);
  eq(`${f}: loadPriceDbCached 만 쓴다`, [/loadPriceDbCached\(/.test(s), /\bloadPriceDb\(/.test(s)], [true, false]);
}
for (const f of ['src/pages/api/admin/price-import.ts', 'src/pages/api/admin/quote-auto.ts']) {
  eq(`${f}: 캐시를 쓰지 않는다`, /loadPriceDbCached/.test(src(f)), false);
}

if (failed) {
  console.error(`\n가격 DB 캐시(price-cache) 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 가격 DB 캐시(price-cache) — ${total}건 통과 · 얼린 DB 계산 3종 동일 · 캐시 적중 시 가격 표 조회 0번`);
