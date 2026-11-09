// 내부 링크 주소 규칙 — 사이트 안을 가리키는 href 는 이 파일의 함수로 만든다.
//
// 정식 주소는 사이트맵과 같은 "끝 슬래시 있는" 형태다(/technology/, /ko/contact/#inquiry).
// Cloudflare 는 /technology 처럼 슬래시 없는 요청을 301 로 /technology/ 에 보내므로,
// 링크를 처음부터 정식 주소로 걸어야 방문자·크롤러가 매번 한 번씩 더 돌지 않는다.
//
//   canonicalPath('/contact#inquiry')      → '/contact/#inquiry'
//   canonicalPath('/quote/done?id=Q1')     → '/quote/done/?id=Q1'
//   canonicalPath('/order/lookup')          → '/order/lookup'   (서버 경로 — 아래 예외 목록, 그대로)
//   canonicalPath('/faq-search.json')       → 그대로           (파일)
//   localePath('ko', '/contact#inquiry')    → '/ko/contact/#inquiry'
//   localePath('ko', '/')                   → '/ko/'
//
// 외부 주소(https://…, mailto:, tel:)와 페이지 안 앵커('#team')는 손대지 않는다.
// 검사는 scripts/check-internal-links.mjs 가 빌드 결과 전체에서 한다(이 파일의 예외 목록을 같이 쓴다).
// ⚠️ Astro 쪽은 .ts 가 아니라 이 .js 를 그대로 import 한다 — node 검사 스크립트와 같은 파일을 써야 규칙이 한 곳에만 있다.

/**
 * 끝 슬래시 없이 바로 200 을 주는 서버(SSR) 경로. 정적 HTML 이 없어 Cloudflare 가 301 을 내지 않는다.
 * 이 경로(와 /ko 접두사 형태)는 끝 슬래시를 붙이지 않고 그대로 둔다.
 *   src/pages 의 prerender = false 페이지와 같은 목록이어야 한다(API 경로 /api/… 는 아래에서 따로 제외).
 */
export const SERVER_PATHS = ['/checkout', '/order/lookup', '/order/done'];

const stripKo = (p) => (p === '/ko' ? '/' : p.startsWith('/ko/') ? p.slice(3) : p);

/** 서버 경로인가 (끝 슬래시·/ko 접두사 무시) */
export const isServerPath = (p) => {
  const bare = stripKo(p).replace(/\/$/, '') || '/';
  return bare.startsWith('/api/') || SERVER_PATHS.includes(bare);
};

/** 확장자가 있는 파일 경로인가 (/faq-search.json, /og.png, /llms.txt) */
export const isFilePath = (p) => /\.[a-z0-9]+$/i.test(p);

/** 사이트 안을 가리키는 href 인가 ('/' 로 시작, '//' 제외) */
export const isInternalHref = (href) => typeof href === 'string' && href.startsWith('/') && !href.startsWith('//');

/**
 * href 의 경로 부분을 정식 주소(끝 슬래시)로 만든다. 쿼리(?)와 앵커(#)는 그 뒤에 그대로 붙인다.
 * 내부 경로가 아니면(외부 주소·mailto·'#앵커'·빈 값) 그대로 돌려준다.
 */
export function canonicalPath(href) {
  if (!isInternalHref(href)) return href;
  const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(href);
  const [, p, query = '', hash = ''] = m;
  if (!p || p.endsWith('/') || isFilePath(p) || isServerPath(p)) return href;
  return `${p}/${query}${hash}`;
}

/**
 * 언어 접두사를 붙인 정식 주소. path 는 접두사 없는 경로('/contact#inquiry', '/', '/product/oxides').
 * 이미 /ko 로 시작하는 경로를 ko 로 넘겨도 접두사를 두 번 붙이지 않는다.
 */
export function localePath(locale, path) {
  if (!isInternalHref(path)) return path;
  const ko = locale === 'ko';
  const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(path);
  let [, p, query = '', hash = ''] = m;
  if (ko && !(p === '/ko' || p.startsWith('/ko/'))) p = p === '/' ? '/ko/' : `/ko${p}`;
  return canonicalPath(`${p}${query}${hash}`);
}
