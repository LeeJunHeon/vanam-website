// 고객이 넣은 글을 우리 메일·화면에 실을 때 — 순수 모듈(.js). 서버(확인 메일)와 브라우저(조회 화면)가 같이 쓴다.
//
// 왜: 견적 요청은 누구나 넣을 수 있다. 남이 넣은 글(상품 이름·공정·요청 내용)이 회사 메일(hello@)이나
//   vanam.co.kr 조회 화면에 그대로 실리면, 주소를 끼워 넣은 피싱 문구('입금 계좌 변경 …')의 통로가 된다.
//   그래서 주소 모양은 링크가 되지 않게 바꾸고(defang), 한 줄로 보이는 곳은 짧게 자른다(safeShort).
//   글자 이스케이프(HTML)는 각 화면이 따로 한다 — 여기서는 글 내용만 다룬다.

const str = (v) => (v == null ? '' : String(v).trim());

/** 앞에서부터 n 글자(넘치면 …) · 공백·줄바꿈은 한 칸으로 */
export function clip(v, n) {
  const s = str(v).replace(/\s+/g, ' ');
  const cs = [...s];
  return cs.length > n ? `${cs.slice(0, n - 1).join('')}…` : s;
}

/**
 * 주소 모양을 링크가 안 되게 — http[:]// · www[.] · evil[.]com. 줄바꿈·길이는 그대로(여러 줄 요청 내용에도 쓴다).
 * @param {unknown} v
 */
export function defang(v) {
  return String(v ?? '')
    .replace(/(https?|ftp):\/\//gi, '$1[:]//')
    .replace(/\b(www)\./gi, '$1[.]')
    .replace(/([A-Za-z0-9-])\.(?=[A-Za-z]{2,}\b)/g, '$1[.]');
}

/**
 * 한 줄로 실을 짧은 글(이름·소속·상품·공정) — 길이를 줄이고 주소 모양은 링크가 되지 않게.
 * @param {unknown} v @param {number} n
 */
export function safeShort(v, n) {
  return defang(clip(v, n));
}
