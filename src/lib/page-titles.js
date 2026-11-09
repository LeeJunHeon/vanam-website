// 페이지 <title> 규칙 — 데이터 파일에 metaTitle 이 없는 페이지의 제목을 여기서 만든다. (GEO 정리 2차)
//
//   · 제품 분류 페이지(/product/<id>/) — 제품 이름(h1)은 그대로 두고 뒤에 설명을 덧붙인 제목. 제품 id 별 표.
//   · 소재 상세 페이지(/materials/<id>/) — 소재 데이터(이름·화학식·증착 방식·분류)에서 규칙으로 만든다. 문자열을 소재별로 적지 않는다.
//   · 그 밖의 페이지(기술·소재 라이브러리·FAQ·문의·인사이트·웨이퍼 목록)는 site.json / src/lib/faq.ts 의 metaTitle 을 그대로 쓴다.
// 제목은 og:title 에도 같은 값이 들어간다(BaseLayout). 기대값 대조는 scripts/check-page-titles.mjs 가 빌드 결과에서 한다.

/** 브랜드 접미사 — 영문 " | VanaM", 한국어 " | 반암(VanaM)" */
export const brandSuffix = (locale) => (locale === 'ko' ? ' | 반암(VanaM)' : ' | VanaM');

/** 제품 분류 페이지 제목 (접미사 포함). 표에 없는 제품은 호출부가 `${이름}${brandSuffix}` 로 폴백한다. */
export const PRODUCT_TITLES = {
  oxides: { en: 'Oxides — Custom Oxide Thin-Film Deposition', ko: '산화물 박막 — 맞춤 증착' },
  nitrides: { en: 'Nitrides — Custom Nitride Thin-Film Deposition', ko: '질화물 박막 — 맞춤 증착' },
  metals: { en: 'Metals — Custom Metal Thin-Film Deposition', ko: '금속 박막 — 맞춤 증착' },
  multilayers: { en: 'Multilayers — Custom Multilayer Thin-Film Stacks', ko: '다층 박막 — 맞춤 적층' },
  wafers: { en: 'Wafers — Bare & Thin-Film-Coated', ko: '웨이퍼 — 베어·박막 코팅 웨이퍼' },
};
export const productTitle = (id, locale) => {
  const t = PRODUCT_TITLES[id]?.[locale === 'ko' ? 'ko' : 'en'];
  return t ? t + brandSuffix(locale) : undefined;
};

/**
 * 소재 상세 페이지 제목.
 *   영문:   {이름} ({화학식}) Thin Film — {PVD|ALD} | VanaM
 *   한국어: {한글명} ({화학식}) 박막 — {PVD|ALD} 증착 | 반암(VanaM)
 *   다층막(category Multilayer)만 Thin Film → Multilayer, 박막 → 다층막.
 * name / formula 는 페이지 h1 과 화학식 배지에 쓰는 값과 같아야 한다(호출부가 같은 변수를 넘긴다).
 */
export function materialTitle({ name, formula, system, category }, locale) {
  const ko = locale === 'ko';
  const sys = system === 'ald' ? 'ALD' : 'PVD';
  const multi = category === 'Multilayer';
  const kind = ko ? (multi ? '다층막' : '박막') : (multi ? 'Multilayer' : 'Thin Film');
  return `${name} (${formula}) ${kind} — ${sys}${ko ? ' 증착' : ''}${brandSuffix(locale)}`;
}
