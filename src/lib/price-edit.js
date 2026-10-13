// 가격 DB 편집(관리자 /admin/price) — 순수 모듈(브라우저·워커·node 공용, SQL 없음).
//
// 10-12 사용자 결정: 처음에는 엑셀을 올려 채우고, 그 뒤 수정·추가는 관리자 화면에서 한다.
//   · 행 삭제는 없다 — 장비·레시피·기판은 '사용함/사용 안 함'(active)으로만 끈다(예전 견적이 참조하던 행이 사라지지 않게).
//   · 정책·별칭은 active 열이 없어 수정·추가만.
//   · 한 행을 고치면 그 행을 끼운 '전체 데이터'를 엑셀 올리기와 같은 검사(validatePriceData)로 다시 본다
//     → ID 중복·필수 정책 키·숫자 칸·글자 길이 규칙이 엑셀 올리기와 똑같다.
//   · 두 사람이 같은 행을 고치면: 불러올 때의 행(before)이 지금 DB 행과 다르면 저장하지 않는다(sameRow).
//
// ⚠️ 원가 데이터를 다룬다 — 관리자 화면 전용. 로그·구글챗에 값을 남기지 않는다.
import { TABLES, POLICY, PRICE_TABLE_ORDER, validatePriceData } from './price-sheet.js';

/** 표 이름(화면) — 엑셀 시트 순서와 같게 */
export const EDIT_TABLES = [
  { table: 'price_policy', label: '가격정책', sheet: POLICY.sheet },
  { table: 'price_equipment', label: '장비', sheet: 'V3_장비DB' },
  { table: 'price_recipe', label: '레시피', sheet: 'V3_레시피DB' },
  { table: 'price_substrate', label: '상품·기판', sheet: 'V3_상품기판DB' },
  { table: 'price_alias', label: '별칭', sheet: 'V3_별칭DB' },
];

const SPEC = Object.fromEntries([POLICY, ...TABLES].map((s) => [s.table, s]));
/** 정책의 값 종류 */
export const VTYPES = ['number', 'boolean', 'string'];

/**
 * 표 하나의 편집 규칙.
 * @param {string} table
 * @returns {{ table: string, id: string, cols: {name: string, kind: 'text'|'num'|'bool'}[], hasActive: boolean, aliasId: boolean } | null}
 *   id = 행을 가리키는 열(별칭은 DB 자동 번호 'id' — 엑셀에는 없다)
 */
export function editSpec(table) {
  const s = SPEC[table];
  if (!s) return null;
  return {
    table,
    id: s.id ?? 'id',
    cols: s.cols,
    hasActive: s.cols.some((c) => c.name === 'active'),
    aliasId: !s.id,
  };
}

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
/** 숫자 글자 → 숫자. 10진수(쉼표·지수 허용)만 — '0x1F' 같은 건 NaN */
const toNum = (v) => {
  const t = String(v).trim().replace(/,/g, '');
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) ? Number(t) : NaN;
};

/**
 * 화면·요청에서 온 한 행 → 저장할 값(열 종류에 맞춘다). 문제는 목록으로.
 *   text: 키 열만 앞뒤 공백 제거(다른 칸은 엑셀 값 그대로 — 다른 칸을 고칠 때 메모의 공백이 바뀌지 않게) · 공백뿐이면 null
 *   num : 숫자(문자열 숫자도 · 쉼표 허용 · 16진수 같은 모양은 거절) · 비우면 null · 숫자가 아니면 문제
 *   bool: true/false(1/0·'TRUE'/'FALSE' 도) · 비우면 null
 *   정책: value 는 문자열로, vtype 은 number·boolean·string — number 면 숫자, boolean 이면 TRUE/FALSE 여야 한다.
 * @param {string} table @param {Record<string, unknown>} input
 * @returns {{ row: Record<string, unknown>, problems: string[] }}
 */
export function rowFromInput(table, input) {
  const spec = editSpec(table);
  const problems = [];
  if (!spec) return { row: {}, problems: [`알 수 없는 표: ${table}`] };
  const src = input && typeof input === 'object' ? input : {};
  const row = {};
  for (const col of spec.cols) {
    const v = src[col.name];
    if (isBlank(v)) { row[col.name] = null; continue; }
    if (col.kind === 'num') {
      const n = typeof v === 'number' ? v : toNum(v);
      if (!Number.isFinite(n)) problems.push(`${col.name}: 숫자를 입력해 주세요`);
      row[col.name] = Number.isFinite(n) ? n : null;
    } else if (col.kind === 'bool') {
      const t = String(v).trim().toUpperCase();
      if (v === true || v === 1 || t === 'TRUE' || t === '1') row[col.name] = true;
      else if (v === false || v === 0 || t === 'FALSE' || t === '0') row[col.name] = false;
      else { problems.push(`${col.name}: TRUE 또는 FALSE 여야 합니다`); row[col.name] = null; }
    } else {
      const t = typeof v === 'string' ? v : String(v);
      row[col.name] = col.name === spec.id ? t.trim() : t;
    }
  }
  if (table === 'price_policy') {
    const vt = String(src.vtype ?? '').trim();
    row.vtype = VTYPES.includes(vt) ? vt : null;
    if (!row.vtype) problems.push('vtype: number·boolean·string 중 하나를 고르세요');
    const val = row.value;
    // 숫자·TRUE/FALSE 정책은 값이 있어야 한다(엑셀에서 빈 값은 글자 정책으로 읽혀 내려받기→올리기 왕복이 어긋난다)
    if ((row.vtype === 'number' || row.vtype === 'boolean') && val === null) problems.push('value: 값을 입력해 주세요(숫자·TRUE/FALSE 정책)');
    if (row.vtype === 'number' && val !== null && !Number.isFinite(toNum(val))) problems.push('value: 숫자 정책인데 숫자가 아닙니다');
    if (row.vtype === 'number' && val !== null && Number.isFinite(toNum(val))) row.value = String(toNum(val));
    if (row.vtype === 'boolean' && val !== null) {
      const t = String(val ?? '').toUpperCase();
      if (t !== 'TRUE' && t !== 'FALSE') problems.push('value: TRUE/FALSE 정책인데 TRUE 또는 FALSE 가 아닙니다');
      else row.value = t;
    }
  }
  return { row, problems };
}

/** 비교용 정규화(price-sheet 의 지문 규칙과 같은 방향) */
function norm(kind, v) {
  if (v === null || v === undefined || v === '') return null;
  if (kind === 'num') return Number(v);
  if (kind === 'bool') return v === true || v === 1 || v === '1' || String(v).toUpperCase() === 'TRUE' ? 1 : 0;
  return typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
}

/** 정책은 vtype 도 비교한다 */
const colsFor = (table) => {
  const spec = editSpec(table);
  if (!spec) return [];
  return table === 'price_policy' ? [...spec.cols, { name: 'vtype', kind: 'text' }] : spec.cols;
};

/**
 * 두 행이 같은가(편집 대상 열만, 정규화해서).
 * @param {string} table @param {Record<string, unknown> | null | undefined} a @param {Record<string, unknown> | null | undefined} b
 */
export function sameRow(table, a, b) {
  if (!a || !b) return false;
  return colsFor(table).every((c) => JSON.stringify(norm(c.kind, a[c.name])) === JSON.stringify(norm(c.kind, b[c.name])));
}

/** 바뀐 열 이름 @param {string} table @param {Record<string, unknown> | null} before @param {Record<string, unknown>} after */
export function changedCols(table, before, after) {
  return colsFor(table)
    .filter((c) => JSON.stringify(norm(c.kind, before?.[c.name])) !== JSON.stringify(norm(c.kind, after?.[c.name])))
    .map((c) => c.name);
}

/** 행의 키(문자열). 별칭은 DB 번호. */
export function rowKey(table, rec) {
  const spec = editSpec(table);
  if (!spec || !rec) return '';
  const v = rec[spec.id];
  return v === null || v === undefined ? '' : String(v);
}

/**
 * DB 에서 읽은 표(readPriceTables 모양 · 별칭은 id 포함) → 검사(validatePriceData)용 데이터.
 * active 같은 TRUE/FALSE 열은 DB 의 1/0 을 true/false 로, 별칭의 DB 번호는 뺀다.
 * @param {Record<string, Record<string, unknown>[]>} tables
 */
export function dataForValidate(tables) {
  const out = {};
  for (const table of PRICE_TABLE_ORDER) {
    const spec = SPEC[table];
    const extra = table === 'price_policy' ? ['vtype'] : [];
    out[table] = (Array.isArray(tables?.[table]) ? tables[table] : []).map((rec) => {
      const r = {};
      for (const c of spec.cols) {
        const v = rec?.[c.name];
        r[c.name] = c.kind === 'bool' && v !== null && v !== undefined ? norm('bool', v) === 1 : v ?? null;
      }
      for (const k of extra) r[k] = rec?.[k] ?? null;
      return r;
    });
  }
  return out;
}

/**
 * 한 행을 바꾼(또는 더한) 전체 데이터를 만들고 엑셀 올리기와 같은 규칙으로 검사한다.
 * @param {Record<string, Record<string, unknown>[]>} tables 지금 DB(별칭은 id 포함)
 * @param {{ table: string, mode: 'edit' | 'add', key?: string, row: Record<string, unknown> }} edit row = rowFromInput 결과
 * @returns {{ problems: string[], current: Record<string, unknown> | null }}
 */
export function checkEdit(tables, edit) {
  const spec = editSpec(edit?.table);
  if (!spec) return { problems: ['알 수 없는 표입니다'], current: null };
  const list = Array.isArray(tables?.[spec.table]) ? tables[spec.table] : [];
  let current = null;
  let nextList;
  if (edit.mode === 'edit') {
    current = list.find((r) => rowKey(spec.table, r) === String(edit.key ?? '')) ?? null;
    if (!current) return { problems: ['고칠 행을 찾지 못했습니다 — 새로 불러오세요'], current: null };
    // 키는 바꿀 수 없다(별칭은 DB 번호라 행 값에 없다)
    if (!spec.aliasId && rowKey(spec.table, edit.row) !== rowKey(spec.table, current)) return { problems: [`${spec.id} 는 바꿀 수 없습니다`], current };
    nextList = list.map((r) => (r === current ? { ...(spec.aliasId ? { id: r.id } : {}), ...edit.row } : r));
  } else if (edit.mode === 'add') {
    if (!spec.aliasId && isBlank(edit.row?.[spec.id])) return { problems: [`${spec.id} 를 입력해 주세요`], current: null };
    nextList = [...list, { ...edit.row }];
  } else {
    return { problems: ['알 수 없는 동작입니다'], current: null };
  }
  const next = { ...tables, [spec.table]: nextList };
  const { problems } = validatePriceData(dataForValidate(next));
  return { problems, current };
}

/**
 * 내려받기용 시트(엑셀 [가격 DB 올리기]가 읽는 모양 그대로 — 시트 이름·헤더 이름 같음).
 *   정책: policy_key · policy_value · applies_to · notes — 값은 vtype 대로(숫자·TRUE/FALSE·글자)
 *   나머지: 스펙 열 순서 · TRUE/FALSE 열은 불리언 · 별칭의 DB 번호는 넣지 않는다
 * @param {Record<string, Record<string, unknown>[]>} tables readPriceTables 결과
 * @returns {{ name: string, rows: unknown[][] }[]}
 */
export function sheetsForExport(tables) {
  const out = [];
  for (const t of EDIT_TABLES) {
    const list = Array.isArray(tables?.[t.table]) ? tables[t.table] : [];
    if (t.table === 'price_policy') {
      const rows = [['policy_key', 'policy_value', 'applies_to', 'notes']];
      for (const r of list) {
        let v = r.value ?? null;
        if (v !== null && r.vtype === 'number' && Number.isFinite(Number(v))) v = Number(v);
        else if (v !== null && r.vtype === 'boolean') v = String(v).toUpperCase() === 'TRUE';
        rows.push([r.key ?? null, v, r.applies_to ?? null, r.notes ?? null]);
      }
      out.push({ name: t.sheet, rows });
      continue;
    }
    const cols = SPEC[t.table].cols;
    const rows = [cols.map((c) => c.name)];
    for (const r of list) {
      rows.push(cols.map((c) => {
        const v = r?.[c.name];
        if (v === null || v === undefined || v === '') return null;
        if (c.kind === 'bool') return norm('bool', v) === 1;
        if (c.kind === 'num') return Number(v);
        return v;
      }));
    }
    out.push({ name: t.sheet, rows });
  }
  return out;
}
