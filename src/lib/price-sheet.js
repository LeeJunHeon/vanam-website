// 견적 가격 DB 시트 규칙 — 공용(브라우저·워커·node). node: 모듈·SQL 문자열을 넣지 않는다.
//
//   readPriceWorkbook(wb)   엑셀(xlsx-core 워크북) → { data, problems }  (맥미니 가져오기·관리자 화면 공용)
//   validatePriceData(data) 서버가 JSON 으로 받은 data 를 다시 검사 → { problems }
//   priceRowsForDb(data)    표마다 { cols, rows(값 배열) } — 가져오기 SQL 과 서버 INSERT 가 이 값 하나를 쓴다
//   insertChunks(rows, n)   INSERT 한 문장당 자리표시자 100개 이하가 되게 행을 묶는다(D1 바인딩 한도)
//   priceFingerprint(rows)  데이터 지문(sha256) — 엑셀에서 만든 값과 D1 에서 다시 읽은 값이 같으면 같다
//   priceDiff(cur, next)    표마다 추가·삭제·변경 개수와 ID·바뀐 열 이름(값은 넣지 않는다)
//
// ⚠️ 원가 데이터를 다룬다. 문제 문구·비교 결과는 관리자 화면 전용이다(고객 응답·로그에 쓰지 않는다).

// ── 시트 → 테이블 사상 ─────────────────────────────────────────────────────
// col: 엑셀 헤더 이름 = D1 컬럼 이름(같게 유지 — 이름이 갈리면 대조가 불가능해진다)
// kind: 'text' | 'num' | 'bool'  (검사 규칙과 DB 값 방식을 함께 결정)
const T = (name) => ({ name, kind: 'text' });
const N = (name) => ({ name, kind: 'num' });
const B = (name) => ({ name, kind: 'bool' });

export const TABLES = [
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
export const POLICY = {
  table: 'price_policy', sheet: 'V3_가격정책', id: 'key',
  cols: [T('key'), T('value'), T('vtype'), T('applies_to'), T('notes')],
};

// 계산 엔진이 반드시 필요로 하는 키. V3_계산!B30 의 정책 상태 검사와 같은 목록이다.
export const REQUIRED_POLICY_KEYS = [
  'default_tax_rate', 'markup_default', 'markup_research', 'markup_special',
  'material_charge_basis_nm', 'material_tier1_limit', 'material_tier1_amount',
  'material_tier2_limit', 'material_tier2_amount', 'film_rounding_unit',
  'direct_price_markup_enabled', 'direct_price_rounding', 'film_unit_price_rounding', 'currency',
];

/** 지문·비교·서버 검사의 표 순서(고정) */
export const PRICE_TABLE_ORDER = ['price_policy', 'price_equipment', 'price_recipe', 'price_substrate', 'price_alias'];
const SPEC = Object.fromEntries([POLICY, ...TABLES].map((s) => [s.table, s]));

export const MAX_TEXT = 4000;
// 표당 최대 행. 올리기(apply)는 batch 하나에 DELETE 5 + INSERT 묶음 + 기록 1 을 담는다.
// INSERT 한 문장당 자리표시자 ≤100(insertChunks)이라 표마다 ceil(행 ÷ floor(100 ÷ 열 수)) 문장 —
// 지금 스펙(열 5·9·16·14·6)으로 5표 모두 500행이면 25+46+84+72+32 = 259 → 합계 265 문장.
// 2000행이면 1,033 문장으로 요청당 Cloudflare 내부 호출 1,000번을 넘는다 → 500 으로 둔다.
// (scripts/test-price-sheet.mjs 가 스펙 열 수로 최악 문장 수를 다시 계산해 1,000 안쪽인지 본다)
export const MAX_ROWS = 500;

const isBlank = (v) => v === null || v === undefined || v === '';

// ── 엑셀 읽기·검사 ─────────────────────────────────────────────────────────
/** 글자 칸 길이 검사 */
function checkLength(bad, where, col, v) {
  if (typeof v === 'string' && v.length > MAX_TEXT) bad(`${where}: ${col} 이 ${MAX_TEXT}자를 넘습니다 (${v.length}자)`);
}

/**
 * 시트를 레코드 배열로 읽고 검사한다.
 * @param {any} wb xlsx-core 워크북
 * @param {(typeof TABLES)[number]} spec
 * @param {(msg: string) => void} bad
 */
function readTable(wb, spec, bad) {
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
      checkLength(bad, `${spec.sheet} ${r}행`, col.name, v);
    }
    if (spec.id) {
      const id = rec[spec.id];
      if (isBlank(id)) bad(`${spec.sheet} ${r}행: ${spec.id} 가 비어 있습니다`);
      else if (seen.has(id)) bad(`${spec.sheet} ${r}행: ${spec.id} 중복 → ${id} (${seen.get(id)}행과 같음)`);
      else seen.set(id, r);
    }
  }
  if (rows.length === 0) bad(`${spec.sheet}: 데이터 행이 없습니다`);
  if (rows.length > MAX_ROWS) bad(`${spec.sheet}: 데이터 행이 ${rows.length}개입니다 (최대 ${MAX_ROWS}개)`);
  return rows;
}

/** 가격 정책 시트 → [{key, value, vtype, applies_to, notes}] */
function readPolicy(wb, bad) {
  const sheet = wb.sheet(POLICY.sheet);
  const head = [1, 2, 3, 4].map((c) => String(sheet.at(1, c) ?? '').trim());
  const want = ['policy_key', 'policy_value', 'applies_to', 'notes'];
  if (head.join('|') !== want.join('|')) bad(`${POLICY.sheet}: 헤더가 기대와 다릅니다 → ${head.join(', ')}`);

  const rows = [];
  const count = new Map();
  const firstRow = new Map();
  for (let r = 2; r <= sheet.maxRow; r++) {
    const key = sheet.at(r, 1);
    const raw = sheet.at(r, 2);
    if (isBlank(key) && isBlank(raw)) continue;
    if (isBlank(key)) { bad(`${POLICY.sheet} ${r}행: policy_key 가 비어 있습니다`); continue; }
    const k = String(key).trim();
    count.set(k, (count.get(k) ?? 0) + 1);
    // 정책 key 는 표의 PRIMARY KEY — 필수 키가 아니어도 두 번 나오면 적용이 실패한다
    if (firstRow.has(k)) bad(`${POLICY.sheet} ${r}행: policy_key 중복 → ${k} (${firstRow.get(k)}행과 같음)`);
    else firstRow.set(k, r);
    const vtype = typeof raw === 'boolean' ? 'boolean' : typeof raw === 'number' ? 'number' : 'string';
    const value = vtype === 'boolean' ? (raw ? 'TRUE' : 'FALSE') : raw === null ? null : String(raw);
    const rec = { key: k, value, vtype, applies_to: sheet.at(r, 3), notes: sheet.at(r, 4) };
    for (const c of ['key', 'value', 'applies_to', 'notes']) checkLength(bad, `${POLICY.sheet} ${r}행`, c, rec[c]);
    rows.push(rec);
  }
  for (const k of REQUIRED_POLICY_KEYS) {
    const n = count.get(k) ?? 0;
    if (n !== 1) bad(`${POLICY.sheet}: 필수 키 "${k}" 가 ${n}번 있습니다 (정확히 1번이어야 합니다)`);
  }
  if (rows.length > MAX_ROWS) bad(`${POLICY.sheet}: 데이터 행이 ${rows.length}개입니다 (최대 ${MAX_ROWS}개)`);
  return rows;
}

/**
 * 엑셀 워크북 → 가격 DB 데이터. 시트가 없으면 예외 대신 문제로 돌려준다.
 * @param {any} wb xlsx-core openWorkbook / openXlsxWeb / xlsx-lite openXlsx 결과
 * @returns {{data: Record<string, Record<string, unknown>[]>, problems: string[]}}
 */
export function readPriceWorkbook(wb) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  const names = Array.isArray(wb?.sheetNames) ? wb.sheetNames : [];
  const data = {};
  const read = (spec, fn) => {
    if (!names.includes(spec.sheet)) {
      bad(`${spec.sheet}: 시트가 없습니다 (있는 시트: ${names.join(', ')})`);
      data[spec.table] = [];
      return;
    }
    data[spec.table] = fn();
  };
  for (const spec of TABLES) read(spec, () => readTable(wb, spec, bad));
  read(POLICY, () => readPolicy(wb, bad));
  return { data, problems };
}

// ── 서버 재검사 ────────────────────────────────────────────────────────────
const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * JSON 으로 받은 가격 DB 데이터를 다시 검사한다(브라우저 검사를 믿지 않는다).
 * @param {unknown} data
 * @returns {{problems: string[]}}
 */
export function validatePriceData(data) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  if (!isPlainObj(data)) return { problems: ['데이터가 객체가 아닙니다'] };
  for (const k of Object.keys(data)) if (!SPEC[k]) bad(`알 수 없는 표: ${k}`);

  for (const table of PRICE_TABLE_ORDER) {
    const spec = SPEC[table];
    const rows = data[table];
    if (rows === undefined) { bad(`${table}: 표가 없습니다`); continue; }
    if (!Array.isArray(rows)) { bad(`${table}: 배열이 아닙니다`); continue; }
    if (rows.length === 0) { bad(`${table}: 데이터 행이 없습니다`); continue; }
    if (rows.length > MAX_ROWS) { bad(`${table}: 데이터 행이 ${rows.length}개입니다 (최대 ${MAX_ROWS}개)`); continue; }

    const colNames = spec.cols.map((c) => c.name);
    const seen = new Map();
    rows.forEach((rec, i) => {
      const where = `${table} ${i + 1}번째 행`;
      if (!isPlainObj(rec)) { bad(`${where}: 객체가 아닙니다`); return; }
      for (const k of Object.keys(rec)) if (!colNames.includes(k)) bad(`${where}: 모르는 열 "${k}"`);
      for (const col of spec.cols) {
        const v = rec[col.name];
        if (isBlank(v)) continue;
        if (col.kind === 'text' && !['string', 'number', 'boolean'].includes(typeof v)) bad(`${where}: ${col.name} 형식이 잘못됐습니다`);
        if (col.kind === 'text' && typeof v === 'number' && !Number.isFinite(v)) bad(`${where}: ${col.name} 이 유한한 숫자가 아닙니다`);
        if (col.kind === 'num' && (typeof v !== 'number' || !Number.isFinite(v))) bad(`${where}: ${col.name} 이 숫자가 아닙니다 → ${JSON.stringify(v)}`);
        if (col.kind === 'bool' && typeof v !== 'boolean') bad(`${where}: ${col.name} 이 TRUE/FALSE 가 아닙니다 → ${JSON.stringify(v)}`);
        checkLength(bad, where, col.name, v);
      }
      if (table === 'price_policy') {
        if (!['boolean', 'number', 'string'].includes(rec.vtype)) bad(`${where}: vtype 이 boolean·number·string 이 아닙니다`);
        if (!(rec.value === null || rec.value === undefined || typeof rec.value === 'string')) bad(`${where}: value 는 문자열이어야 합니다`);
      }
      if (spec.id) {
        const id = rec[spec.id];
        if (isBlank(id)) bad(`${where}: ${spec.id} 가 비어 있습니다`);
        else if (typeof id !== 'string' && typeof id !== 'number') bad(`${where}: ${spec.id} 형식이 잘못됐습니다`);
        else if (seen.has(String(id))) bad(`${where}: ${spec.id} 중복 → ${id} (${seen.get(String(id))}번째 행과 같음)`);
        else seen.set(String(id), i + 1);
      }
    });
    if (table === 'price_policy') {
      for (const k of REQUIRED_POLICY_KEYS) {
        const n = rows.filter((r) => isPlainObj(r) && r.key === k).length;
        if (n !== 1) bad(`price_policy: 필수 키 "${k}" 가 ${n}번 있습니다 (정확히 1번이어야 합니다)`);
      }
    }
  }
  return { problems };
}

// ── DB 값 ──────────────────────────────────────────────────────────────────
/** 한 칸 → DB 값: 빈칸 null · 불리언 1/0(열 종류와 상관없이, sqlLit 과 같음) · 나머지 원래 값 */
const dbValue = (v) => (isBlank(v) ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

/**
 * 표마다 { cols, rows(값 배열) }. 가져오기 SQL 과 서버 INSERT 가 이것 하나를 쓴다.
 * D1 에서 다시 읽은 레코드(readPriceTables)에도 그대로 쓸 수 있다(지문 비교용).
 * @param {Record<string, Record<string, unknown>[]>} data
 * @returns {Record<string, {cols: string[], rows: unknown[][]}>}
 */
export function priceRowsForDb(data) {
  const out = {};
  for (const table of PRICE_TABLE_ORDER) {
    const cols = SPEC[table].cols.map((c) => c.name);
    const recs = Array.isArray(data?.[table]) ? data[table] : [];
    out[table] = { cols, rows: recs.map((rec) => cols.map((c) => dbValue(rec?.[c]))) };
  }
  return out;
}

/**
 * INSERT 한 문장의 자리표시자가 maxParams 이하가 되게 행을 묶는다.
 * @template R @param {R[]} rows @param {number} colCount @param {number} [maxParams]
 * @returns {R[][]}
 */
export function insertChunks(rows, colCount, maxParams = 100) {
  const per = Math.max(1, Math.floor(maxParams / Math.max(1, colCount)));
  const out = [];
  for (let i = 0; i < rows.length; i += per) out.push(rows.slice(i, i + per));
  return out;
}

// ── 지문·비교 ──────────────────────────────────────────────────────────────
/** 비교용 정규화 — null·'' → null · text → 문자열 · num → 숫자 · bool → 1/0 */
function norm(kind, v) {
  if (v === null || v === undefined || v === '') return null;
  if (kind === 'text') return typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  if (kind === 'num') return Number(v);
  return v === true || v === 1 || v === '1' ? 1 : 0;
}

/** 표 하나 → 스펙 열 순서의 정규화 배열들 */
function normRows(table, t) {
  const spec = SPEC[table];
  const cols = Array.isArray(t?.cols) ? t.cols : [];
  const idx = spec.cols.map((c) => cols.indexOf(c.name));
  return (Array.isArray(t?.rows) ? t.rows : []).map((row) =>
    spec.cols.map((c, i) => norm(c.kind, idx[i] >= 0 ? row?.[idx[i]] : null)));
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * 데이터 지문 — sha256 16진수 64자. 표 순서·열 순서 고정, 행은 정렬(순서 무관), alias 의 자동 id 는 넣지 않는다.
 * @param {Record<string, {cols: string[], rows: unknown[][]}>} rowsByTable priceRowsForDb 결과
 * @returns {Promise<string>}
 */
export async function priceFingerprint(rowsByTable) {
  const payload = PRICE_TABLE_ORDER.map((table) => [
    table,
    normRows(table, rowsByTable?.[table]).map((r) => JSON.stringify(r)).sort(),
  ]);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

const DIFF_ID_LIMIT = 30;

/**
 * 지금 DB 와 새 데이터 비교 — 개수와 ID·바뀐 열 이름만(값은 넣지 않는다).
 * @param {Record<string, {cols: string[], rows: unknown[][]}>} current
 * @param {Record<string, {cols: string[], rows: unknown[][]}>} next
 */
export function priceDiff(current, next) {
  const out = {};
  for (const table of PRICE_TABLE_ORDER) {
    const spec = SPEC[table];
    const a = normRows(table, current?.[table]);
    const b = normRows(table, next?.[table]);
    const res = { added: 0, removed: 0, changed: 0, ids: { added: [], removed: [], changed: [] } };
    if (!spec.id) {
      // 별칭 — 행 전체가 키(여러 벌 가능)라 개수만
      const bag = new Map();
      for (const r of a) { const k = JSON.stringify(r); bag.set(k, (bag.get(k) ?? 0) + 1); }
      for (const r of b) {
        const k = JSON.stringify(r);
        if ((bag.get(k) ?? 0) > 0) bag.set(k, bag.get(k) - 1);
        else res.added++;
      }
      for (const n of bag.values()) res.removed += n;
      out[table] = res;
      continue;
    }
    const ki = spec.cols.findIndex((c) => c.name === spec.id);
    const am = new Map(a.map((r) => [String(r[ki]), r]));
    const bm = new Map(b.map((r) => [String(r[ki]), r]));
    for (const [id, r] of bm) {
      const old = am.get(id);
      if (!old) {
        res.added++;
        if (res.ids.added.length < DIFF_ID_LIMIT) res.ids.added.push(id);
        continue;
      }
      const cols = spec.cols.filter((c, i) => JSON.stringify(old[i]) !== JSON.stringify(r[i])).map((c) => c.name);
      if (cols.length) {
        res.changed++;
        if (res.ids.changed.length < DIFF_ID_LIMIT) res.ids.changed.push({ id, cols });
      }
    }
    for (const id of am.keys()) {
      if (bm.has(id)) continue;
      res.removed++;
      if (res.ids.removed.length < DIFF_ID_LIMIT) res.ids.removed.push(id);
    }
    out[table] = res;
  }
  return out;
}
