// scripts/check-schema.mjs — D1 스키마 3원 정합 검증 (0249, 재발 방지 가드레일)
//
// 왜 있는가: inquiries.details_json / quote_bank 는 코드가 항상 쓰는 컬럼인데
// 초기 SQL(migrations/0001_init.sql)·런타임 SCHEMA·런타임 MIGRATIONS 어디에도 없었다.
// 운영 DB에는 수동으로 넣어둔 상태라 정상 동작했지만, DB를 새로 만들면
// 폴백 경로가 "구조화 사본 없이 / 계좌 없이" 조용히 데이터를 버린다(재현 불가 지뢰).
// → 세 저장소와 코드 사용처가 어긋나면 verify 단계에서 빌드를 멈춘다.
//
// 검사 3종:
//   ① 코드의 INSERT/UPDATE/SELECT 컬럼 참조 ⊆ 런타임 스키마(SCHEMA ∪ MIGRATIONS)
//   ② migrations/0001_init.sql 의 테이블·컬럼 집합 == 런타임 스키마 (완전 일치)
//   ③ MIGRATIONS 의 ALTER 대상 테이블이 SCHEMA 에 존재
// 한계(정직하게): 문자열 변수로 조립된 쿼리(예: inquiry.ts 의 COLS)는 정적으로 다 못 읽는다.
// 그런 컬럼은 아래 REQUIRED 에 명시해 고정한다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let bad = 0;
const fail = (msg) => { console.error('  ✗', msg); bad++; };

// ── 템플릿 조립 쿼리가 쓰는 컬럼 (정적 파서 사각지대 명시 고정) ────────────
const REQUIRED = { inquiries: ['details_json', 'quote_bank'] };

// ── SQL 파서 (우리 코드 서식 전용 — 이상하면 통과 대신 실패) ───────────────
function splitTop(s) {
  // 괄호 깊이 0 의 콤마로만 분리 (FOREIGN KEY(...) REFERENCES t(...) 대응)
  const out = []; let d = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') d++;
    if (ch === ')') d--;
    if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
const KEYWORD = /^(FOREIGN|PRIMARY|UNIQUE|CHECK|CONSTRAINT)\b/i;
function parseCreate(sql, into) {
  const m = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) { fail(`CREATE 파싱 실패: ${sql.slice(0, 60)}…`); return; }
  const [, tbl, body] = m;
  into[tbl] ||= new Set();
  for (const seg of splitTop(body)) {
    if (KEYWORD.test(seg)) continue;
    const col = seg.match(/^(\w+)/)?.[1];
    if (col) into[tbl].add(col);
  }
}

// ── ① 런타임 스키마: src/lib/db.ts 의 SCHEMA ∪ MIGRATIONS ────────────────
const dbSrc = readFileSync('src/lib/db.ts', 'utf8');
function grabStmts(name) {
  const m = dbSrc.match(new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`));
  if (!m) { fail(`db.ts 에서 ${name} 배열을 찾지 못함`); return []; }
  return [...m[1].matchAll(/`([\s\S]*?)`/g)].map((x) => x[1]);
}
const runtime = {};
for (const sql of grabStmts('SCHEMA')) {
  if (/^\s*CREATE TABLE/i.test(sql)) parseCreate(sql, runtime);
  else if (!/^\s*CREATE INDEX/i.test(sql)) fail(`SCHEMA 에 알 수 없는 문장: ${sql.slice(0, 50)}…`);
}
for (const sql of grabStmts('MIGRATIONS')) {
  const m = sql.match(/^\s*ALTER TABLE (\w+) ADD COLUMN (\w+)/);
  if (!m) { fail(`MIGRATIONS 파싱 실패: ${sql.slice(0, 60)}…`); continue; }
  const [, tbl, col] = m;
  if (!runtime[tbl]) fail(`MIGRATIONS 가 SCHEMA 에 없는 테이블을 수정: ${tbl}`); // ③
  (runtime[tbl] ||= new Set()).add(col);
}

// ── ② migrations/0001_init.sql 완전 일치 ────────────────────────────────
const initSql = readFileSync('migrations/0001_init.sql', 'utf8')
  .replace(/--[^\n]*/g, ''); // 행 전체·행 끝 주석 모두 제거 (행 끝 주석이 다음 컬럼을 삼키는 오탐 방지)
const init = {};
for (const stmt of initSql.split(';')) {
  if (/CREATE TABLE IF NOT EXISTS/i.test(stmt)) parseCreate(stmt + ';', init);
}
for (const tbl of Object.keys(runtime)) {
  if (!init[tbl]) { fail(`init.sql 에 테이블 없음: ${tbl}`); continue; }
  for (const c of runtime[tbl]) if (!init[tbl].has(c)) fail(`init.sql ${tbl} 에 컬럼 없음: ${c}`);
  for (const c of init[tbl]) if (!runtime[tbl].has(c)) fail(`init.sql ${tbl} 에만 있는 컬럼(런타임엔 없음): ${c}`);
}
for (const tbl of Object.keys(init)) if (!runtime[tbl]) fail(`init.sql 에만 있는 테이블: ${tbl}`);

// ── ①' 코드 사용처 수집: src/**/*.ts 의 평문 SQL ─────────────────────────
const files = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.ts')) files.push(p);
  }
})('src');
let refs = 0;
const SYSTEM_TABLES = new Set(['sqlite_master']); // SQLite 내장 — 스키마 대상 아님
const assertCols = (tbl, names, where) => {
  if (SYSTEM_TABLES.has(tbl)) return;
  if (!runtime[tbl]) { fail(`${where}: 스키마에 없는 테이블 참조 ${tbl}`); return; }
  for (const c of names) { refs++; if (!runtime[tbl].has(c)) fail(`${where}: ${tbl}.${c} — 스키마에 없는 컬럼`); }
};
const lowIds = (s) => [...s.matchAll(/\b[a-z][a-z0-9_]*\b/g)].map((m) => m[0]);
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/INSERT INTO (\w+)\s*([\s\S]*?)VALUES/g))
    assertCols(m[1], lowIds(m[2]), f);
  for (const m of src.matchAll(/UPDATE (\w+)\s+SET([\s\S]*?)(?:WHERE|`)/g))
    assertCols(m[1], [...m[2].matchAll(/([a-z][a-z0-9_]*)\s*=/g)].map((x) => x[1]), f);
  for (const m of src.matchAll(/SELECT\s+([a-z][\w ,\n]*?)\s+FROM\s+(\w+)/g)) {
    if (m[1].includes('*') || m[1].includes('(')) continue;
    assertCols(m[2], lowIds(m[1]), f);
  }
}
for (const [tbl, names] of Object.entries(REQUIRED)) assertCols(tbl, names, 'REQUIRED(템플릿 조립 쿼리)');

if (bad) {
  console.error(`\n스키마 정합 실패 — ${bad}건. db.ts(SCHEMA·MIGRATIONS)와 migrations/0001_init.sql 을 일치시키세요.`);
  process.exit(1);
}
console.log(`✓ 스키마 정합 — 테이블 ${Object.keys(runtime).length}개 · 코드 컬럼 참조 ${refs}건 · init.sql 동기 확인`);
