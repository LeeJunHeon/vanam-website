// 가격 DB(price_*) 읽기 — 자동 견적(/api/quote-estimate · 접수 시 자동 견적)과 관리자 계산기가 같이 쓴다.
//
// ⚠️ SELECT 는 컬럼 이름을 적는다(scripts/check-schema.mjs 가 스키마와 대조한다).
//    공급사·메모처럼 계산에 안 쓰는 컬럼은 읽지 않는다.
// ⚠️ 여기서 읽은 원가·요율은 서버 안에서만 쓴다 — 응답으로 내보내는 것은 호출부가 허용 목록으로 만든다.
import type { D1 } from './db';
import { createPriceDbCache, importKeyOf } from './price-cache.js';

export type PriceDb = {
  policy: Record<string, unknown>[];
  recipes: Record<string, unknown>[];
  equipment: Record<string, unknown>[];
  substrates: Record<string, unknown>[];
};

const all = async <T = Record<string, unknown>>(d: D1, sql: string) =>
  ((await d.prepare(sql).all<T>()).results ?? []) as T[];

// 계산용 SELECT — loadPriceDb 와 캐시 스냅샷(batch)이 같은 문장을 쓴다.
const POLICY_SQL = `SELECT key, value, vtype FROM price_policy`;
const RECIPE_SQL = `SELECT recipe_id, material_name, process_type, equipment_id, method,
      material_cost_per_nm, growth_nm_per_min, default_temp_c,
      loading_override_min, plasma_override_min, setup_override_min,
      legacy_min_charge, active
      FROM price_recipe`;
const EQUIPMENT_SQL = `SELECT equipment_id, equipment_name, process_type, rate_per_min,
      default_loading_min, default_plasma_min, default_setup_min, active
      FROM price_equipment`;
const SUBSTRATE_SQL = `SELECT catalog_id, item_name, category, unit, cost_per_unit, size_inch, oxide_nm, active
      FROM price_substrate`;
const IMPORT_KEY_SQL = `SELECT id, imported_at FROM price_import_log ORDER BY id DESC LIMIT 1`;

/** 계산에 필요한 가격 DB 전체 (캐시 없음) */
export async function loadPriceDb(d: D1): Promise<PriceDb> {
  return {
    policy: await all(d, POLICY_SQL),
    recipes: await all(d, RECIPE_SQL),
    equipment: await all(d, EQUIPMENT_SQL),
    substrates: await all(d, SUBSTRATE_SQL),
  };
}

const priceDbCache = createPriceDbCache();

type Rows = { results?: Record<string, unknown>[] };

/**
 * loadPriceDb + 워커 메모리 캐시 — 최신 가져오기 열쇠(id|imported_at)가 같으면 D1 1번(1행)으로 끝난다.
 * 다르면 기록 1행 + 가격 표 4개를 batch 한 번(트랜잭션)으로 읽어 그 열쇠로 저장한다.
 * 자동 견적·관리자 계산기·견적 편집이 쓴다. 돌려주는 객체는 깊게 얼어 있다(고치면 TypeError).
 * ⚠️ price_* 표를 손으로 고치면 기록이 안 바뀌어 캐시가 모른다 — 규칙은 src/lib/price-cache.js 머리말.
 *    readPriceTables(올리기 비교·지문)는 캐시를 쓰지 않는다.
 */
export async function loadPriceDbCached(d: D1): Promise<PriceDb> {
  return priceDbCache({
    latestKey: async () => importKeyOf(await d.prepare(IMPORT_KEY_SQL).first<{ id: number; imported_at: string }>()),
    loadSnapshot: async () => {
      const r = (await d.batch([
        d.prepare(IMPORT_KEY_SQL), d.prepare(POLICY_SQL), d.prepare(RECIPE_SQL), d.prepare(EQUIPMENT_SQL), d.prepare(SUBSTRATE_SQL),
      ])) as Rows[];
      const rows = (i: number) => r[i]?.results ?? [];
      return {
        key: importKeyOf(rows(0)[0] as { id?: unknown; imported_at?: unknown } | undefined),
        db: { policy: rows(1), recipes: rows(2), equipment: rows(3), substrates: rows(4) },
      };
    },
  });
}

/** 정책·레시피가 하나라도 있는가 (가져오기 전이면 false) */
export async function priceDbReady(d: D1): Promise<boolean> {
  const p = await d.prepare(`SELECT key FROM price_policy LIMIT 1`).first();
  if (!p) return false;
  const r = await d.prepare(`SELECT recipe_id FROM price_recipe LIMIT 1`).first();
  return Boolean(r);
}

/** 가장 최근 가격 DB 가져오기 기록 */
export async function latestImport(d: D1): Promise<{ imported_at: string; rules_version: string; source_sha256: string } | null> {
  const row = await d
    .prepare(`SELECT imported_at, rules_version, source_sha256
      FROM price_import_log ORDER BY id DESC LIMIT 1`)
    .first<{ imported_at: string; rules_version: string; source_sha256: string }>();
  return row ?? null;
}

export type PriceTables = {
  price_policy: Record<string, unknown>[];
  price_equipment: Record<string, unknown>[];
  price_recipe: Record<string, unknown>[];
  price_substrate: Record<string, unknown>[];
  price_alias: Record<string, unknown>[];
};

/**
 * 가격 DB 5개 표 전체(스펙 컬럼 전부 — 공급사·메모 포함, 별칭의 자동 id 는 제외).
 * ⚠️ 관리자 비교·지문 전용(/api/admin/price-import · quote-auto GET). 고객 응답에 쓰지 않는다.
 *    열 목록은 src/lib/price-sheet.js 의 스펙과 같아야 한다(scripts/test-price-sheet.mjs 가 대조).
 */
export async function readPriceTables(d: D1): Promise<PriceTables> {
  return {
    price_policy: await all(d, `SELECT key, value, vtype, applies_to, notes FROM price_policy`),
    price_equipment: await all(d, `SELECT equipment_id, equipment_name, process_type, rate_per_min,
      default_loading_min, default_plasma_min, default_setup_min, active, notes
      FROM price_equipment`),
    price_recipe: await all(d, `SELECT recipe_id, material_name, process_type, equipment_id, method,
      material_cost_per_nm, growth_nm_per_min, default_temp_c,
      loading_override_min, plasma_override_min, setup_override_min,
      legacy_min_charge, active, verification_status, supplier, notes
      FROM price_recipe`),
    price_substrate: await all(d, `SELECT catalog_id, item_name, category, unit, cost_per_unit,
      sale_price_per_unit, units_per_pack, legacy_pack_price, size_inch,
      oxide_nm, supplier, active, verification_status, notes
      FROM price_substrate`),
    price_alias: await all(d, `SELECT entity_type, alias, equipment_scope, canonical_id, status, notes FROM price_alias`),
  };
}
