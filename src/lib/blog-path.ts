// 블로그 글 상세 경로를 만드는 **유일한 함수**.
//
// 왜 한 곳에 두는가: 끝 슬래시가 빠지면 화면은 멀쩡한데 링크마다 307 이 한 번 더 붙고,
// 사이트맵의 정본 URL(/blog/<slug>/)과 링크·JSON-LD 가 서로 다른 주소를 가리키게 된다.
// 실제로 News 카드 53개와 BlogPosting 의 url·mainEntityOfPage 가 전부 슬래시 없이 나가고 있었다.
// 두 곳이 각자 문자열을 만들면 한쪽만 고쳐져 다시 어긋나므로, 조립은 여기서만 한다.
//
// ⚠️ 끝 슬래시는 선택이 아니다 — Astro 가 생성하는 정적 경로가 /blog/<slug>/ 이고,
//    BaseLayout 의 canonical 도 Astro.url.pathname(= 슬래시 포함)에서 나온다.

/**
 * @param base   로캘 접두사 — 한글 '/ko', 영문 ''
 * @param id     글 슬러그(content/blog 의 파일명)
 * @returns      예: '/ko/blog/ces-2025-wrap-up/'
 */
export function blogPath(base: string, id: string): string {
  return `${base}/blog/${id}/`;
}
