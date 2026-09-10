// scripts/check-quote-fields.mjs — 견적 폼 선택지·서버 검증 게이트 (0910c, 재발 방지 가드레일)
//
// 왜 있는가: 기판 전달 방식(delivery)의 value 는 **이미 D1 에 저장된 코드값**이다.
// 라벨을 바꾸거나 선택지를 늘리는 작업에서 value 가 함께 바뀌면
//   ① 기존 접수 건의 조회 화면이 코드값을 그대로 노출하고(라벨 매핑 실패)
//   ② 서버 허용값 검증이 과거 데이터 형식을 막아버린다.
// 또 배송지 블록 노출 판정을 라벨 정규식으로 하던 시절엔
// 'In-person delivery'(방문 전달) 라벨이 /delivery/ 에 걸려 방문 전달에도 배송지가 떴다.
// → 값 불변·플래그 판정·서버 검증을 빌드 전에 못 박는다.
//
// 사용: node scripts/check-quote-fields.mjs
import {
  DELIVERY_METHODS,
  DELIVERY_VALUES,
  DELIVERY_NEEDS_SHIPPING,
  validateQuoteDetails,
  preFilmFields,
} from '../src/lib/quote-fields.js';

let bad = 0;
const fail = (msg) => { console.error('  ✗', msg); bad++; };
const ok = (msg) => console.log('  ✓', msg);

// ── ① 기존 저장값 불변 ────────────────────────────────────
// D1 의 기존 견적 6건은 전부 delivery='courier'. 'direct' 도 옛 폼의 값이라 남겨야 한다.
const LEGACY = ['courier', 'direct'];
const missing = LEGACY.filter((v) => !DELIVERY_VALUES.includes(v));
if (missing.length) fail(`기존 저장 코드값이 사라졌다: ${missing.join(', ')} — 과거 접수 건의 라벨 매핑이 깨진다`);
else ok(`기존 코드값 유지 (${LEGACY.join(', ')})`);

// ── ② 새 선택지 ──────────────────────────────────────────
if (!DELIVERY_VALUES.includes('purchase')) fail("'purchase'(구매 요청) 선택지가 없다");
else ok("'purchase'(구매 요청) 추가됨");

if (DELIVERY_VALUES.length !== new Set(DELIVERY_VALUES).size) fail('delivery value 중복');
else ok(`delivery value 중복 없음 (${DELIVERY_VALUES.join(', ')})`);

for (const d of DELIVERY_METHODS) {
  if (!d.ko?.trim() || !d.en?.trim()) fail(`${d.value}: ko/en 라벨 누락`);
}

// ── ③ 배송지 노출은 플래그로만 판정 ────────────────────────
// 라벨에 'delivery' 가 들어가는 방문 전달이 배송형으로 잡히면 안 된다(예전 정규식 판정의 사고).
if (DELIVERY_NEEDS_SHIPPING.join(',') !== 'courier') {
  fail(`배송지가 필요한 방식은 courier 하나여야 한다 — 현재: [${DELIVERY_NEEDS_SHIPPING.join(', ')}]`);
} else {
  ok('배송지 노출 대상 = courier 뿐 (방문 전달·구매 요청은 제외)');
}
const inPerson = DELIVERY_METHODS.find((d) => d.value === 'direct');
if (inPerson && /delivery/i.test(inPerson.en) && DELIVERY_NEEDS_SHIPPING.includes('direct')) {
  fail("'In-person delivery' 라벨이 배송형으로 잡혔다 — 라벨 정규식 판정이 되살아났다");
}

// ── ④ 서버 검증 함수 ─────────────────────────────────────
const CASES = [
  // [설명, 입력, 기대 error(통과면 null)]
  ['빈 문자열(일반 문의)', '', null],
  ['깨진 JSON — 막지 않는다', '{oops', null],
  ['옛 형식(preFilm 없음, delivery=courier)', JSON.stringify({ v: 1, delivery: 'courier', seq: [] }), null],
  ['옛 형식(delivery=direct)', JSON.stringify({ v: 1, delivery: 'direct' }), null],
  ['새 선택지 purchase', JSON.stringify({ v: 1, delivery: 'purchase' }), null],
  ['웨이퍼 문의 형식 — 대상 아님', JSON.stringify({ wafer: { sku: 'x', qty: 1 } }), null],
  ['허용 밖 delivery', JSON.stringify({ v: 1, delivery: 'teleport' }), 'invalid_delivery'],
  ['preFilm 없음', JSON.stringify({ v: 1, delivery: 'purchase', preFilm: false, preFilmNote: '' }), null],
  ['preFilm 있음 + 내용', JSON.stringify({ v: 1, delivery: 'courier', preFilm: true, preFilmNote: 'Pt 100nm' }), null],
  ['preFilm 있음인데 내용 비었다', JSON.stringify({ v: 1, delivery: 'courier', preFilm: true, preFilmNote: '   ' }), 'missing_prefilm_note'],
  ['preFilm 있음인데 필드 자체가 없다', JSON.stringify({ v: 1, preFilm: true }), 'missing_prefilm_note'],
  ['preFilm 이 boolean 이 아니다', JSON.stringify({ v: 1, preFilm: 'yes' }), 'invalid_prefilm'],
];
let caseBad = 0;
for (const [label, input, expected] of CASES) {
  const r = validateQuoteDetails(input);
  const got = r.ok ? null : r.error;
  if (got !== expected) {
    fail(`${label}: 기대 ${expected ?? '통과'} · 실제 ${got ?? '통과'}`);
    caseBad++;
  }
}
if (!caseBad) ok(`서버 검증 ${CASES.length}종 통과·차단 의도대로`);

// ── ⑤ 박막 증착 여부 저장값 정규화 ──────────────────────
// 화면은 '없음'으로 되돌려도 입력을 지우지 않는다 → 저장값을 비우는 책임은 이 함수 하나뿐이다.
const PF = [
  ['있음 + 내용', '1', 'ex) Pt 전극 Pattern 100nm', true, 'ex) Pt 전극 Pattern 100nm'],
  ['있음 + 앞뒤 공백', '1', '  Pt 100nm  ', true, 'Pt 100nm'],
  ['없음 + 내용 남아 있음 → 저장값은 빈 문자열', '0', '되돌리기 전에 적어둔 내용', false, ''],
  ['없음 + 내용 없음', '0', '', false, ''],
  ['값 자체가 없음(옛 폼)', undefined, undefined, false, ''],
];
let pfBad = 0;
for (const [label, raw, note, wantFlag, wantNote] of PF) {
  const r = preFilmFields(raw, note);
  if (r.preFilm !== wantFlag || r.preFilmNote !== wantNote) {
    fail(`preFilmFields — ${label}: 기대 {${wantFlag}, ${JSON.stringify(wantNote)}} · 실제 {${r.preFilm}, ${JSON.stringify(r.preFilmNote)}}`);
    pfBad++;
  }
}
if (!pfBad) ok(`박막 증착 여부 저장값 정규화 ${PF.length}종 (되돌림 시 note 비움 포함)`);

// 정규화 결과를 그대로 서버 검증에 넣어도 통과해야 한다(두 규칙이 어긋나면 제출이 막힌다)
{
  const { preFilm, preFilmNote } = preFilmFields('0', '되돌리기 전에 적어둔 내용');
  const r = validateQuoteDetails(JSON.stringify({ v: 1, delivery: 'purchase', preFilm, preFilmNote }));
  if (!r.ok) fail(`정규화 결과가 서버 검증에 막혔다: ${r.error}`);
  else ok('정규화 결과 ↔ 서버 검증 정합');
}

if (bad) {
  console.error(`\n✗ 견적 폼 필드 게이트 실패 — ${bad}건`);
  process.exit(1);
}
console.log('✓ 견적 폼 필드 게이트 통과 — 전달 방식 값 불변 · 배송 판정 · 서버 검증');
