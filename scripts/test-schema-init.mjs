// scripts/test-schema-init.mjs — 스키마 준비 절차(src/lib/schema-init.js) 테스트
//
// 가짜 콜백으로 호출 순서·횟수를 확인하고, 실제 src/lib/db.ts 의 SCHEMA·MIGRATIONS 를
// check-schema.mjs 처럼 텍스트로 읽어 요청당 D1 호출 수를 계산해 출력한다.
import { readFileSync } from 'node:fs';
import { runSchemaInit, schemaVersionOf, parseAlter } from '../src/lib/schema-init.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}

// ── 버전 ─────────────────────────────────────────────────────────────────────
{
  const a = ['CREATE TABLE a (x)', 'ALTER TABLE a ADD COLUMN y TEXT'];
  const v = schemaVersionOf(a);
  eq('버전: 같은 입력 같은 값', schemaVersionOf([...a]), v);
  eq('버전: 한 글자만 달라도 다른 값', schemaVersionOf(['CREATE TABLE a (y)', a[1]]) !== v, true);
  eq('버전: 문장 경계가 달라도 다른 값', schemaVersionOf(['CREATE TABLE a (x)ALTER TABLE a ADD COLUMN y TEXT']) !== v, true);
  eq('버전: 0 이상 2^32 미만 정수', [v, schemaVersionOf([]), schemaVersionOf(['가나다'])].every((x) => Number.isInteger(x) && x >= 0 && x < 2 ** 32), true);
  eq('버전: FNV-1a 알려진 값(빈 문자열 = 오프셋 기저)', schemaVersionOf([]), 0x811c9dc5);
  eq('버전: FNV-1a 알려진 값("a")', schemaVersionOf(['a']), 0xe40c292c);
}

// ── parseAlter ───────────────────────────────────────────────────────────────
eq('parseAlter', [parseAlter('ALTER TABLE orders ADD COLUMN ship_city TEXT'), parseAlter('  ALTER TABLE t ADD COLUMN c INTEGER NOT NULL DEFAULT 0'),
  parseAlter('ALTER TABLE t RENAME TO u'), parseAlter('CREATE TABLE x (a)'), parseAlter(null)],
[{ table: 'orders', column: 'ship_city' }, { table: 't', column: 'c' }, null, null, null]);

// ── 가짜 콜백 ────────────────────────────────────────────────────────────────
const SCHEMA = ['CREATE A', 'CREATE B', 'CREATE IDX'];
const MIG = ['ALTER TABLE t1 ADD COLUMN a TEXT', 'ALTER TABLE t1 ADD COLUMN b TEXT', 'ALTER TABLE t2 ADD COLUMN c TEXT', 'ODD STATEMENT'];
const V = 12345;
function fake({ marker = null, markerThrows = false, cols = { t1: ['a'], t2: [] }, colsThrow = [], execFail = {}, writeThrows = false } = {}) {
  const calls = [];
  const warns = [];
  const logs = [];
  const o = {
    schema: SCHEMA, migrations: MIG, version: V,
    readMarker: async () => { calls.push('read'); if (markerThrows) throw new Error('no such table: settings'); return marker; },
    writeMarker: async (v) => { calls.push(`write:${v}`); if (writeThrows) throw new Error('write failed'); },
    exec: async (sql) => { calls.push(`exec:${sql}`); if (execFail[sql]) throw new Error(execFail[sql]); },
    tableColumns: async (t) => { calls.push(`cols:${t}`); if (colsThrow.includes(t)) throw new Error('pragma failed'); return new Set(cols[t] ?? []); },
    warn: (...a) => warns.push(a.map(String).join(' ')),
    log: (m) => logs.push(m),
  };
  return { o, calls, warns, logs };
}

{
  const f = fake({ marker: V });
  const r = await runSchemaInit(f.o);
  eq('표식 같음 → skip', r, { mode: 'skip', created: 0, added: 0, clean: true });
  eq('표식 같음 → readMarker 외 호출 0 · 로그 없음', [f.calls, f.logs.length], [['read'], 0]);
}
for (const [label, opt] of [['표식 null', { marker: null }], ['표식 다름', { marker: 999 }], ['readMarker 예외', { markerThrows: true }]]) {
  const f = fake(opt);
  const r = await runSchemaInit(f.o);
  eq(`${label} → full · 없는 컬럼만 ALTER · 표식 1번`, f.calls, [
    'read', 'exec:CREATE A', 'exec:CREATE B', 'exec:CREATE IDX', 'cols:t1', 'cols:t2',
    'exec:ALTER TABLE t1 ADD COLUMN b TEXT', 'exec:ALTER TABLE t2 ADD COLUMN c TEXT', 'exec:ODD STATEMENT', `write:${V}`,
  ]);
  eq(`${label} → 결과 · 로그 한 줄`, [r, f.logs], [{ mode: 'full', created: 3, added: 3, clean: true },
    [`[schema] 전체 점검 — v${V.toString(16)} · 생성 3 · 컬럼 추가 3 · 컬럼 확인 2/2`]]);
}
{
  const f = fake({ execFail: { 'CREATE B': 'disk full' } });
  let err = null;
  try { await runSchemaInit(f.o); } catch (e) { err = e.message; }
  eq('CREATE 실패 → reject · 표식 안 씀 · 뒤 문장 없음', [err, f.calls.some((c) => c.startsWith('write')), f.calls.includes('exec:CREATE IDX')], ['disk full', false, false]);
}
{
  const f = fake({ colsThrow: ['t1'], execFail: { 'ALTER TABLE t1 ADD COLUMN a TEXT': 'duplicate column name: a' } });
  const r = await runSchemaInit(f.o);
  eq('tableColumns 실패한 표 → 그 표 ALTER 전부 · duplicate 는 정상 · 표식 씀', [
    f.calls.filter((c) => c.startsWith('exec:ALTER TABLE t1')).length, r.clean, f.calls.at(-1), f.warns.length, r.added,
  ], [2, true, `write:${V}`, 0, 3]);
  eq('컬럼 확인 1/2 로그', f.logs[0].endsWith('컬럼 확인 1/2'), true);
}
{
  const f = fake({ cols: { t1: [], t2: [] }, execFail: { 'ALTER TABLE t1 ADD COLUMN a TEXT': 'duplicate column name: a' } });
  const r = await runSchemaInit(f.o);
  eq('ALTER duplicate → 표식 씀', [r.clean, f.calls.includes(`write:${V}`), f.warns.length], [true, true, 0]);
}
{
  const f = fake({ execFail: { 'ALTER TABLE t2 ADD COLUMN c TEXT': 'syntax error' } });
  const r = await runSchemaInit(f.o);
  eq('ALTER 다른 오류 → warn · 표식 안 씀 · 뒤 문장 계속 · resolve', [r.clean, f.calls.some((c) => c.startsWith('write')), f.warns.length,
    f.warns[0]?.startsWith('[ensureSchema] 마이그레이션 실패(무시하지 않음):'), f.calls.includes('exec:ODD STATEMENT')], [false, false, 1, true, true]);
}
{
  const f = fake({ writeThrows: true });
  const r = await runSchemaInit(f.o);
  eq('writeMarker 실패 → warn · resolve', [r.mode, f.warns.length], ['full', 1]);
}

// ── 실제 db.ts ───────────────────────────────────────────────────────────────
const dbSrc = readFileSync('src/lib/db.ts', 'utf8');
const grab = (name) => {
  const m = dbSrc.match(new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`));
  return m ? [...m[1].matchAll(/`([\s\S]*?)`/g)].map((x) => x[1]) : [];
};
const S = grab('SCHEMA');
const M = grab('MIGRATIONS');
eq('db.ts: SCHEMA·MIGRATIONS 읽힘', [S.length > 0, M.length > 0], [true, true]);
eq('db.ts: MIGRATIONS 전부 parseAlter 로 읽힘', M.filter((s) => !parseAlter(s)), []);
const tables = [...new Set(M.map((s) => parseAlter(s)?.table).filter(Boolean))];
const warm = 1;
const firstFull = 1 + S.length + tables.length + 1;
const firstEmpty = 1 + S.length + tables.length + M.length + 1;
eq('db.ts: 표식 맞음 D1 1번 · 컬럼 다 있는 첫 점검 ≤ 25번', [warm, firstFull <= 25], [1, true]);

if (failed) {
  console.error(`\n스키마 준비(schema-init) 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 스키마 준비(schema-init) — ${total}건 통과 · CREATE ${S.length} · ALTER ${M.length}(표 ${tables.join('·')}) · ` +
  `D1 호출: 표식 맞음 ${warm} / 컬럼 다 있는 DB 첫 점검 ${firstFull} / 빈 DB 첫 점검 ${firstEmpty} (예전 ${S.length + M.length})`);
