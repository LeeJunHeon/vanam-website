// 관리자 전용: 가격 DB 편집(/admin/price 화면이 부른다).
//
//   GET                                                   → 표 5개 전체(별칭은 DB 번호 포함) · 지문 · 마지막 엑셀 올리기 · 그 뒤 수정 수 · 최근 수정 기록
//   POST { action:'save', table, mode:'edit'|'add', key?, before?, row } → 한 행 수정·추가
//   POST { action:'revert', logId, after }                → 수정 기록 한 줄을 되돌린다(그 행이 기록의 '바뀐 뒤'와 같을 때만)
//
// 규칙(src/lib/price-edit.js):
//   · 행 삭제는 없다 — 장비·레시피·기판은 active(사용함/사용 안 함)로만 끈다.
//   · 바꾼 행을 끼운 전체 데이터를 엑셀 올리기와 같은 검사(validatePriceData)로 다시 본다.
//   · 불러올 때의 행(before)이 지금 DB 와 다르면 저장하지 않는다(row_changed — 다른 사람이 먼저 바꿈).
//   · 저장은 batch 하나(트랜잭션): 행 UPDATE/INSERT + 수정 기록 + price_import_log 한 줄.
//     price_import_log 줄은 가격 캐시 열쇠를 바꾸려는 것이다(src/lib/price-cache.js — 기록이 안 바뀌면 캐시가 옛 값을 쓴다).
//     source_file 이 'admin-edit:' 로 시작해 '엑셀 올리기'로는 세지 않는다.
// ⚠️ SQL 은 표마다 정적 문자열(scripts/check-schema.mjs 가 컬럼을 대조한다).
// ⚠️ 로그에는 표 이름·동작만 — 값·ID 는 남기지 않는다. 구글챗은 보내지 않는다.
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db, nowIso } from '../../../lib/db';
import type { D1 } from '../../../lib/db';
import {
  readPriceTables, readAliasWithIds, lastUpload, editsSinceUpload, recentEdits, editLogById, EDIT_SOURCE_PREFIX,
} from '../../../lib/price-db';
import { priceRowsForDb, priceFingerprint, PRICE_TABLE_ORDER } from '../../../lib/price-sheet.js';
import { editSpec, rowFromInput, checkEdit, sameRow, changedCols, rowKey } from '../../../lib/price-edit.js';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const MAX_BODY = 200_000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// 표마다 고정 SQL — 컬럼 순서는 price-sheet.js 스펙과 같다(UPDATE 는 키 열을 바꾸지 않는다)
const UPDATE_SQL: Record<string, string> = {
  price_policy: 'UPDATE price_policy SET value = ?, vtype = ?, applies_to = ?, notes = ? WHERE key = ?',
  price_equipment: 'UPDATE price_equipment SET equipment_name = ?, process_type = ?, rate_per_min = ?, default_loading_min = ?, default_plasma_min = ?, default_setup_min = ?, active = ?, notes = ? WHERE equipment_id = ?',
  price_recipe: 'UPDATE price_recipe SET material_name = ?, process_type = ?, equipment_id = ?, method = ?, material_cost_per_nm = ?, growth_nm_per_min = ?, default_temp_c = ?, loading_override_min = ?, plasma_override_min = ?, setup_override_min = ?, legacy_min_charge = ?, active = ?, verification_status = ?, supplier = ?, notes = ? WHERE recipe_id = ?',
  price_substrate: 'UPDATE price_substrate SET item_name = ?, category = ?, unit = ?, cost_per_unit = ?, sale_price_per_unit = ?, units_per_pack = ?, legacy_pack_price = ?, size_inch = ?, oxide_nm = ?, supplier = ?, active = ?, verification_status = ?, notes = ? WHERE catalog_id = ?',
  price_alias: 'UPDATE price_alias SET entity_type = ?, alias = ?, equipment_scope = ?, canonical_id = ?, status = ?, notes = ? WHERE id = ?',
};
const INSERT_SQL: Record<string, string> = {
  price_policy: 'INSERT INTO price_policy (key, value, vtype, applies_to, notes) VALUES (?, ?, ?, ?, ?)',
  price_equipment: 'INSERT INTO price_equipment (equipment_id, equipment_name, process_type, rate_per_min, default_loading_min, default_plasma_min, default_setup_min, active, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  price_recipe: 'INSERT INTO price_recipe (recipe_id, material_name, process_type, equipment_id, method, material_cost_per_nm, growth_nm_per_min, default_temp_c, loading_override_min, plasma_override_min, setup_override_min, legacy_min_charge, active, verification_status, supplier, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  price_substrate: 'INSERT INTO price_substrate (catalog_id, item_name, category, unit, cost_per_unit, sale_price_per_unit, units_per_pack, legacy_pack_price, size_inch, oxide_nm, supplier, active, verification_status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  price_alias: 'INSERT INTO price_alias (entity_type, alias, equipment_scope, canonical_id, status, notes) VALUES (?, ?, ?, ?, ?, ?)',
};
/** UPDATE 의 값 순서 = 스펙 열(키 제외) [+ 정책은 vtype 을 value 뒤에] + 키 */
const updateArgs = (table: string, row: Record<string, unknown>, key: string): unknown[] => {
  const v = (x: unknown) => (typeof x === 'boolean' ? (x ? 1 : 0) : x ?? null);
  if (table === 'price_policy') return [v(row.value), v(row.vtype), v(row.applies_to), v(row.notes), key];
  const spec = editSpec(table)!;
  return [...spec.cols.filter((c) => c.name !== spec.id).map((c) => v(row[c.name])), table === 'price_alias' ? Number(key) : key];
};
const insertArgs = (table: string, row: Record<string, unknown>): unknown[] => {
  const v = (x: unknown) => (typeof x === 'boolean' ? (x ? 1 : 0) : x ?? null);
  if (table === 'price_policy') return [v(row.key), v(row.value), v(row.vtype), v(row.applies_to), v(row.notes)];
  return editSpec(table)!.cols.map((c) => v(row[c.name]));
};

/** 가격 DB 의 '판' 번호 = 가져오기 기록의 마지막 id(엑셀 올리기·관리자 수정마다 하나씩 는다). 없으면 null. */
async function stampOf(d: D1): Promise<number | null> {
  const r = await d.prepare(`SELECT max(id) AS m FROM price_import_log`).first<{ m: number | null }>();
  return r?.m ?? null;
}

/** 지금 DB 의 표 5개(별칭은 DB 번호 포함) + 읽기 직전의 판 번호 */
async function readAll(d: D1) {
  const stamp = await stampOf(d); // 표보다 먼저 읽는다 — 그 사이에 바뀌면 저장 때 판이 달라 거절된다(안전한 쪽)
  const t = await readPriceTables(d);
  return { tables: { ...t, price_alias: await readAliasWithIds(d) }, stamp };
}

/** 별칭의 DB 번호를 뺀 표(지문용) */
const withoutAliasIds = (t: Record<string, Record<string, unknown>[]>) =>
  ({ ...t, price_alias: (t.price_alias ?? []).map(({ id: _id, ...r }) => r) });

async function payload(d: D1) {
  const { tables } = await readAll(d);
  const fingerprint = await priceFingerprint(priceRowsForDb(withoutAliasIds(tables as Record<string, Record<string, unknown>[]>)));
  const up = await lastUpload(d);
  const since = await editsSinceUpload(d, 0);
  return {
    ok: true,
    tables,
    counts: Object.fromEntries(PRICE_TABLE_ORDER.map((t) => [t, (tables as Record<string, unknown[]>)[t].length])),
    fingerprint,
    lastUpload: up && { imported_at: up.imported_at, file: String(up.source_file ?? '').replace(/^admin-upload:/, '') },
    editsSinceUpload: since.count,
    log: (await recentEdits(d, 50)).map((r) => ({
      id: r.id, at: r.at, table: r.table_name, key: r.row_key, action: r.action,
      cols: safeParse(r.cols_json) ?? [], before: safeParse(r.before_json), after: safeParse(r.after_json),
    })),
  };
}
const safeParse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export const GET: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);
  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);
  try {
    return json(await payload(d));
  } catch (e) {
    console.error('[admin/price-edit] 읽기 실패:', (e as Error)?.name ?? 'Error');
    return json({ ok: false, error: 'db_error' }, 500);
  }
};

/**
 * 한 행 저장(수정·추가·되돌림 공용). 검사·동시 수정 확인을 마친 뒤 batch 하나로 쓴다.
 * @returns 오류 응답 또는 null(성공)
 */
async function writeRow(d: D1, a: {
  table: string; mode: 'edit' | 'add'; key: string; before: Record<string, unknown> | null; row: Record<string, unknown>; action: 'edit' | 'add' | 'revert';
}): Promise<Response | null> {
  const { tables, stamp } = await readAll(d);
  const { problems, current } = checkEdit(tables, { table: a.table, mode: a.mode, key: a.key, row: a.row });
  if (a.mode === 'edit' && current && a.before && !sameRow(a.table, current, a.before)) return json({ ok: false, error: 'row_changed' }, 409);
  if (a.mode === 'edit' && !current) return json({ ok: false, error: 'not_found' }, 404);
  if (problems.length) return json({ ok: false, error: 'invalid', count: problems.length, problems: problems.slice(0, 30) }, 400);

  const cols = changedCols(a.table, current, a.row);
  if (a.mode === 'edit' && cols.length === 0) return json({ ok: false, error: 'no_change' }, 400);

  const key = a.mode === 'edit' ? a.key : rowKey(a.table, a.row);
  // 저장 뒤 데이터 지문(가격 캐시 열쇠 기록에 남긴다 — 견적 개정의 price_sha 가 '어느 가격 DB 로 계산했는가'를 가리키게)
  const spec = editSpec(a.table)!;
  const list = (tables as Record<string, Record<string, unknown>[]>)[a.table];
  const nextTables = {
    ...tables,
    [a.table]: a.mode === 'edit'
      ? list.map((r) => (rowKey(a.table, r) === key ? { ...r, ...a.row } : r))
      : [...list, a.row],
  };
  const fp = await priceFingerprint(priceRowsForDb(withoutAliasIds(nextTables as Record<string, Record<string, unknown>[]>)));
  const rules = String((nextTables.price_policy as Record<string, unknown>[]).find((r) => r.key === 'rules_version')?.value ?? '') || null;
  const counts = Object.fromEntries(PRICE_TABLE_ORDER.map((t) => [t, (nextTables as Record<string, unknown[]>)[t].length]));
  const at = nowIso();
  const afterRow = spec.aliasId && a.mode === 'edit' ? { ...a.row, id: Number(key) } : a.row;
  const logArgs = [at, a.table, a.action, JSON.stringify(cols), current ? JSON.stringify(current) : null, JSON.stringify(afterRow)];

  const stmts: unknown[] = [
    // ① 판 확인 — 읽은 뒤 누가 저장했거나 엑셀을 올렸으면(판 번호가 바뀜) 이 문장이 오류를 내 batch 전체가 되돌려진다.
    //    (json('x') 는 잘못된 JSON 이라 SQLite 가 오류를 낸다 — D1 batch 는 한 트랜잭션이라 아무것도 쓰이지 않는다)
    d.prepare(`SELECT CASE WHEN (SELECT max(id) FROM price_import_log) IS ? THEN 1 ELSE json('x') END AS ok`).bind(stamp),
    a.mode === 'edit'
      ? d.prepare(UPDATE_SQL[a.table]).bind(...updateArgs(a.table, a.row, key))
      : d.prepare(INSERT_SQL[a.table]).bind(...insertArgs(a.table, a.row)),
    // 새 별칭은 DB 번호가 INSERT 때 정해진다 — 같은 batch 바로 앞 INSERT 의 번호(last_insert_rowid)를 키·after 에 넣는다
    spec.aliasId && a.mode === 'add'
      ? d.prepare(`INSERT INTO price_edit_log (at, table_name, row_key, action, cols_json, before_json, after_json)
          VALUES (?, ?, CAST(last_insert_rowid() AS TEXT), ?, ?, ?, json_set(?, '$.id', last_insert_rowid()))`).bind(...logArgs)
      : d.prepare(`INSERT INTO price_edit_log (at, table_name, row_key, action, cols_json, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(logArgs[0], logArgs[1], key, ...logArgs.slice(2)),
    d.prepare(`INSERT INTO price_import_log (imported_at, source_file, source_sha256, rules_version, counts_json) VALUES (?, ?, ?, ?, ?)`)
      .bind(at, `${EDIT_SOURCE_PREFIX}${a.table}`, fp, rules, JSON.stringify(counts)),
  ];
  try {
    await d.batch(stmts);
  } catch (e) {
    // 판이 바뀌어 거절된 것이면 409(다시 불러와 확인) — 그 밖은 저장 실패. 어느 쪽이든 아무것도 바뀌지 않았다.
    let changed = false;
    try { changed = (await stampOf(d)) !== stamp; } catch { /* 모름 — 저장 실패로 */ }
    if (changed) return json({ ok: false, error: 'row_changed' }, 409);
    console.error('[admin/price-edit] 저장 실패(바뀌지 않음):', a.table, (e as Error)?.name ?? 'Error');
    return json({ ok: false, error: 'db_error' }, 500);
  }
  console.log(`[admin/price-edit] ${a.table} ${a.action}`);
  return null;
}

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
  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  try {
    if (body.action === 'save') {
      const table = String(body.table ?? '');
      const spec = editSpec(table);
      if (!spec) return json({ ok: false, error: 'bad_table' }, 400);
      const mode = body.mode === 'add' ? 'add' : body.mode === 'edit' ? 'edit' : null;
      if (!mode) return json({ ok: false, error: 'bad_mode' }, 400);
      if (!isObj(body.row)) return json({ ok: false, error: 'bad_row' }, 400);
      const { row, problems } = rowFromInput(table, body.row);
      if (problems.length) return json({ ok: false, error: 'invalid', count: problems.length, problems }, 400);
      const key = mode === 'edit' ? String(body.key ?? '') : '';
      if (mode === 'edit' && (!key || !isObj(body.before))) return json({ ok: false, error: 'bad_key' }, 400);
      // 수정이면 키는 지금 행의 키(화면이 보낸 row 의 키 칸은 믿지 않는다 — 별칭은 row 에 키가 없다)
      if (mode === 'edit' && !spec.aliasId) row[spec.id] = key;
      const err = await writeRow(d, { table, mode, key, before: mode === 'edit' ? (body.before as Record<string, unknown>) : null, row, action: mode });
      if (err) return err;
      return json(await payload(d));
    }

    if (body.action === 'revert') {
      const logId = Number(body.logId);
      if (!Number.isInteger(logId) || logId < 1) return json({ ok: false, error: 'bad_log' }, 400);
      const log = await editLogById(d, logId);
      if (!log) return json({ ok: false, error: 'not_found' }, 404);
      // 추가(add)는 되돌리지 않는다(행 삭제가 없다 — 필요하면 사용 안 함으로)
      if (log.action === 'add' || !log.before_json) return json({ ok: false, error: 'cannot_revert_add' }, 400);
      const before = safeParse(log.before_json);
      const after = safeParse(log.after_json);
      if (!isObj(before) || !isObj(after)) return json({ ok: false, error: 'bad_log' }, 400);
      const spec = editSpec(log.table_name);
      if (!spec) return json({ ok: false, error: 'bad_table' }, 400);
      // 되돌릴 값 = 기록의 '바뀌기 전' 행(키 열·별칭 번호는 그대로)
      const { id: _id, ...beforeRow } = before as Record<string, unknown>;
      const { row, problems } = rowFromInput(log.table_name, beforeRow);
      if (problems.length) return json({ ok: false, error: 'invalid', count: problems.length, problems }, 400);
      if (!spec.aliasId) row[spec.id] = log.row_key;
      // 그 행이 기록의 '바뀐 뒤'와 같을 때만 — 그 뒤에 또 바뀌었으면 되돌리지 않는다
      const err = await writeRow(d, { table: log.table_name, mode: 'edit', key: log.row_key, before: after, row, action: 'revert' });
      if (err) return err;
      return json(await payload(d));
    }

    return json({ ok: false, error: 'bad_action' }, 400);
  } catch (e) {
    console.error('[admin/price-edit] 실패:', (e as Error)?.name ?? 'Error');
    return json({ ok: false, error: 'db_error' }, 500);
  }
};
