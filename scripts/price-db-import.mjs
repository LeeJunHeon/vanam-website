#!/usr/bin/env node
// 견적 가격 DB 가져오기 — 구글 시트 xlsx → 로컬 D1(price_*).
//
// 사용: node scripts/price-db-import.mjs ~/vanam-data/quote-db-v3.xlsx [--dry-run]
//
// ⚠️ 이 스크립트는 맥미니 로컬 D1 전용이다. 운영은 관리자 설정 탭의 [가격 DB 올리기]에서 올린다
//    (같은 검사 규칙 — src/lib/price-sheet.js — 을 브라우저·서버가 함께 쓴다).
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
import { TABLES, POLICY, readPriceWorkbook, priceRowsForDb, priceFingerprint } from '../src/lib/price-sheet.js';

const DB_NAME = 'vanam-orders';
const OUT_SQL = resolve(homedir(), 'vanam-data/out/price-db.sql');

// 시트 → 테이블 사상·검사 규칙은 src/lib/price-sheet.js (관리자 화면과 공용).

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

  // 값은 priceRowsForDb 하나로 정한다(서버 INSERT 와 같음): 빈칸 NULL · 불리언 1/0 · 나머지 sqlLit
  const db = priceRowsForDb(data);
  const insert = (table) => {
    const { cols, rows } = db[table];
    if (rows.length === 0) return;
    L.push(`-- ${table} (${rows.length}행)`);
    for (const vals of rows) {
      L.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.map((v) => (v === null ? 'NULL' : sqlLit(v))).join(', ')});`);
    }
    L.push('');
  };

  for (const spec of TABLES) insert(spec.table);
  insert(POLICY.table);
  return L.join('\n') + '\n';
}

// ── 본체 ───────────────────────────────────────────────────────────────────
async function main() {
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

  const { data, problems } = readPriceWorkbook(wb);

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

  const fingerprint = await priceFingerprint(priceRowsForDb(data));
  if (dryRun) {
    console.log(`데이터 지문: ${fingerprint.slice(0, 12)}`);
    console.log('--dry-run: D1 적용을 건너뜁니다.');
    return;
  }

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
  console.log(`데이터 지문: ${fingerprint.slice(0, 12)}`);
  console.log('완료.');
}

await main();
