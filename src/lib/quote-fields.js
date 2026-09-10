// 견적 폼의 "선택지 데이터"와 그 값을 검사하는 순수 함수.
//
// 왜 .ts 가 아니라 .js 인가: material-value.js 와 같은 이유다.
//   Astro(.astro/.ts)와 node 검증 스크립트(scripts/check-quote-fields.mjs)가
//   **빌드 없이 같은 파일을 그대로 import** 해야 한다. 타입은 JSDoc 으로 붙인다.
//
// 왜 한 곳에 두는가: 같은 목록을 세 곳이 본다 —
//   ① 폼의 <select> 선택지        (QuoteForm.astro, processes.ts 경유)
//   ② 배송지 블록 노출 판정        (QuoteForm.astro 의 shipValues)
//   ③ 서버 허용값 검증            (src/pages/api/inquiry.ts)
// 세 곳이 각자 목록을 들면 하나만 고쳐져도 증상 없이 어긋난다.

/**
 * 기판 전달 방식.
 *
 * ⚠️ value 는 **저장되는 코드값**이라 바꾸지 않는다.
 *    D1(inquiries.details_json.delivery)의 기존 접수 건이 전부 'courier' 로 굳어 있다.
 *    라벨만 바꾸고, 새 방식은 값을 추가한다.
 *
 * ⚠️ needsShipping 이 배송지 블록을 띄울지의 단일 출처다.
 *    예전에는 라벨에 정규식(/courier|delivery|택배/)을 돌려 판정했는데,
 *    'In-person delivery'(방문 전달)처럼 라벨에 delivery 가 들어가는 순간
 *    방문 전달에도 배송지가 뜨고 필수까지 걸린다.
 *
 * @type {{ value: string; en: string; ko: string; needsShipping?: boolean }[]}
 */
export const DELIVERY_METHODS = [
  { value: 'direct', en: 'In-person delivery', ko: '방문 전달' },
  { value: 'courier', en: 'Courier', ko: '택배', needsShipping: true },
  // 구매 요청: 반암이 기판을 대신 구매한다. 고객이 보낼 기판이 없으므로 배송지도 받지 않는다.
  { value: 'purchase', en: 'Purchase request', ko: '구매 요청' },
];

/** 서버 검증용 허용값 목록 — 폼 선택지에서 파생한다(별도 목록을 두지 않는다). */
export const DELIVERY_VALUES = DELIVERY_METHODS.map((d) => d.value);

/** 배송지 입력이 필요한 전달 방식(코드값). */
export const DELIVERY_NEEDS_SHIPPING = DELIVERY_METHODS.filter((d) => d.needsShipping).map((d) => d.value);

/**
 * 견적 폼이 보낸 구조화 사본(details_json)의 최소 검증.
 *
 * 설계 원칙 — **모르는 것은 통과시킨다.**
 *   이 함수가 막는 순간 고객의 견적이 사라진다. 그래서 확실히 틀린 것만 막는다:
 *     · delivery 가 있는데 허용 목록에 없다 → 차단
 *     · preFilm 이 boolean 이 아니다        → 차단
 *     · preFilm 이 true 인데 메모가 비었다  → 차단
 *   파싱 실패·필드 없음·웨이퍼 문의 형식은 전부 통과(옛 클라이언트·다른 폼 호환).
 *
 * @param {string} detailsJson  폼이 보낸 JSON 문자열 (빈 문자열 허용)
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateQuoteDetails(detailsJson) {
  if (!detailsJson) return { ok: true };

  let dj;
  try {
    dj = JSON.parse(detailsJson);
  } catch {
    // 깨진 JSON 은 여기서 막지 않는다 — 저장은 되고 조회 화면이 옛 문장으로 폴백한다.
    return { ok: true };
  }
  if (!dj || typeof dj !== 'object' || Array.isArray(dj)) return { ok: true };
  // 웨이퍼 문의(0829)는 형태가 완전히 다르다 — 이 검사의 대상이 아니다.
  if (dj.wafer) return { ok: true };

  const delivery = typeof dj.delivery === 'string' ? dj.delivery.trim() : '';
  if (delivery && !DELIVERY_VALUES.includes(delivery)) {
    return { ok: false, error: 'invalid_delivery' };
  }

  if ('preFilm' in dj) {
    if (typeof dj.preFilm !== 'boolean') return { ok: false, error: 'invalid_prefilm' };
    const note = typeof dj.preFilmNote === 'string' ? dj.preFilmNote.trim() : '';
    if (dj.preFilm && !note) return { ok: false, error: 'missing_prefilm_note' };
  }

  return { ok: true };
}

/**
 * 박막 증착 여부의 **저장값** 정규화.
 *
 * 화면은 '있음 → 없음'으로 되돌려도 입력값을 지우지 않는다(잘못 눌렀다 되돌릴 때 복구가 안 됐다).
 * 그래서 "없음이면 메모를 비운다"는 규칙은 화면이 아니라 제출 조립 시점에 여기서 한 번만 적용한다.
 * 문장(details)·구조화 사본(details_json)·요약(lines) 세 곳이 전부 이 결과를 본다.
 *
 * @param {unknown} raw   라디오 값 — '1'(있음) / '0'(없음)
 * @param {unknown} note  자유 입력
 * @returns {{ preFilm: boolean, preFilmNote: string }}
 */
export function preFilmFields(raw, note) {
  const preFilm = String(raw ?? '') === '1';
  return {
    preFilm,
    preFilmNote: preFilm ? String(note ?? '').trim() : '',
  };
}
