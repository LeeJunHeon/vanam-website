// 관리자 전용: 가격 DB 올리기 (관리자 설정 탭 '가격 DB 올리기 (엑셀)' 카드가 부른다).
//
//   엑셀은 브라우저가 읽는다(워커 CPU 한도) — 여기에는 검사된 값(JSON)만 온다. 파일은 저장하지 않는다.
//   POST { mode:'preview', file, data }                                → 지금 DB 와 비교(개수·ID·바뀐 열 이름)
//   POST { mode:'apply',   file, data, baseFingerprint, expectFingerprint } → D1 batch 하나로 통째 교체
//
// ⚠️ 서버가 다시 검사한다(validatePriceData) — 브라우저 검사를 믿지 않는다.
// ⚠️ 교체는 batch 하나(트랜잭션): DELETE 5 → INSERT 묶음 → price_import_log. 실패하면 가격 DB 는 그대로다.
// ⚠️ 미리보기 뒤 DB 가 바뀌었으면(baseFingerprint 불일치) 바꾸지 않는다. 바꾼 뒤 다시 읽어 지문을 확인한다.
// ⚠️ SQL 은 표마다 정적 문자열이다(표·컬럼 이름을 변수로 조립하지 않는다 — scripts/check-schema.mjs 가 읽는다).
//    자리표시자 묶음만 행 수만큼 잇는다. 한 문장의 자리표시자는 100개 이하(insertChunks).
// ⚠️ 로그에는 오류 종류·개수만(값·ID·파일 이름 금지). 구글챗 알림은 보내지 않는다.
// D1 호출: 스키마 표식 1 + 읽기 5 + batch 1 + 다시 읽기 5 + 가져오기 기록 1.
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db, nowIso } from '../../../lib/db';
import { readPriceTables, latestImport } from '../../../lib/price-db';
import {
  validatePriceData, priceRowsForDb, priceFingerprint, priceDiff, insertChunks, PRICE_TABLE_ORDER,
} from '../../../lib/price-sheet.js';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const MAX_BODY = 2_000_000;
const HEX64 = /^[0-9a-f]{64}$/;

// 표마다 고정 SQL — 컬럼 순서는 price-sheet.js 스펙과 같다(test-price-sheet 가 대조한다)
const DELETES = [
  'DELETE FROM price_policy',
  'DELETE FROM price_equipment',
  'DELETE FROM price_recipe',
  'DELETE FROM price_substrate',
  'DELETE FROM price_alias',
];
const INSERT_HEAD: Record<string, string> = {
  price_policy: 'INSERT INTO price_policy (key, value, vtype, applies_to, notes) VALUES ',
  price_equipment: 'INSERT INTO price_equipment (equipment_id, equipment_name, process_type, rate_per_min, default_loading_min, default_plasma_min, default_setup_min, active, notes) VALUES ',
  price_recipe: 'INSERT INTO price_recipe (recipe_id, material_name, process_type, equipment_id, method, material_cost_per_nm, growth_nm_per_min, default_temp_c, loading_override_min, plasma_override_min, setup_override_min, legacy_min_charge, active, verification_status, supplier, notes) VALUES ',
  price_substrate: 'INSERT INTO price_substrate (catalog_id, item_name, category, unit, cost_per_unit, sale_price_per_unit, units_per_pack, legacy_pack_price, size_inch, oxide_nm, supplier, active, verification_status, notes) VALUES ',
  price_alias: 'INSERT INTO price_alias (entity_type, alias, equipment_scope, canonical_id, status, notes) VALUES ',
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Rows = ReturnType<typeof priceRowsForDb>;
const countsOf = (r: Rows) => ({
  price_policy: r.price_policy.rows.length,
  price_equipment: r.price_equipment.rows.length,
  price_recipe: r.price_recipe.rows.length,
  price_substrate: r.price_substrate.rows.length,
  price_alias: r.price_alias.rows.length,
});

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
  if (!isObj(body)) return json({ ok: false, error: 'bad_request' }, 400);
  const mode = body.mode;
  if (mode !== 'preview' && mode !== 'apply') return json({ ok: false, error: 'bad_mode' }, 400);

  const f = isObj(body.file) ? body.file : {};
  const fileName = String(f.name ?? '').split(/[\\/]/).pop()!.slice(0, 200);
  const fileSha = String(f.sha256 ?? '').toLowerCase();
  if (!HEX64.test(fileSha)) return json({ ok: false, error: 'bad_file' }, 400);

  const { problems } = validatePriceData(body.data);
  if (problems.length) {
    console.warn('[admin/price-import] 검사 실패:', problems.length, '건');
    return json({ ok: false, error: 'invalid', count: problems.length, problems: problems.slice(0, 50) }, 400);
  }

  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  try {
    const next = priceRowsForDb(body.data as Record<string, Record<string, unknown>[]>);
    const nextFp = await priceFingerprint(next);
    const current = priceRowsForDb(await readPriceTables(d));
    const curFp = await priceFingerprint(current);
    const counts = countsOf(next);

    if (mode === 'preview') {
      return json({
        ok: true, mode, counts,
        current: { counts: countsOf(current), fingerprint: curFp },
        next: { fingerprint: nextFp },
        same: curFp === nextFp,
        diff: priceDiff(current, next),
      });
    }

    // apply
    const base = String(body.baseFingerprint ?? '');
    const expect = String(body.expectFingerprint ?? '');
    if (!HEX64.test(base) || !HEX64.test(expect)) return json({ ok: false, error: 'bad_fingerprint' }, 400);
    if (base !== curFp) return json({ ok: false, error: 'db_changed' }, 409);
    if (expect !== nextFp) return json({ ok: false, error: 'data_changed' }, 409);

    const stmts: unknown[] = DELETES.map((sql) => d.prepare(sql));
    for (const table of PRICE_TABLE_ORDER) {
      const { cols, rows } = next[table];
      const one = `(${cols.map(() => '?').join(', ')})`;
      for (const chunk of insertChunks(rows, cols.length)) {
        stmts.push(d.prepare(INSERT_HEAD[table] + chunk.map(() => one).join(', ')).bind(...chunk.flat()));
      }
    }
    const rulesVersion = (next.price_policy.rows.find((r) => r[0] === 'rules_version')?.[1] ?? null) as string | null;
    stmts.push(
      d.prepare(`INSERT INTO price_import_log (imported_at, source_file, source_sha256, rules_version, counts_json) VALUES (?, ?, ?, ?, ?)`)
        .bind(nowIso(), `admin-upload:${fileName}`, fileSha, rulesVersion, JSON.stringify(counts)),
    );

    try {
      await d.batch(stmts);
    } catch (e) {
      console.error('[admin/price-import] batch 실패(가격 DB 그대로):', (e as Error)?.name ?? 'Error');
      return json({ ok: false, error: 'db_error' }, 500);
    }

    const afterFp = await priceFingerprint(priceRowsForDb(await readPriceTables(d)));
    if (afterFp !== nextFp) {
      console.error('[admin/price-import] 적용 뒤 지문 불일치');
      return json({ ok: false, error: 'verify_mismatch', fingerprint: afterFp }, 500);
    }
    const log = await latestImport(d);
    return json({
      ok: true, mode, counts, fingerprint: afterFp,
      importLog: log && {
        imported_at: log.imported_at,
        rules_version: log.rules_version,
        sha12: String(log.source_sha256 ?? '').slice(0, 12),
      },
    });
  } catch (e) {
    console.error('[admin/price-import] 실패:', (e as Error)?.name ?? 'Error');
    return json({ ok: false, error: 'db_error' }, 500);
  }
};
