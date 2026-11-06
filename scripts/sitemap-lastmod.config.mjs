// 사이트맵 lastmod 설정 — 본문 지문에서 뺄 요소와 기록 파일 위치. (사용법은 scripts/sitemap-lastmod.mjs 상단)
//
// 지문 대상은 각 페이지의 <main> 글자다. header·nav·footer·상단 배너·팝업·SNS 버튼·맨 위로 버튼은
// BaseLayout 에서 <main> 밖에 있어 따로 적지 않아도 빠진다. script·style·noscript·template(ld+json 포함)도 항상 빠진다.
// 아래에는 "<main> 안에 있지만 본문 내용이 아닌 것"만 적는다. HTML 은 고치지 않는다.
export default {
  // 지문 기록 파일(커밋 대상). { "<URL 경로>": { "hash": "<sha256>", "date": "YYYY-MM-DD" } }
  record: 'src/data/sitemap-lastmod.json',

  // 지문에서 통째로 빼는 요소 (지원 선택자: tag, .class, #id, [attr], [attr="값"] 과 그 조합)
  exclude: [
    '.cart-count', // 장바구니 개수 배지 — 방문자 브라우저마다 다른 숫자(빌드 결과는 항상 0)
  ],

  // 글자 대신 속성값을 지문에 쓰는 요소 — 달러 환산 표시.
  //   화면의 "$652.17" 은 원화 가격 ÷ 환율(company.usdRate, 방문 시 실시간 환율로 다시 계산)이라 환율만 바뀌어도 달라진다.
  //   원화 가격(data-krw)은 콘텐츠에서 오는 진짜 내용이므로 그 값을 지문에 넣고, 환산된 달러 글자는 넣지 않는다.
  textFromAttr: [
    { selector: '[data-krw]', attr: 'data-krw' },
    { selector: '#est-total', attr: 'data-unit-krw' }, // 웨이퍼 상세 "예상 합계"
  ],

  // 사이트맵에는 있지만 dist/client 에 정적 HTML 이 없는 URL(SSR 등). 여기 적힌 URL 만 lastmod 없이 내보낼 수 있다.
  // (현재 없음 — 사이트맵 URL 262개가 모두 정적 HTML 과 1:1 대응)
  noHtmlUrls: [],
};
