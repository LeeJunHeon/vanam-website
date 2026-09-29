// scripts/test-price-sheet.mjs — 가격 DB 시트 규칙(src/lib/price-sheet.js)·공용 엑셀 읽기(src/lib/xlsx-core.js) 테스트
//
// 테스트 안에서 작은 가짜 xlsx 를 만든다(값·ID 전부 가짜 — EQ-FAKE-1 꼴). 실제 가격 데이터를 쓰지 않는다.
import { deflateRawSync } from 'node:zlib';
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipEntries, openWorkbook, openXlsxWeb } from '../src/lib/xlsx-core.js';
import { openXlsx } from './lib/xlsx-lite.mjs';
import { inflateRawSync } from 'node:zlib';
import {
  readPriceWorkbook, validatePriceData, priceRowsForDb, insertChunks, priceFingerprint, priceDiff,
  TABLES, POLICY, REQUIRED_POLICY_KEYS, PRICE_TABLE_ORDER,
} from '../src/lib/price-sheet.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}
const has = (list, re) => list.some((p) => re.test(p));

// ── 가짜 xlsx 만들기 ─────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (buf) => { let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();
/** @param {{name: string, data: Buffer, store?: boolean}[]} files */
function zip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = f.store ? f.data : deflateRawSync(f.data);
    const method = f.store ? 0 : 8;
    const crc = CRC(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    centrals.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (n) => { let s = ''; for (let x = n; x > 0;) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - r) / 26); } return s; };

/**
 * 시트들 → xlsx 바이트. 셀 값: 문자열(공유 문자열 · 'rich:' 접두어면 리치 텍스트 · 'inline:' 이면 인라인) · 숫자 · 불리언 · null(빈 셀)
 * · {f, v} 수식(캐시값 v). 이미지 항목 하나를 저장 방식(store)으로 함께 넣는다(웹 경로가 건너뛰는지).
 * @param {Record<string, unknown[][]>} sheets
 */
function makeXlsx(sheets) {
  const shared = [];
  const sidx = (s) => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1; } return i; };
  const sheetXml = (rows) => {
    const body = rows.map((row, ri) => `<row r="${ri + 1}">` + row.map((v, ci) => {
      const ref = `${colName(ci + 1)}${ri + 1}`;
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
      if (typeof v === 'object') return typeof v.v === 'string'
        ? `<c r="${ref}" t="str"><f>${xmlEsc(v.f)}</f><v>${xmlEsc(v.v)}</v></c>`
        : `<c r="${ref}"><f>${xmlEsc(v.f)}</f><v>${v.v}</v></c>`;
      if (v.startsWith('inline:')) return `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(v.slice(7))}</t></is></c>`;
      return `<c r="${ref}" t="s"><v>${sidx(v)}</v></c>`;
    }).join('') + '</row>').join('');
    return `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>${body}</sheetData></worksheet>`;
  };
  const names = Object.keys(sheets);
  const files = names.map((n, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(sheets[n])) }));
  const sst = shared.map((s) => s.startsWith('rich:')
    ? `<si><r><t>${xmlEsc(s.slice(5, 8))}</t></r><r><rPr><b/></rPr><t>${xmlEsc(s.slice(8))}</t></r></si>`
    : `<si><t>${xmlEsc(s)}</t></si>`).join('');
  files.push(
    { name: 'xl/workbook.xml', data: Buffer.from(`<workbook><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<Relationships>${names.map((n, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`) },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst>${sst}</sst>`) },
    { name: 'xl/media/image1.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), store: true },
  );
  return zip(files);
}

// ── 가짜 가격 시트 ───────────────────────────────────────────────────────────
const header = (spec) => spec.cols.map((c) => c.name);
const fakeRow = (spec, i) => spec.cols.map((c) => {
  if (c.name === spec.id) return `${spec.table === 'price_equipment' ? 'EQ' : spec.table === 'price_recipe' ? 'RC' : 'SB'}-FAKE-${i}`;
  if (c.kind === 'num') return i + 0.5;
  if (c.kind === 'bool') return i % 2 === 1;
  return c.name === 'notes' ? null : `가짜 ${c.name} ${i}`;
});
function baseSheets() {
  const out = {};
  for (const spec of TABLES) out[spec.sheet] = [header(spec), fakeRow(spec, 1), fakeRow(spec, 2)];
  const pol = [['policy_key', 'policy_value', 'applies_to', 'notes']];
  REQUIRED_POLICY_KEYS.forEach((k, i) => pol.push([k, i % 3 === 0 ? i + 1 : i % 3 === 1 ? true : `값${i}`, null, null]));
  pol.push(['rules_version', 'FAKE_RULES_1', null, null]);
  out[POLICY.sheet] = pol;
  return out;
}
const read = async (sheets) => readPriceWorkbook(await openXlsxWeb(makeXlsx(sheets)));
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── 1. 세 경로가 같은 값 ─────────────────────────────────────────────────────
{
  const sheets = baseSheets();
  sheets[TABLES[0].sheet][1][1] = 'rich:가짜장비이름';          // 리치 텍스트
  sheets[TABLES[0].sheet][2][1] = 'inline:인라인 이름';          // 인라인 문자열
  sheets[TABLES[1].sheet][1][5] = { f: 'A1*2', v: 3 };          // 수식 캐시값(숫자)
  sheets[TABLES[1].sheet][2][1] = { f: 'CONCAT("a","b")', v: 'ab' }; // 수식 문자열 결과
  const bytes = makeXlsx(sheets);
  const syncFiles = new Map(zipEntries(bytes).map((e) => [e.name, e.method === 0 ? Uint8Array.from(e.raw) : inflateRawSync(e.raw)]));
  const wbSync = openWorkbook(syncFiles);
  const wbWeb = await openXlsxWeb(bytes);
  const dir = mkdtempSync(join(tmpdir(), 'price-sheet-test-'));
  const p = join(dir, 'fake.xlsx');
  writeFileSync(p, bytes);
  const wbLite = openXlsx(p);
  rmSync(dir, { recursive: true, force: true });
  const dump = (wb) => wb.sheetNames.map((n) => wb.sheet(n).toArray());
  eq('세 경로(inflateRawSync·DecompressionStream·xlsx-lite) 같은 값', [JSON.stringify(dump(wbWeb)) === JSON.stringify(dump(wbSync)), JSON.stringify(dump(wbLite)) === JSON.stringify(dump(wbSync))], [true, true]);
  const eqS = wbWeb.sheet(TABLES[0].sheet);
  eq('셀 해석: 리치 텍스트·인라인·불리언·숫자·빈 셀', [eqS.value('B2'), eqS.value('B3'), eqS.at(2, 8), eqS.at(2, 4), eqS.at(2, 9)],
    ['가짜장비이름', '인라인 이름', true, 1.5, null]);
  const rcS = wbWeb.sheet(TABLES[1].sheet);
  eq('셀 해석: 수식 캐시값·수식 텍스트', [rcS.value('F2'), rcS.formula('F2'), rcS.value('B3')], [3, 'A1*2', 'ab']);
  eq('웹 경로: 이미지 항목 건너뜀 · 동기 경로: 전부', [zipEntries(bytes).some((e) => e.name.endsWith('.png')), syncFiles.has('xl/media/image1.png')], [true, true]);
  const r = readPriceWorkbook(wbWeb);
  eq('readPriceWorkbook 정상 — 문제 0 · 행 수', [r.problems, PRICE_TABLE_ORDER.map((t) => r.data[t].length)], [[], [REQUIRED_POLICY_KEYS.length + 1, 2, 2, 2, 2]]);
  eq('레코드는 스펙 컬럼만(__row 없음)', Object.keys(r.data.price_recipe[0]), TABLES[1].cols.map((c) => c.name));
  const pol = r.data.price_policy;
  eq('정책 vtype·value', [pol[0].vtype, pol[0].value, pol[1].vtype, pol[1].value, pol[2].vtype], ['number', '1', 'boolean', 'TRUE', 'string']);
  eq('validatePriceData 정상', validatePriceData(r.data).problems, []);
  eq('zip: 지원 안 하는 형식', (() => { try { zipEntries(new Uint8Array(30)); return 'no'; } catch (e) { return e.message; } })(), 'xlsx: ZIP 중앙 디렉터리(EOCD)를 찾지 못했습니다');
}

// ── 2. readPriceWorkbook 문제들 ──────────────────────────────────────────────
{
  const eqSheet = TABLES[0].sheet, rcSheet = TABLES[1].sheet;
  let s = baseSheets(); s[eqSheet][0][3] = 'rate_per_minute';
  eq('헤더 누락', has((await read(s)).problems, /V3_장비DB: 헤더에 "rate_per_min" 열이 없습니다/), true);
  s = baseSheets(); s[eqSheet][2][0] = null;
  eq('ID 비어 있음', has((await read(s)).problems, /V3_장비DB 3행: equipment_id 가 비어 있습니다/), true);
  s = baseSheets(); s[eqSheet][2][0] = 'EQ-FAKE-1';
  eq('ID 중복', has((await read(s)).problems, /V3_장비DB 3행: equipment_id 중복 → EQ-FAKE-1 \(2행과 같음\)/), true);
  s = baseSheets(); s[rcSheet][1][5] = 'abc';
  eq('숫자 칸 글자', has((await read(s)).problems, /V3_레시피DB 2행: material_cost_per_nm 이 숫자가 아닙니다 → "abc"/), true);
  s = baseSheets(); s[rcSheet][1][12] = '예';
  eq('불리언 칸 글자', has((await read(s)).problems, /V3_레시피DB 2행: active 이 TRUE\/FALSE 가 아닙니다/), true);
  s = baseSheets(); s[POLICY.sheet] = s[POLICY.sheet].filter((r) => r[0] !== 'markup_default');
  eq('필수 정책 키 없음', has((await read(s)).problems, /필수 키 "markup_default" 가 0번/), true);
  s = baseSheets(); s[POLICY.sheet].push(['markup_default', 9, null, null]);
  const two = (await read(s)).problems;
  eq('필수 정책 키 두 번(+ key 중복)', [has(two, /필수 키 "markup_default" 가 2번/), has(two, /policy_key 중복 → markup_default/)], [true, true]);
  s = baseSheets(); s[POLICY.sheet].push(['extra_key', 1, null, null], ['extra_key', 2, null, null]);
  eq('필수 아닌 정책 key 중복', has((await read(s)).problems, /V3_가격정책 \d+행: policy_key 중복 → extra_key/), true);
  s = baseSheets(); s[eqSheet] = [s[eqSheet][0]];
  eq('빈 표', has((await read(s)).problems, /V3_장비DB: 데이터 행이 없습니다/), true);
  s = baseSheets(); delete s[TABLES[3].sheet];
  eq('시트 없음 → 예외 대신 문제', has((await read(s)).problems, /V3_별칭DB: 시트가 없습니다/), true);
  s = baseSheets(); s[rcSheet][1][1] = 'x'.repeat(4001);
  eq('4000자 초과', has((await read(s)).problems, /V3_레시피DB 2행: material_name 이 4000자를 넘습니다 \(4001자\)/), true);
  s = baseSheets(); s[rcSheet][1][1] = 'x'.repeat(4000);
  eq('4000자는 통과', (await read(s)).problems, []);
  s = baseSheets(); for (let i = 3; i <= 2001; i++) s[TABLES[3].sheet].push(fakeRow(TABLES[3], i));
  eq('2000행 초과', has((await read(s)).problems, /V3_별칭DB: 데이터 행이 2001개입니다 \(최대 2000개\)/), true);
}

// ── 3. validatePriceData ─────────────────────────────────────────────────────
const good = (await read(baseSheets())).data;
{
  const V = (mut) => { const d = clone(good); mut(d); return validatePriceData(d).problems; };
  eq('정상', V(() => {}), []);
  eq('ID 중복', has(V((d) => { d.price_recipe[1].recipe_id = d.price_recipe[0].recipe_id; }), /price_recipe 2번째 행: recipe_id 중복/), true);
  eq('ID 비어 있음', has(V((d) => { d.price_recipe[1].recipe_id = ''; }), /price_recipe 2번째 행: recipe_id 가 비어 있습니다/), true);
  eq('숫자 칸 글자·NaN·Infinity', [V((d) => { d.price_recipe[0].growth_nm_per_min = 'abc'; }), V((d) => { d.price_recipe[0].growth_nm_per_min = 'NaN'; })]
    .every((p) => has(p, /growth_nm_per_min 이 숫자가 아닙니다/)), true);
  eq('불리언 칸 숫자', has(V((d) => { d.price_equipment[0].active = 1; }), /active 이 TRUE\/FALSE 가 아닙니다/), true);
  eq('글자 칸 객체', has(V((d) => { d.price_alias[0].alias = { a: 1 }; }), /alias 형식이 잘못됐습니다/), true);
  eq('필수 정책 키 없음·두 번', [has(V((d) => { d.price_policy = d.price_policy.filter((r) => r.key !== 'currency'); }), /필수 키 "currency" 가 0번/),
    has(V((d) => { d.price_policy.push({ ...d.price_policy.find((r) => r.key === 'currency') }); }), /필수 키 "currency" 가 2번/)], [true, true]);
  eq('정책 key 중복', has(V((d) => { d.price_policy.push({ key: 'rules_version', value: 'x', vtype: 'string', applies_to: null, notes: null }); }), /key 중복 → rules_version/), true);
  eq('정책 vtype·value 형식', [has(V((d) => { d.price_policy[0].vtype = 'date'; }), /vtype 이/), has(V((d) => { d.price_policy[0].value = 5; }), /value 는 문자열/)], [true, true]);
  eq('모르는 표', has(V((d) => { d.price_extra = []; }), /알 수 없는 표: price_extra/), true);
  eq('모르는 열', has(V((d) => { d.price_recipe[0].cost_secret = 1; }), /price_recipe 1번째 행: 모르는 열 "cost_secret"/), true);
  eq('표 없음·배열 아님·빈 표', [has(V((d) => { delete d.price_alias; }), /price_alias: 표가 없습니다/), has(V((d) => { d.price_alias = {}; }), /price_alias: 배열이 아닙니다/),
    has(V((d) => { d.price_alias = []; }), /price_alias: 데이터 행이 없습니다/)], [true, true, true]);
  eq('2000행 초과', has(V((d) => { d.price_alias = Array.from({ length: 2001 }, () => ({ ...d.price_alias[0] })); }), /데이터 행이 2001개/), true);
  eq('4000자 초과', has(V((d) => { d.price_alias[0].notes = 'x'.repeat(4001); }), /notes 이 4000자를 넘습니다/), true);
  eq('행이 객체 아님 · 데이터가 객체 아님', [has(V((d) => { d.price_alias[0] = [1]; }), /객체가 아닙니다/), validatePriceData(null).problems.length], [true, 1]);
}

// ── 4. priceRowsForDb · insertChunks ─────────────────────────────────────────
{
  const d = clone(good);
  d.price_equipment[0].notes = '';
  d.price_equipment[0].equipment_name = true;
  const r = priceRowsForDb(d);
  eq('표 순서·열 = 스펙', [Object.keys(r), r.price_recipe.cols], [PRICE_TABLE_ORDER, TABLES[1].cols.map((c) => c.name)]);
  const row = r.price_equipment.rows[0];
  const ci = (n) => r.price_equipment.cols.indexOf(n);
  eq('값 규칙: 빈칸 null · 불리언 1/0(글자 칸도) · 숫자 그대로', [row[ci('notes')], row[ci('equipment_name')], row[ci('active')], row[ci('rate_per_min')], r.price_equipment.rows[1][ci('active')]],
    [null, 1, 1, 1.5, 0]);
  const rows = Array.from({ length: 25 }, (_, i) => i);
  const ch = insertChunks(rows, 16);
  eq('insertChunks: 묶음마다 ≤100 · 순서·누락 없음', [ch.every((c) => c.length * 16 <= 100), ch.flat(), ch.length], [true, rows, 5]);
  eq('insertChunks: 열 수 경계', [insertChunks([1, 2, 3], 100).length, insertChunks([1, 2, 3], 101).length, insertChunks([], 5).length, insertChunks(Array(20).fill(0), 5).length], [3, 3, 0, 1]);
}

// ── 5. 지문 ──────────────────────────────────────────────────────────────────
{
  const base = priceRowsForDb(good);
  const fp = await priceFingerprint(base);
  eq('지문 64자리 16진수', /^[0-9a-f]{64}$/.test(fp), true);
  const shuffled = clone(base);
  for (const t of PRICE_TABLE_ORDER) shuffled[t].rows.reverse();
  eq('행 순서를 섞어도 같음', await priceFingerprint(shuffled), fp);
  const reordered = clone(base);
  reordered.price_alias = { cols: [...base.price_alias.cols].reverse(), rows: base.price_alias.rows.map((r) => [...r].reverse()) };
  eq('열 순서가 달라도(열 이름 기준) 같음', await priceFingerprint(reordered), fp);
  const d1 = clone(good); d1.price_equipment[0].active = true;
  const asDb = priceRowsForDb(d1); asDb.price_equipment.rows[0][asDb.price_equipment.cols.indexOf('active')] = 1;
  eq('true / 1 같음', await priceFingerprint(asDb), await priceFingerprint(priceRowsForDb(d1)));
  const d2 = clone(good); d2.price_alias[0].notes = 123;
  const d3 = clone(good); d3.price_alias[0].notes = '123';
  eq('글자 칸 123 / "123" 같음', await priceFingerprint(priceRowsForDb(d2)), await priceFingerprint(priceRowsForDb(d3)));
  const d4 = clone(good); d4.price_recipe[0].growth_nm_per_min = 99.5;
  eq('값 하나 바뀌면 다름', (await priceFingerprint(priceRowsForDb(d4))) !== fp, true);
  const withId = clone(base);
  withId.price_alias = { cols: ['id', ...base.price_alias.cols], rows: base.price_alias.rows.map((r, i) => [i + 100, ...r]) };
  eq('alias 자동 id 무관', await priceFingerprint(withId), fp);
  const dbLike = { price_alias: good.price_alias.map((r) => ({ id: 7, ...r })) };
  eq('D1 레코드(자동 id 포함)에도 priceRowsForDb 적용', priceRowsForDb(dbLike).price_alias.cols.includes('id'), false);
}

// ── 6. priceDiff ─────────────────────────────────────────────────────────────
{
  const cur = priceRowsForDb(good);
  const nd = clone(good);
  nd.price_recipe[0].growth_nm_per_min = 42.25;
  nd.price_recipe[0].notes = '바뀐 메모';
  nd.price_recipe.push({ ...nd.price_recipe[1], recipe_id: 'RC-FAKE-9' });
  nd.price_equipment = nd.price_equipment.slice(1);
  nd.price_alias.push({ ...nd.price_alias[0] });
  const df = priceDiff(cur, priceRowsForDb(nd));
  eq('변경·추가 개수와 열 이름', [df.price_recipe.added, df.price_recipe.removed, df.price_recipe.changed, df.price_recipe.ids.added, df.price_recipe.ids.changed],
    [1, 0, 1, ['RC-FAKE-9'], [{ id: 'RC-FAKE-1', cols: ['growth_nm_per_min', 'notes'] }]]);
  eq('삭제', [df.price_equipment.removed, df.price_equipment.ids.removed], [1, ['EQ-FAKE-1']]);
  eq('별칭은 개수만', [df.price_alias.added, df.price_alias.removed, df.price_alias.changed, df.price_alias.ids], [1, 0, 0, { added: [], removed: [], changed: [] }]);
  eq('나머지 표 0', [df.price_policy, df.price_substrate].map((x) => x.added + x.removed + x.changed), [0, 0]);
  const text = JSON.stringify(df);
  eq('응답에 값 없음(열 이름·ID 만)', [text.includes('42.25'), text.includes('바뀐 메모')], [false, false]);
  const many = clone(good);
  many.price_substrate = Array.from({ length: 40 }, (_, i) => ({ ...good.price_substrate[0], catalog_id: `SB-FAKE-N${i}` }));
  const dm = priceDiff(cur, priceRowsForDb(many));
  eq('ID 30개 제한 · 개수는 전부', [dm.price_substrate.added, dm.price_substrate.ids.added.length, dm.price_substrate.removed], [40, 30, 2]);
  eq('같으면 전부 0', PRICE_TABLE_ORDER.map((t) => { const x = priceDiff(cur, cur)[t]; return x.added + x.removed + x.changed; }), [0, 0, 0, 0, 0]);
}

// ── 7. API 의 INSERT 컬럼 = 스펙 ──────────────────────────────────────────────
{
  const src = readFileSync('src/pages/api/admin/price-import.ts', 'utf8');
  for (const spec of [POLICY, ...TABLES]) {
    const m = new RegExp(`'INSERT INTO ${spec.table} \\(([^)]*)\\) VALUES '`).exec(src);
    eq(`price-import.ts INSERT 컬럼 = 스펙 (${spec.table})`, m ? m[1].split(',').map((x) => x.trim()) : null, spec.cols.map((c) => c.name));
    eq(`price-import.ts DELETE (${spec.table})`, src.includes(`'DELETE FROM ${spec.table}'`), true);
  }
  const dbSrc = readFileSync('src/lib/price-db.ts', 'utf8');
  const body = dbSrc.slice(dbSrc.indexOf('export async function readPriceTables'));
  for (const spec of [POLICY, ...TABLES]) {
    const m = new RegExp(`\`SELECT ([^\`]*?)\\s+FROM ${spec.table}\\b`).exec(body);
    eq(`price-db.ts readPriceTables 컬럼 = 스펙 (${spec.table})`, m ? m[1].split(',').map((x) => x.trim()) : null, spec.cols.map((c) => c.name));
  }
  eq('저장 뒤 확인 실패 applied_unverified — API·설정 탭 둘 다', [src, readFileSync('src/pages/admin/index.astro', 'utf8')].map((x) => x.includes("'applied_unverified'")), [true, true]);
}

if (failed) {
  console.error(`\n가격 DB 시트 규칙(price-sheet) 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 가격 DB 시트 규칙(price-sheet)·공용 엑셀 읽기(xlsx-core) — ${total}건 통과`);
