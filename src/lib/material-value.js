// 소재 라이브러리의 화학식(formula) → 견적 폼의 소재 value 문자열.
//
// 왜 한 곳에 두는가: 같은 문자열을 세 곳이 만든다 —
//   ① 견적 폼 소재 옵션 파생            (src/lib/processes.ts)
//   ② "이 물질로 견적 문의" CTA 의 ?material=  (MaterialsLibrary.astro / MaterialDetail.astro)
//   ③ 그 링크를 받아 폼을 채우는 프리필   (QuoteForm.astro 클라이언트 스크립트)
// 세 곳이 각자 만들면 한 글자만 어긋나도 프리필이 "조용히 무시"로 끝난다(원인 추적 불가).
// → 문자열을 만드는 함수는 이 파일의 materialValue 하나뿐이다.
//
// ⚠️ .ts 가 아니라 .js 인 이유: Astro(.astro/.ts)와 node 검증 스크립트
//    (scripts/check-material-values.mjs)가 빌드 없이 같은 파일을 그대로 import 해야 한다.
//    타입은 JSDoc 으로 붙인다(tsconfig 의 allowJs 로 타입 검사 대상에 들어온다).

/** 유니코드 아래첨자 → ASCII. Al₂O₃ → Al2O3, SiNₓ → SiNx */
const SUBSCRIPTS = /** @type {Record<string, string>} */ ({
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', 'ₓ': 'x',
});

/**
 * 정규화 예외표 — [정규화한 문자열 → 실제로 써야 할 value].
 *
 * 등재 기준은 하나뿐이다: **정규화만 하면 이미 쓰이고 있는 기존 value 와 달라지는 것**.
 * 기존 value 는 견적 요청 payload·D1 저장·구글챗 알림·조회 화면에 그대로 남아 있으므로
 * 바꾸면 과거 데이터와 어긋난다.
 *   - SiNₓ: 정규화하면 "SiNx" 지만, 폼의 기존 value 는 "SiN" 이다.
 * 누락은 scripts/check-material-values.mjs 가 기존 value 전수 대조로 잡는다.
 */
export const VALUE_EXCEPTIONS = /** @type {Record<string, string>} */ ({
  SiNx: 'SiN',
});

/**
 * 화학식을 견적 폼 value 로 바꾼다. 이미 ASCII 인 값(주소창에서 돌아온 ?material=)을
 * 다시 넣어도 같은 결과가 나온다(멱등).
 * @param {string} formula 예: 'Al₂O₃' | 'Al2O3' | 'SiNₓ'
 * @returns {string} 예: 'Al2O3' | 'Al2O3' | 'SiN'
 */
export function materialValue(formula) {
  const ascii = String(formula ?? '').replace(/[₀-₉ₓ]/g, (c) => SUBSCRIPTS[c] ?? c);
  return VALUE_EXCEPTIONS[ascii] ?? ascii;
}

/**
 * 그룹 안 정렬 키 — MaterialsLibrary.astro 의 칩 정렬과 같은 규칙(소문자 알파벳순).
 * @param {string} value
 */
export function materialSortKey(value) {
  return materialValue(value).toLowerCase();
}

// ── 라이브러리 system ↔ 견적 폼 공정 ─────────────────────────────
// 라이브러리의 system 은 sputter(= "PVD — Sputter & Evaporator")·ald 두 가지뿐이다.
// 폼은 Sputter 와 Evaporator 를 따로 받으므로, 라이브러리에선 sputter 로 분류돼 있어도
// 실제로는 Evaporator 로만 증착하는 물질을 아래 EVAPORATOR_ONLY 에 적는다.
//   → processes.ts: Sputter 선택지에서 빠지고 Evaporator 선택지에 들어간다.
//   → QuoteForm 프리필: CTA 의 ?system=sputter&material=Ag 를 Evaporator + Ag 로 채운다.
// 쓰는 곳이 서버(processes.ts)·클라이언트(QuoteForm 프리필)·node 게이트 셋이라 여기(.js) 둔다.

/** 라이브러리 system → 견적 폼 공정 이름 (기본 대응) */
export const SYSTEM_TO_PROCESS = /** @type {Record<string, string>} */ ({ sputter: 'Sputter', ald: 'ALD' });

/** 라이브러리에선 sputter(PVD)지만 폼에서는 Evaporator 로만 받는 물질 (폼 value) */
export const EVAPORATOR_ONLY = /** @type {readonly string[]} */ (Object.freeze(['Ag', 'Te']));

/**
 * CTA 의 ?system= · ?material= → 견적 폼 공정 이름. 대응이 없으면 ''.
 * @param {string} system 'sputter' | 'ald' (대소문자·공백 무시)
 * @param {string} material 폼 value 또는 라이브러리 화학식
 * @returns {string}
 */
export function formProcessFor(system, material) {
  const sys = String(system ?? '').trim().toLowerCase();
  // hasOwnProperty.call — ?system=__proto__ 같은 값이 프로토타입을 집어 오지 않게(Object.hasOwn 은 구형 사파리에 없다)
  const base = Object.prototype.hasOwnProperty.call(SYSTEM_TO_PROCESS, sys) ? SYSTEM_TO_PROCESS[sys] : '';
  if (base === 'Sputter' && EVAPORATOR_ONLY.includes(materialValue(material))) return 'Evaporator';
  return base;
}

/**
 * 견적 폼으로 보내는 CTA 링크의 쿼리·해시.
 * @param {string} system 'sputter' | 'ald'
 * @param {string} formula 라이브러리 표기 화학식
 */
export function quoteParams(system, formula) {
  return `?material=${encodeURIComponent(materialValue(formula))}&system=${encodeURIComponent(system)}#quote`;
}

// ── 소재 분류 ↔ 제품 페이지 ↔ 폼 필터 ────────────────────────────
// 두 표가 서로 맞물려야 CTA 가 살아 있다:
//   CATEGORY_TO_PRODUCT 가 소재를 어떤 제품 페이지로 보내고,
//   그 페이지의 PRODUCT_MAT_FILTER 가 그 분류를 통과시켜야 소재가 드롭다운에 남는다.
// 어긋나면 링크는 열리는데 프리필만 조용히 실패한다(0907b 의 Si 가 정확히 그랬다).
// → 두 표를 한 파일에 두고, scripts/check-material-values.mjs 가 정합을 강제한다.

/**
 * 소재 분류 → 견적 폼이 있는 제품 페이지 ID.
 * 여기 없는 분류는 /contact 로 폴백한다(새 분류가 생겼는데 갈 제품이 없을 때의 안전망).
 * Semiconductor(Si)는 전용 제품이 없어 금속 페이지에서 함께 받는다.
 */
export const CATEGORY_TO_PRODUCT = /** @type {Record<string, string>} */ ({
  Oxide: 'oxides',
  Nitride: 'nitrides',
  Metal: 'metals',
  Semiconductor: 'metals',
});

/**
 * 제품 ID(products/*.json 파일명) → 그 페이지의 물질 드롭다운에 보일 분류.
 * 목록에 없는 제품(wafers 등)은 전체 노출(null).
 * 'gas' 는 플라즈마·열처리 공정용이라 증착 제품 페이지에는 항상 함께 둔다.
 */
export const PRODUCT_MAT_FILTER = /** @type {Record<string, string[] | null>} */ ({
  oxides: ['Oxide', 'gas'],
  nitrides: ['Nitride', 'gas'],
  // Semiconductor(Si)는 금속 페이지에서 받는다 — CATEGORY_TO_PRODUCT 와 짝이다.
  metals: ['Metal', 'Semiconductor', 'gas'],
  multilayers: null, // 다층은 전체 물질 조합
});
