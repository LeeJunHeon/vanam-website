// 관리자 전용: 견적 계산기 API (/admin/quote 화면이 부른다).
//
//   GET  → 드롭다운용 메타만. 원가·요율·마진 숫자는 절대 넣지 않는다
//          (화면을 띄우기만 해도 원가표가 브라우저로 내려가면 안 된다).
//   POST → { items, layers } 를 받아 로컬 D1 의 price_* 로 computeQuote 를 돌리고
//          결과(원가 내역 breakdown 포함)를 그대로 돌려준다. 계산은 항상 서버에서 한다.
//
// ⚠️ 입력값은 변환하지 않는다. "abc"·음수·빈칸도 그대로 엔진에 넘긴다 —
//    엔진이 엑셀과 같은 의미로 판정해 같은 오류 문구를 낸다.
// ⚠️ SELECT 는 컬럼 이름을 적는다(scripts/check-schema.mjs 가 스키마와 대조한다).
//    공급사·메모 같은 계산에 안 쓰는 컬럼은 읽지 않는다.
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db } from '../../../lib/db';
import { computeQuote } from '../../../lib/quote-engine.js';
import { loadPriceDb, latestImport } from '../../../lib/price-db';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const MAX_ITEMS = 15;     // 엑셀 V3_견적입력 15~29행
const MAX_LAYERS = 100;   // 엑셀 V3_박막공정 2~101행
const MAX_BODY = 200_000; // 15품목·100층을 넉넉히 담는 크기

const EMPTY = { ok: false, error: 'price_db_empty', hint: '로컬 가격 DB 가 비어 있습니다. npm run price:import 를 먼저 실행하세요.' };

type D1 = NonNullable<Awaited<ReturnType<typeof db>>>;
const all = async <T = Record<string, unknown>>(d: D1, sql: string) =>
  (await d.prepare(sql).all<T>()).results ?? [];

export const GET: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);
  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  const recipes = await all(d, `SELECT recipe_id, material_name, process_type, equipment_id, method, active
    FROM price_recipe ORDER BY equipment_id, recipe_id`);
  const equipment = await all(d, `SELECT equipment_id, equipment_name, process_type, active
    FROM price_equipment ORDER BY equipment_id`);
  const substrates = await all(d, `SELECT catalog_id, item_name, active
    FROM price_substrate ORDER BY catalog_id`);
  const policy = await all<{ key: string; value: string | null }>(d, `SELECT key, value
    FROM price_policy WHERE key IN ('default_delivery_due', 'quote_valid_days')`);
  const log = await latestImport(d);
  if (recipes.length === 0) return json(EMPTY, 503);

  const pv = (k: string) => policy.find((p) => p.key === k)?.value ?? null;
  const days = Number(pv('quote_valid_days'));
  return json({
    ok: true,
    recipes,
    equipment,
    substrates,
    defaults: { delivery: pv('default_delivery_due') ?? '', validDays: Number.isFinite(days) ? days : null },
    importLog: log && {
      imported_at: log.imported_at,
      rules_version: log.rules_version,
      sha256: String(log.source_sha256 ?? '').slice(0, 12),
    },
  });
};

const isObj = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);

export const POST: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 400);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const items = body?.items ?? [];
  const layers = body?.layers ?? [];
  if (!Array.isArray(items) || !Array.isArray(layers) || !items.every(isObj) || !layers.every(isObj)) {
    return json({ ok: false, error: 'bad_shape' }, 400);
  }
  if (items.length > MAX_ITEMS) return json({ ok: false, error: 'too_many_items', max: MAX_ITEMS }, 400);
  if (layers.length > MAX_LAYERS) return json({ ok: false, error: 'too_many_layers', max: MAX_LAYERS }, 400);

  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  const priceDb = await loadPriceDb(d);
  if (priceDb.policy.length === 0 || priceDb.recipes.length === 0) return json(EMPTY, 503);

  return json({ ok: true, result: computeQuote(priceDb, { items, layers }) });
};
