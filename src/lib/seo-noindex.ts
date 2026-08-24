// 검색 비노출 경로의 단일 출처(Single Source of Truth).
//   - astro.config.mjs 의 sitemap filter 와
//   - BaseLayout 의 <meta name="robots" content="noindex"> 조건이
//   반드시 같은 목록을 보게 하여, 두 곳이 어긋나는 드리프트를 원천 차단한다.
//   여기에 경로를 추가하면 EN·KO 양쪽 모두 "사이트맵 제외 + noindex"가 동시에 적용된다.
//
// 왜 이 페이지들인가: 장바구니·결제·완료·조회는 개인 세션 전용 화면이라
// 검색 결과에 노출될 이유가 없고, 노출되면 빈 화면·오류 화면이 색인된다.

/** locale 접두사(/ko)와 끝 슬래시를 뗀 '순수 경로' 기준 목록 */
export const NOINDEX_PATHS = [
  '/admin',        // 관리자 — 자체 <head>에 noindex 보유. 여기서는 사이트맵 제외용.
  '/cart',         // 장바구니
  '/checkout',     // 결제
  '/order/done',   // 주문 완료
  '/order/lookup', // 주문 조회
  '/quote/done',   // 견적 완료
] as const;

/** pathname 이 비노출 대상인지. '/ko/cart/' · '/cart' 등 형태 차이를 흡수한다. */
export function isNoindexPath(pathname: string): boolean {
  let p = pathname.replace(/\/+$/, '') || '/'; // 끝 슬래시 제거
  if (p.startsWith('/ko/')) p = p.slice(3);    // locale 접두사 제거
  else if (p === '/ko') p = '/';
  return (NOINDEX_PATHS as readonly string[]).includes(p);
}
