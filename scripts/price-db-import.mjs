#!/usr/bin/env node
// 견적 가격 DB 가져오기 — 구글 시트 xlsx → 로컬 D1(price_*).
//
// 사용: node scripts/price-db-import.mjs ~/vanam-data/quote-db-v3.xlsx [--dry-run]
//
// ⚠️ 원가 데이터다. 생성 SQL 은 저장소 밖(~/vanam-data/out/price-db.sql)에만 쓴다.
// ⚠️ wrangler 는 scripts/lib/d1-local.mjs 의 runWrangler 하나로만 부른다(--local 강제).
//
// 순서: 읽기 → 검사 → SQL 생성 → 스키마 적용(0001_init.sql) → price-db.sql 적용
//       → 행 수 재조회로 확인 → price_import_log 기록
// 검사에서 하나라도 실패하면 D1 을 건드리지 않고 사유를 출력하고 종료한다.
//   (반쯤 들어간 DB 는 "어느 값이 옛것인지" 알 수 없어 가장 위험하다)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { openXlsx } from './lib/xlsx-lite.mjs';
import { applyFileLocal, execLocal, queryLocal, sqlLit } from './lib/d1-local.mjs';

const DB_NAME = 'vanam-orders';
const OUT_SQL = resolve(homedir(), 'vanam-data/out/price-db.sql');

// ── 시트 → 테이블 사상 ─────────────────────────────────────────────────────
// col: 엑셀 헤더 이름 = D1 컬럼 이름(같게 유지 — 이름이 갈리면 대조가 불가능해진다)
// kind: 'text' | 'num' | 'bool'  (검사 규칙과 SQL 리터럴 방식을 함께 결정)
const T = (name) => ({ name, kind: 'text' });
const N = (name) => ({ name, kind: 'num' });
const B = (name) => ({ name, kind: 'bool' });

const TABLES = [
  {
    table: 'price_equipment', sheet: 'V3_장비DB', id: 'equipment_id',
    cols: [T('equipment_id'), T('equipment_name'), T('process_type'), N('rate_per_min'),
      N('default_loading_min'), N('default_plasma_min'), N('default_setup_min'), B('active'), T('notes')],
  },
  {
    table: 'price_recipe', sheet: 'V3_레시피DB', id: 'recipe_id',
    cols: [T('recipe_id'), T('material_name'), T('process_type'), T('equipment_id'), T('method'),
      N('material_cost_per_nm'), N('growth_nm_per_min'), N('default_temp_c'),
      N('loading_override_min'), N('plasma_override_min'), N('setup_override_min'),
      N('legacy_min_charge'), B('active'), T('verification_status'), T('supplier'), T('notes')],
  },
  {
    table: 'price_substrate', sheet: 'V3_상품기판DB', id: 'catalog_id',
    cols: [T('catalog_id'), T('item_name'), T('category'), T('unit'), N('cost_per_unit'),
      N('sale_price_per_unit'), N('units_per_pack'), N('legacy_pack_price'), N('size_inch'),
      N('oxide_nm'), T('supplier'), B('active'), T('verification_status'), T('notes')],
  },
  // 별칭은 (alias, equipment_scope) 조합이 여러 줄이라 ID 유일성 검사를 하지 않는다.
  {
    table: 'price_alias', sheet: 'V3_별칭DB', id: null,
    cols: [T('entity_type'), T('alias'), T('equipment_scope'), T('canonical_id'), T('status'), T('notes')],
  },
];

// 가격 정책은 열 이름이 시트와 다르다(policy_key → key). 값은 문자열 + vtype 로 보관.
const POLICY = { table: 'price_policy', sheet: 'V3_가격정책' };

// 계산 엔진이 반드시 필요로 하는 키. V3_계산!B30 의 정책 상태 검사와 같은 목록이다.
const REQUIRED_POLICY_KEYS = [
  'default_tax_rate', 'markup_default', 'markup_research', 'markup_special',
  'material_charge_basis_nm', 'material_tier1_limit', 'material_tier1_amount',
  'material_tier2_limit', 'material_tier2_amount', 'film_rounding_unit',
  'direct_price_markup_enabled', 'direct_price_rounding', 'film_unit_price_rounding', 'currency',
];

// ── 검사 ───────────────────────────────────────────────────────────────────
const problems = [];
const bad = (msg) => problems.push(msg);
const isBlank = (v) => v === null || v === undefined || v === '';

/**
 * 시트를 레코드 배열로 읽고 검사한다.
 * @param {ReturnType<typeof openXlsx>} wb
 * @param {(typeof TABLES)[number]} spec
 */
function readTable(wb, spec) {
  const sheet = wb.sheet(spec.sheet);
  const headers = [];
  for (let c = 1; c <= sheet.maxCol; c++) {
    const h = sheet.at(1, c);
    headers.push(isBlank(h) ? null : String(h).trim());
  }
  // 헤더가 기대와 다르면 그대로 넣지 않는다 — 열이 한 칸 밀리면 원가가 뒤바뀐다.
  for (const col of spec.cols) {
    if (!headers.includes(col.name)) bad(`${spec.sheet}: 헤더에 "${col.name}" 열이 없습니다 (읽은 헤더: ${headers.filter(Boolean).join(', ')})`);
  }

  const rows = [];
  const seen = new Map();
  for (let r = 2; r <= sheet.maxRow; r++) {
    const rec = {};
    let any = false;
    for (const col of spec.cols) {
      const c = headers.indexOf(col.name) + 1;
      const v = c > 0 ? sheet.at(r, c) : null;
      rec[col.name] = v;
      if (!isBlank(v)) any = true;
    }
    if (!any) continue; // 완전히 빈 행은 건너뛴다(시트 아래쪽 여백)
    rec.__row = r;
    rows.push(rec);

    for (const col of spec.cols) {
      const v = rec[col.name];
      if (isBlank(v)) continue; // 비움은 NULL — 검사 대상 아님
      if (col.kind === 'num' && typeof v !== 'number') {
        bad(`${spec.sheet} ${r}행: ${col.name} 이 숫자가 아닙니다 → ${JSON.stringify(v)}`);
      }
      if (col.kind === 'bool' && typeof v !== 'boolean') {
        bad(`${spec.sheet} ${r}행: ${col.name} 이 TRUE/FALSE 가 아닙니다 → ${JSON.stringify(v)}`);
      }
    }
    if (spec.id) {
      const id = rec[spec.id];
      if (isBlank(id)) bad(`${spec.sheet} ${r}행: ${spec.id} 가 비어 있습니다`);
      else if (seen.has(id)) bad(`${spec.sheet} ${r}행: ${spec.id} 중복 → ${id} (${seen.get(id)}행과 같음)`);
      else seen.set(id, r);
    }
  }
  if (rows.length === 0) bad(`${spec.sheet}: 데이터 행이 없습니다`);
  return rows;
}

/** 가격 정책 시트 → [{key, value, vtype, applies_to, notes}] */
function readPolicy(wb) {
  const sheet = wb.sheet(POLICY.sheet);
  const head = [1, 2, 3, 4].map((c) => String(sheet.at(1, c) ?? '').trim());
  const want = ['policy_key', 'policy_value', 'applies_to', 'notes'];
  if (head.join('|') !== want.join('|')) bad(`${POLICY.sheet}: 헤더가 기대와 다릅니다 → ${head.join(', ')}`);

  const rows = [];
  const count = new Map();
  for (let r = 2; r <= sheet.maxRow; r++) {
    const key = sheet.at(r, 1);
    const raw = sheet.at(r, 2);
    if (isBlank(key) && isBlank(raw)) continue;
    if (isBlank(key)) { bad(`${POLICY.sheet} ${r}행: policy_key 가 비어 있습니다`); continue; }
    const k = String(key).trim();
    count.set(k, (count.get(k) ?? 0) + 1);
    const vtype = typeof raw === 'boolean' ? 'boolean' : typeof raw === 'number' ? 'number' : 'string';
    const value = vtype === 'boolean' ? (raw ? 'TRUE' : 'FALSE') : raw === null ? null : String(raw);
    rows.push({ key: k, value, vtype, applies_to: sheet.at(r, 3), notes: sheet.at(r, 4), __row: r });
  }
  for (const k of REQUIRED_POLICY_KEYS) {
    const n = count.get(k) ?? 0;
    if (n !== 1) bad(`${POLICY.sheet}: 필수 키 "${k}" 가 ${n}번 있습니다 (정확히 1번이어야 합니다)`);
  }
  return rows;
}

// ── SQL 생성 ───────────────────────────────────────────────────────────────
/**
 * 다시 실행해도 같은 결과가 되도록 DELETE 후 INSERT 한다.
 * price_import_log 는 이 파일에 넣지 않는다 — 가져온 이력(언제·어느 파일)이라
 * 지우면 안 되는 append 전용 표다. 적용 성공 뒤 따로 한 줄 넣는다.
 */
function buildSql(data) {
  const L = [];
  L.push('-- 견적 가격 DB — scripts/price-db-import.mjs 가 생성. 손으로 고치지 마세요.');
  L.push('-- ⚠️ 원가 데이터: 저장소(git)에 넣지 말 것.');
  L.push(`-- 생성 시각: ${new Date().toISOString()}`);
  L.push('');
  for (const spec of TABLES) L.push(`DELETE FROM ${spec.table};`);
  L.push(`DELETE FROM ${POLICY.table};`);
  L.push('');

  const insert = (table, cols, rows, lit) => {
    if (rows.length === 0) return;
    L.push(`-- ${table} (${rows.length}행)`);
    for (const rec of rows) {
      const vals = cols.map((c) => lit(rec, c));
      L.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')});`);
    }
    L.push('');
  };

  for (const spec of TABLES) {
    insert(spec.table, spec.cols.map((c) => c.name), data[spec.table], (rec, name) => {
      const col = spec.cols.find((c) => c.name === name);
      const v = rec[name];
      if (isBlank(v)) return 'NULL';
      if (col.kind === 'bool') return v === true ? '1' : '0'; // active 는 0/1 정수
      return sqlLit(v);
    });
  }
  insert(POLICY.table, ['key', 'value', 'vtype', 'applies_to', 'notes'], data[POLICY.table],
    (rec, name) => (isBlank(rec[name]) ? 'NULL' : sqlLit(rec[name])));
  return L.join('\n') + '\n';
}

// ── 본체 ───────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const src = args.find((a) => !a.startsWith('--'));
  if (!src) {
    console.error('사용: node scripts/price-db-import.mjs <quote-db-v3.xlsx> [--dry-run]');
    process.exit(2);
  }
  const srcPath = resolve(src.replace(/^~(?=$|\/)/, homedir()));
  console.log(`원본: ${srcPath}`);

  const buf = readFileSync(srcPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const wb = openXlsx(srcPath);

  const data = {};
  for (const spec of TABLES) data[spec.table] = readTable(wb, spec);
  data[POLICY.table] = readPolicy(wb);

  if (problems.length) {
    console.error(`\n검사 실패 — ${problems.length}건. D1 은 건드리지 않았습니다.`);
    for (const p of problems) console.error('  ✗', p);
    process.exit(1);
  }

  const counts = {
    price_policy: data.price_policy.length,
    price_equipment: data.price_equipment.length,
    price_recipe: data.price_recipe.length,
    price_substrate: data.price_substrate.length,
    price_alias: data.price_alias.length,
  };
  console.log('검사 통과 —', Object.entries(counts).map(([k, v]) => `${k} ${v}행`).join(' · '));

  mkdirSync(dirname(OUT_SQL), { recursive: true });
  writeFileSync(OUT_SQL, buildSql(data), 'utf8');
  console.log(`SQL 생성: ${OUT_SQL}`);

  if (dryRun) { console.log('--dry-run: D1 적용을 건너뜁니다.'); return; }

  console.log('스키마 적용(migrations/0001_init.sql) …');
  applyFileLocal(DB_NAME, 'migrations/0001_init.sql');
  console.log('가격 DB 적용 …');
  applyFileLocal(DB_NAME, OUT_SQL);

  // 행 수 재조회 — 생성 SQL 이 아니라 DB 가 실제로 무엇을 가졌는지 확인한다.
  let mismatch = 0;
  for (const [table, expect] of Object.entries(counts)) {
    const got = Number(queryLocal(DB_NAME, `SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? -1);
    const ok = got === expect;
    if (!ok) mismatch++;
    console.log(`  ${ok ? '✓' : '✗'} ${table}: 기대 ${expect} · 실제 ${got}`);
  }
  if (mismatch) {
    console.error(`\n행 수 불일치 ${mismatch}건 — price_import_log 를 기록하지 않습니다.`);
    process.exit(1);
  }

  const rulesVersion = data.price_policy.find((p) => p.key === 'rules_version')?.value ?? null;
  execLocal(DB_NAME,
    `INSERT INTO price_import_log (imported_at, source_file, source_sha256, rules_version, counts_json) VALUES (`
    + [new Date().toISOString(), srcPath, sha256, rulesVersion, JSON.stringify(counts)].map(sqlLit).join(', ')
    + ');');
  const log = queryLocal(DB_NAME, 'SELECT * FROM price_import_log ORDER BY id DESC LIMIT 1')[0];
  console.log('price_import_log 기록:', JSON.stringify(log));
  console.log('완료.');
}

main();
