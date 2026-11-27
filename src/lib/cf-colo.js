// 요청이 실행된 Cloudflare 위치(데이터센터 코드 — 예: ICN · NRT · HKG) 읽기 — 순수 모듈(.js, import 없음).
//
// 왜: 11-26 메일 발송이 요청에 따라 실패했는데, 실패한 요청이 어느 위치에서 돌았는지 남은 기록이 없었다.
//   메일 실패 로그·기록(inquiries.ack_mail · staff_mail)·오류 알림에 이 값을 같이 남겨 다음에 바로 가릴 수 있게 한다.
// 어디서 읽나: Astro v6 + @astrojs/cloudflare v13 에서는 API 경로가 받는 request 가 워커가 받은 원래 Request 라
//   request.cf.colo 로 읽는다(어댑터 안내: "Use 'Astro.request.cf' instead").
//   ⚠️ 옛 경로 locals.runtime.cf 는 접근만 해도 예외를 던진다(src/lib/fx.ts 의 pickWaitUntil 주석) — 쓰지 않는다.
// ⚠️ 진단용 값이다 — 읽지 못해도 접수·발송은 그대로 진행한다(빈 값). 관리자 화면·로그·구글챗 알림에만 쓰고 고객 화면에는 내보내지 않는다.

const COLO_RE = /^[A-Z]{3,4}$/;

/** 위치 코드 모양(영문 대문자 3~4자)이면 그대로, 아니면 빈 값 @param {unknown} v @returns {string} */
export function coloText(v) {
  return typeof v === 'string' && COLO_RE.test(v) ? v : '';
}

/** 요청의 실행 위치 — 읽지 못하면 빈 값. 예외를 던지지 않는다. @param {unknown} request @returns {string} */
export function requestColo(request) {
  try {
    return coloText(/** @type {any} */ (request)?.cf?.colo);
  } catch {
    return '';
  }
}
