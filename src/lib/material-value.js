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

/**
 * 견적 폼으로 보내는 CTA 링크의 쿼리·해시.
 * @param {string} system 'sputter' | 'ald'
 * @param {string} formula 라이브러리 표기 화학식
 */
export function quoteParams(system, formula) {
  return `?material=${encodeURIComponent(materialValue(formula))}&system=${encodeURIComponent(system)}#quote`;
}
