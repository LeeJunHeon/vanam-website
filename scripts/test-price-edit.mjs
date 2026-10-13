// scripts/test-price-edit.mjs — 가격 DB 편집(src/lib/price-edit.js)·엑셀 쓰기(src/lib/xlsx-write.js)·운영 설정(src/lib/site-settings.js) 테스트
//
//   ① 한 행 입력 → 저장 값(열 종류 · 정책 vtype)
//   ② 수정·추가 검사 — 엑셀 올리기와 같은 규칙(ID 중복 · 필수 정책 키 · 키는 못 바꿈) · 동시 수정 판정(sameRow) · 바뀐 열
//   ③ 내려받기 엑셀 → [가격 DB 올리기]가 읽으면 같은 데이터(지문 같음)
//   ④ 운영 설정 — 범위 · 기본값 · 이상한 DB 값 · {days} 채우기 · 확인 메일 문구
//   ⑤ 재발 방지 — 화면·메일에 "영업일 2일"을 다시 박아 넣지 않았는지
// 값·ID 는 전부 가짜(EQ-FAKE-1 꼴). 실제 가격 데이터를 쓰지 않는다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { editSpec, rowFromInput, sameRow, changedCols, checkEdit, dataForValidate, sheetsForExport, rowKey, EDIT_TABLES } from '../src/lib/price-edit.js';
import { buildXlsx, crc32 } from '../src/lib/xlsx-write.js';
import { zipEntries, openWorkbook } from '../src/lib/xlsx-core.js';
import { readPriceWorkbook, validatePriceData, priceRowsForDb, priceFingerprint, REQUIRED_POLICY_KEYS, PRICE_TABLE_ORDER } from '../src/lib/price-sheet.js';
import { SETTINGS, checkSetting, settingsFromRows, settingDefaults, quoteLimitsOf, fillDays } from '../src/lib/site-settings.js';
import { ackContent } from '../src/lib/quote-ack.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}

// ── 가짜 DB(읽은 모양 그대로: active 1/0 · 별칭은 DB 번호 포함) ─────────────────
const POLICY_ROWS = REQUIRED_POLICY_KEYS.map((k, i) => ({
  key: k, value: k === 'currency' ? 'KRW' : k === 'direct_price_markup_enabled' ? 'TRUE' : String(i + 1),
  vtype: k === 'currency' ? 'string' : k === 'direct_price_markup_enabled' ? 'boolean' : 'number', applies_to: null, notes: null,
}));
POLICY_ROWS.push({ key: 'quote_valid_days', value: '14', vtype: 'number', applies_to: 'quote', notes: '가짜 메모' });
POLICY_ROWS.push({ key: 'rules_version', value: 'FAKE-1', vtype: 'string', applies_to: null, notes: null });
const DB = () => ({
  price_policy: POLICY_ROWS.map((r) => ({ ...r })),
  price_equipment: [
    { equipment_id: 'EQ-FAKE-1', equipment_name: '가짜 장비 1', process_type: 'Sputter', rate_per_min: 11.5, default_loading_min: 5, default_plasma_min: null, default_setup_min: 0, active: 1, notes: null },
    { equipment_id: 'EQ-FAKE-2', equipment_name: '가짜 장비 2', process_type: 'ALD', rate_per_min: 7, default_loading_min: 3, default_plasma_min: 2, default_setup_min: 1, active: 0, notes: '줄바꿈\n메모' },
  ],
  price_recipe: [
    { recipe_id: 'RC-FAKE-1', material_name: 'Ti', process_type: 'Sputter', equipment_id: 'EQ-FAKE-1', method: 'DC', material_cost_per_nm: 0.25, growth_nm_per_min: 1.5,
      default_temp_c: null, loading_override_min: null, plasma_override_min: null, setup_override_min: null, legacy_min_charge: 1000, active: 1, verification_status: 'ok', supplier: null, notes: null },
  ],
  price_substrate: [
    { catalog_id: 'SB-FAKE-1', item_name: 'Fake wafer', category: 'wafer', unit: 'ea', cost_per_unit: 100, sale_price_per_unit: 150, units_per_pack: 25,
      legacy_pack_price: null, size_inch: 4, oxide_nm: null, supplier: null, active: 1, verification_status: null, notes: null },
  ],
  price_alias: [
    { id: 7, entity_type: 'material', alias: 'titanium', equipment_scope: null, canonical_id: 'RC-FAKE-1', status: 'active', notes: null },
    { id: 9, entity_type: 'material', alias: 'titanium', equipment_scope: 'EQ-FAKE-1', canonical_id: 'RC-FAKE-1', status: 'active', notes: null },
  ],
});

// ── ① 입력 → 값 ───────────────────────────────────────────────────────────────
eq('표 5개 · 엑셀 시트 순서', EDIT_TABLES.map((t) => t.table), ['price_policy', 'price_equipment', 'price_recipe', 'price_substrate', 'price_alias']);
eq('편집 규칙: active 있는 표만 사용함/사용 안 함 · 별칭은 DB 번호', PRICE_TABLE_ORDER.map((t) => [editSpec(t).id, editSpec(t).hasActive, editSpec(t).aliasId]),
  [['key', false, false], ['equipment_id', true, false], ['recipe_id', true, false], ['catalog_id', true, false], ['id', false, true]]);
{
  const r = rowFromInput('price_equipment', { equipment_id: ' EQ-FAKE-3 ', equipment_name: '새 장비', rate_per_min: '1,234.5', default_loading_min: '', active: 'TRUE', notes: '  ' });
  eq('입력: 글자 다듬기 · 숫자(쉼표 허용) · 빈칸 null · TRUE', [r.problems, r.row.equipment_id, r.row.rate_per_min, r.row.default_loading_min, r.row.active, r.row.notes], [[], 'EQ-FAKE-3', 1234.5, null, true, null]);
  eq('입력: 16진수·빈 지수 같은 모양은 숫자로 안 받음 · 지수(1e-7)는 받음', [rowFromInput('price_equipment', { equipment_id: 'X', rate_per_min: '0x1F' }).problems.length,
    rowFromInput('price_equipment', { equipment_id: 'X', rate_per_min: '1e-7' }).row.rate_per_min], [1, 1e-7]);
  eq('입력: 키 열만 공백 제거 · 메모 공백은 그대로 · 공백뿐이면 빈칸', [rowFromInput('price_equipment', { equipment_id: ' K ', notes: ' 앞뒤 ' }).row.notes,
    rowFromInput('price_equipment', { equipment_id: ' K ', notes: '   ' }).row.notes], [' 앞뒤 ', null]);
  eq('정책: 숫자·TRUE/FALSE 정책은 값 비움 불가 · 글자 정책은 비움 가능', [rowFromInput('price_policy', { key: 'k', value: '', vtype: 'number' }).problems,
    rowFromInput('price_policy', { key: 'k', value: '', vtype: 'string' }).problems], [['value: 값을 입력해 주세요(숫자·TRUE/FALSE 정책)'], []]);
  eq('입력: 숫자 칸에 글자 → 문제', rowFromInput('price_equipment', { equipment_id: 'X', rate_per_min: '열' }).problems, ['rate_per_min: 숫자를 입력해 주세요']);
  eq('입력: active 이상값 → 문제', rowFromInput('price_recipe', { recipe_id: 'X', active: '네' }).problems, ['active: TRUE 또는 FALSE 여야 합니다']);
  eq('정책: number 는 숫자로 정리 · boolean 은 TRUE/FALSE · 잘못이면 문제', [
    rowFromInput('price_policy', { key: 'k', value: '1,500', vtype: 'number' }).row.value,
    rowFromInput('price_policy', { key: 'k', value: 'true', vtype: 'boolean' }).row.value,
    rowFromInput('price_policy', { key: 'k', value: 'abc', vtype: 'number' }).problems,
    rowFromInput('price_policy', { key: 'k', value: 'yes', vtype: 'boolean' }).problems,
    rowFromInput('price_policy', { key: 'k', value: 'x', vtype: 'json' }).problems,
  ], ['1500', 'TRUE', ['value: 숫자 정책인데 숫자가 아닙니다'], ['value: TRUE/FALSE 정책인데 TRUE 또는 FALSE 가 아닙니다'], ['vtype: number·boolean·string 중 하나를 고르세요']]);
}

// ── ② 수정·추가 검사 · 동시 수정 · 바뀐 열 ──────────────────────────────────────
eq('지금 가짜 DB 는 엑셀 올리기 검사를 통과(DB 1/0 → TRUE/FALSE 로 바꿔서)', validatePriceData(dataForValidate(DB())).problems, []);
{
  const db = DB();
  const before = db.price_equipment[0];
  const { row } = rowFromInput('price_equipment', { ...before, rate_per_min: 12, active: false });
  const c = checkEdit(db, { table: 'price_equipment', mode: 'edit', key: 'EQ-FAKE-1', row });
  eq('수정: 통과 · 지금 행을 찾음', [c.problems, c.current === before], [[], true]);
  eq('바뀐 열: rate_per_min · active(1 → false)', changedCols('price_equipment', before, row), ['rate_per_min', 'active']);
  eq('같은 행 판정: 1 과 true · 12 와 "12" 는 같다 · 값이 다르면 다르다', [
    sameRow('price_equipment', before, { ...before, active: true }), sameRow('price_equipment', before, { ...before, rate_per_min: '11.5' }),
    sameRow('price_equipment', before, { ...before, rate_per_min: 11.6 }), sameRow('price_equipment', before, null)], [true, true, false, false]);
  eq('수정: 없는 행', checkEdit(db, { table: 'price_equipment', mode: 'edit', key: 'NOPE', row }).problems, ['고칠 행을 찾지 못했습니다 — 새로 불러오세요']);
  eq('수정: 키는 바꿀 수 없음', checkEdit(db, { table: 'price_equipment', mode: 'edit', key: 'EQ-FAKE-1', row: { ...row, equipment_id: 'EQ-FAKE-9' } }).problems, ['equipment_id 는 바꿀 수 없습니다']);
  eq('추가: 같은 ID → 중복 문제(엑셀 검사와 같은 문구)', checkEdit(db, { table: 'price_equipment', mode: 'add', row: { ...row, equipment_id: 'EQ-FAKE-2' } }).problems.some((p) => /중복/.test(p)), true);
  eq('추가: ID 비움 → 문제', checkEdit(db, { table: 'price_recipe', mode: 'add', row: rowFromInput('price_recipe', { material_name: 'Pt' }).row }).problems, ['recipe_id 를 입력해 주세요']);
  eq('추가: 새 ID → 통과', checkEdit(db, { table: 'price_recipe', mode: 'add', row: rowFromInput('price_recipe', { recipe_id: 'RC-FAKE-2', material_name: 'Pt', active: true }).row }).problems, []);
  const pol = rowFromInput('price_policy', { key: 'quote_valid_days', value: '30', vtype: 'number' }).row;
  eq('정책 수정: 통과 · 바뀐 열(빠진 칸은 비움으로 본다 — 화면은 모든 칸을 보낸다)', [checkEdit(db, { table: 'price_policy', mode: 'edit', key: 'quote_valid_days', row: pol }).problems,
    changedCols('price_policy', db.price_policy.find((r) => r.key === 'quote_valid_days'), pol)], [[], ['value', 'applies_to', 'notes']]);
  const al = rowFromInput('price_alias', { entity_type: 'material', alias: 'ti', canonical_id: 'RC-FAKE-1', status: 'active' }).row;
  eq('별칭 수정: DB 번호로 찾음 · 번호는 지킴', [checkEdit(db, { table: 'price_alias', mode: 'edit', key: '9', row: al }).problems, rowKey('price_alias', db.price_alias[1])], [[], '9']);
  eq('글자 4000자 넘으면 엑셀 검사와 같은 문제', checkEdit(db, { table: 'price_equipment', mode: 'edit', key: 'EQ-FAKE-1', row: { ...row, notes: 'x'.repeat(4001) } }).problems.some((p) => /4000자/.test(p)), true);
}

// ── ③ 내려받기 → 다시 올리기 왕복 ────────────────────────────────────────────────
{
  const db = DB();
  const { price_alias, ...rest } = db;
  const tables = { ...rest, price_alias: price_alias.map(({ id: _id, ...r }) => r) };
  const bytes = buildXlsx(sheetsForExport(tables));
  const files = new Map(zipEntries(bytes).map((e) => [e.name, e.raw.slice()]));
  const wb = openWorkbook(files);
  eq('엑셀: 시트 이름 = 올리기가 읽는 이름', wb.sheetNames, ['V3_가격정책', 'V3_장비DB', 'V3_레시피DB', 'V3_상품기판DB', 'V3_별칭DB']);
  const read = readPriceWorkbook(wb);
  eq('엑셀: 다시 읽기 검사 통과', [read.problems, validatePriceData(read.data).problems], [[], []]);
  const fpDb = await priceFingerprint(priceRowsForDb(tables));
  const fpXlsx = await priceFingerprint(priceRowsForDb(read.data));
  eq('엑셀 왕복: 지문 같음(값·NULL·TRUE/FALSE·줄바꿈·정책 vtype 그대로)', fpXlsx, fpDb);
  eq('정책 vtype 왕복', read.data.price_policy.map((r) => r.vtype), tables.price_policy.map((r) => r.vtype));
  eq('ZIP CRC(알려진 값)', crc32(new TextEncoder().encode('123456789')).toString(16), 'cbf43926');
  const bad = buildXlsx([{ name: 'S', rows: [['a&b<c>"d"', 'x\u0001y', 'line\nbreak', ' lead']] }]);
  const s = openWorkbook(new Map(zipEntries(bad).map((e) => [e.name, e.raw.slice()]))).sheet('S');
  eq('엑셀: 특수문자 이스케이프 · 제어문자 제거 · 줄바꿈·앞 공백 보존', [s.at(1, 1), s.at(1, 2), s.at(1, 3), s.at(1, 4)], ['a&b<c>"d"', 'xy', 'line\nbreak', ' lead']);
}

// ── ④ 운영 설정 ─────────────────────────────────────────────────────────────────
eq('운영 설정 6개 · 키', SETTINGS.map((s) => s.key), ['reply_business_days', 'quote_sample_manual_min', 'quote_auto_max_nm', 'quote_auto_max_min', 'ack_recipient_daily_max', 'ack_global_daily_max']);
eq('기본값 = 지금까지 코드 값', settingDefaults(), { reply_business_days: 2, quote_sample_manual_min: 10, quote_auto_max_nm: 10000, quote_auto_max_min: 1440, ack_recipient_daily_max: 3, ack_global_daily_max: 50 });
eq('메일 상한은 낮추기만(최댓값 = 기본값)', SETTINGS.filter((s) => s.key.startsWith('ack_')).map((s) => s.max === s.def), [true, true]);
eq('검사: 범위 · 정수 · 모르는 키', [checkSetting('reply_business_days', 5), checkSetting('reply_business_days', '7'), checkSetting('reply_business_days', 0).error,
  checkSetting('reply_business_days', 2.5).error, checkSetting('ack_global_daily_max', 51).error, checkSetting('ack_global_daily_max', 0).ok, checkSetting('admin_password', 1).error, checkSetting('reply_business_days', '').error],
  [{ ok: true, key: 'reply_business_days', value: 5 }, { ok: true, key: 'reply_business_days', value: 7 }, 'out_of_range', 'not_integer', 'out_of_range', true, 'unknown_key', 'not_integer']);
eq('DB 값: 맞으면 그 값 · 범위 밖·이상값·모르는 키는 기본값', settingsFromRows([
  { key: 'reply_business_days', value: 3 }, { key: 'quote_auto_max_nm', value: 999999 }, { key: 'ack_recipient_daily_max', value: 'abc' }, { key: 'usd_rate', value: 1400 }, { key: 'quote_sample_manual_min', value: '5' },
]), { ...settingDefaults(), reply_business_days: 3, quote_sample_manual_min: 5 });
eq('견적 한도 묶음', quoteLimitsOf({ ...settingDefaults(), quote_sample_manual_min: 4, quote_auto_max_nm: 500 }), { sampleManualMin: 4, maxNm: 500, maxMin: 1440 });
eq('{days} 채우기: 값 · 이상값은 기본 2', [fillDays('영업일 기준 {days}일', 5), fillDays('{days} business days', undefined), fillDays('{days}', 99), fillDays('{days}', '3')], ['영업일 기준 5일', '2 business days', '2', '3']);
{
  const base = { id: 'INQ-20261012-FAKE', name: '홍길동', product: '박막', receivedAt: '2026-10-12T01:00:00Z', estimate: null, T: {}, attachment: null,
    lookupUrl: 'https://vanam.co.kr/ko/order/lookup?id=INQ-20261012-FAKE', tel: '02-0000-0000', email: 'hello@vanam.co.kr', site: 'https://vanam.co.kr', live: true };
  eq('확인 메일: 회신 기한 설정값 · 없으면 2', [
    ackContent({ ...base, lang: 'ko', replyDays: 5 }).text.includes('영업일 기준 5일 이내에 회신드리겠습니다'),
    ackContent({ ...base, lang: 'en', replyDays: 5 }).html.includes('within 5 business days'),
    ackContent({ ...base, lang: 'ko' }).text.includes('영업일 기준 2일 이내'),
    ackContent({ ...base, lang: 'ko', replyDays: 5 }).text.includes('{days}')], [true, true, true, false]);
}

// ── ⑤ 재발 방지: "영업일 2일"·"2 business days" 를 화면·메일 코드에 다시 박지 않았는가 ──────────
{
  const files = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(astro|ts|js|json)$/.test(n)) files.push(p); } };
  walk('src');
  const hits = files.filter((f) => {
    const t = readFileSync(f, 'utf8');
    return /영업일 기준 2일|within 2 business days/.test(t);
  });
  eq('하드코딩 "영업일 기준 2일 / within 2 business days" 0곳({days} 로 운영 설정을 쓴다)', hits, []);
}

if (failed) {
  console.error(`\n가격 DB 편집·운영 설정 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 가격 DB 편집·엑셀 내려받기·운영 설정 — ${total}건 통과 · 내려받기→올리기 지문 같음`);
