// 회신 기한 "영업일 기준 N일" — 화면(견적 폼·완료 화면)과 메일이 같이 쓰는 아주 작은 모듈.
// 공개 화면 번들에 들어가므로 여기에는 회신 기한만 둔다(다른 운영 값·상한은 site-settings.js — 화면 번들에 넣지 않는다).
export const REPLY_DAYS = Object.freeze({ def: 2, min: 1, max: 14 });

/**
 * 문구의 {days} 를 회신 기한으로 바꾼다(이상한 값이면 기본값).
 * @param {string} text @param {unknown} days
 */
export function fillDays(text, days) {
  const n = Number(days);
  const v = Number.isInteger(n) && n >= REPLY_DAYS.min && n <= REPLY_DAYS.max ? n : REPLY_DAYS.def;
  return String(text ?? '').replace(/\{days\}/g, String(v));
}
