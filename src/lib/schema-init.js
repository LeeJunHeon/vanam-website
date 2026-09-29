// 스키마 준비(ensureSchema) 절차 — 순수 모듈. SQL 문자열은 넣지 않는다(db.ts 가 콜백으로 준다).
//
// 왜 있는가: Workers 무료 플랜은 요청 1번에 D1 쿼리 + 외부 fetch 를 합쳐 50번까지만 된다.
// 예전 ensureSchema 는 새 인스턴스마다 CREATE 18 + ALTER 25 = 43번을 먼저 실행해,
// 콜드 인스턴스로 간 무거운 요청(자동 견적 접수 등)이 한도를 넘겨 뒤쪽 호출이 전부 실패했다.
//
//   1) settings 의 schema_version 표식이 이 코드의 스키마 버전과 같으면 끝(D1 1번).
//   2) 다르면(배포 직후·새 DB) 전체 점검: CREATE 전부 → ALTER 대상 표마다 컬럼 목록 1번 → 없는 컬럼만 ALTER.
//   3) 깨끗하게 끝났을 때만 표식을 쓴다 — 실패가 있으면 다음 인스턴스가 다시 시도하고 로그에 계속 드러난다.

const SEP = '\n\u0000\n';

/**
 * 스키마 문장들의 버전 — FNV-1a 32비트(부호 없는 정수). settings.value 가 REAL 이라 숫자로 저장한다.
 * @param {string[]} statements
 * @returns {number}
 */
export function schemaVersionOf(statements) {
  const s = (Array.isArray(statements) ? statements : []).map(String).join(SEP);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * ALTER TABLE t ADD COLUMN c … → { table, column } (scripts/check-schema.mjs 와 같은 규칙). 못 읽으면 null.
 * @param {string} sql
 */
export function parseAlter(sql) {
  const m = /^\s*ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(String(sql ?? ''));
  return m ? { table: m[1], column: m[2] } : null;
}

const isDuplicate = (e) => /duplicate column/i.test(String(e?.message ?? e));

/**
 * @param {{
 *   schema: string[], migrations: string[], version: number,
 *   readMarker: () => Promise<number|null>, writeMarker: (v: number) => Promise<void>,
 *   exec: (sql: string) => Promise<unknown>, tableColumns: (table: string) => Promise<Set<string>>,
 *   warn: (...a: unknown[]) => void, log: (msg: string) => void,
 * }} o
 * @returns {Promise<{mode: 'skip'|'full', created: number, added: number, clean: boolean}>}
 */
export async function runSchemaInit(o) {
  let marker = null;
  try {
    marker = await o.readMarker();
  } catch {
    marker = null; // settings 표가 없는 새 DB 등 — 전체 점검
  }
  if (marker === o.version) return { mode: 'skip', created: 0, added: 0, clean: true };

  // CREATE — 실패하면 그대로 던진다(지금과 같다)
  let created = 0;
  for (const sql of o.schema) {
    await o.exec(sql);
    created++;
  }

  // ALTER 대상 표마다 컬럼 목록 한 번. 실패한 표는 '모름'(null) → 그 표의 ALTER 는 전부 실행
  const tables = [];
  for (const sql of o.migrations) {
    const p = parseAlter(sql);
    if (p && !tables.includes(p.table)) tables.push(p.table);
  }
  const cols = new Map();
  let known = 0;
  for (const t of tables) {
    try {
      cols.set(t, await o.tableColumns(t));
      known++;
    } catch {
      cols.set(t, null);
    }
  }

  let added = 0;
  let clean = true;
  for (const sql of o.migrations) {
    const p = parseAlter(sql);
    const have = p ? cols.get(p.table) : null;
    if (p && have && have.has(p.column)) continue;
    try {
      await o.exec(sql);
      added++;
    } catch (e) {
      // 컬럼이 이미 있으면(duplicate column) 정상 경로 — 그 외 실패는 조용히 삼키지 않는다.
      // (0249: ALTER 오타가 소리 없이 무시되어 스키마가 어긋나는 것을 로그로 드러낸다.
      //  가용성 원칙은 유지 — 경고만 남기고 서비스는 계속 간다)
      if (!isDuplicate(e)) {
        o.warn('[ensureSchema] 마이그레이션 실패(무시하지 않음):', sql, e);
        clean = false;
      }
    }
  }

  if (clean) {
    try {
      await o.writeMarker(o.version);
    } catch (e) {
      o.warn('[ensureSchema] 스키마 버전 표식 저장 실패(다음 인스턴스가 다시 점검):', e);
    }
  }
  o.log(`[schema] 전체 점검 — v${o.version.toString(16)} · 생성 ${created} · 컬럼 추가 ${added} · 컬럼 확인 ${known}/${tables.length}`);
  return { mode: 'full', created, added, clean };
}
