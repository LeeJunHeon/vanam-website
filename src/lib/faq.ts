// FAQ — 대표님 확정 FAQ 38개(src/data/faq.json)를 읽는 유일한 지점.
//
// 화면의 FAQ 영역(FaqSection.astro) · FAQPage 구조화 데이터 · 관련 질문 링크(FaqRelated.astro) ·
// 색인 페이지(/faq/, pages/Faq.astro) · 검색 JSON(/faq-search.json)이 모두 여기서 받는다.
// (llms 의 FAQ 목록·답 원문과 게이트는 node 스크립트라 같은 데이터 파일을 직접 읽는다 — scripts/lib/faq-data.mjs)
//
// ⚠️ 질문·답 문구는 확정본이다. 여기서도, 데이터 파일에서도 한 글자도 고치지 않는다.
//    데이터 파일은 scripts/extract-faq-docx.py 가 원본 docx 에서 만든다(손으로 고치지 않는다).
// ⚠️ 각 질문의 답은 사이트에서 한 곳(item.page)에만 있다. 다른 곳에서는 링크로만 연결한다.
import { getRelativeLocaleUrl } from 'astro:i18n';
import data from '../data/faq.json';

export type Loc = 'ko' | 'en';
export const toLoc = (locale: string | undefined): Loc => (locale === 'ko' ? 'ko' : 'en');

/** 분류(id 첫 글자)와 이름. 배열 순서 = 색인 페이지의 분류 순서. */
export const FAQ_GROUPS = [
  { key: 'E', ko: '일반', en: 'General' },
  { key: 'F', ko: '파운드리·주문·품질', en: 'Foundry, ordering & quality' },
  { key: 'Q', ko: '양자 포토닉스·SNSPD·PIC', en: 'Quantum photonics, SNSPD & PIC' },
  { key: 'M', ko: '산화물·ALD·금속·응용', en: 'Oxides, ALD, metals & applications' },
  { key: 'T', ko: '분석·공정개발·장비', en: 'Analysis, process development & equipment' },
] as const;

/** 답이 있는 페이지와 색인 페이지의 위치 표시. */
export const FAQ_PAGES: { page: string; ko: string; en: string }[] = [
  { page: '/contact/', ko: '문의', en: 'Contact' },
  { page: '/technology/', ko: '기술', en: 'Technology' },
  { page: '/product/', ko: '제품', en: 'Product' },
  { page: '/materials/', ko: '소재 라이브러리', en: 'Materials' },
  { page: '/materials/m01/', ko: 'VO₂', en: 'VO₂' },
  { page: '/materials/m11/', ko: 'AlScN', en: 'AlScN' },
];

/** 화면 문구(FAQ 영역 제목은 site.json contact.faqEyebrow · faqHeading 을 그대로 쓴다). */
export const FAQ_UI = {
  ko: {
    seeAll: '전체 질문 보기 →',
    related: '관련 질문',
    indexTitle: '자주 묻는 질문 — 박막 증착·소재·주문 | 반암(VanaM)',
    indexDescription: '반암의 박막 증착 서비스, 소재, 양자 포토닉스, 분석·장비에 관한 자주 묻는 질문을 한곳에서 찾아볼 수 있습니다.',
    searchLabel: '질문 검색',
    searchPlaceholder: '질문·답에서 검색',
    noResult: '검색 결과가 없습니다.',
    home: '홈',
    crumb: '자주 묻는 질문',
  },
  en: {
    seeAll: 'See all FAQs →',
    related: 'Related questions',
    indexTitle: 'FAQ — Thin-Film Deposition, Materials & Ordering | VanaM',
    indexDescription: "Find VanaM's frequently asked questions on thin-film deposition services, materials, quantum photonics, analysis and equipment in one place.",
    searchLabel: 'Search questions',
    searchPlaceholder: 'Search questions and answers',
    noResult: 'No matching questions.',
    home: 'Home',
    crumb: 'FAQ',
  },
} as const;

export type FaqEntry = {
  id: string;
  group: string;
  /** 답이 있는 페이지(언어 접두사 없는 경로) */
  page: string;
  /** 그 페이지 안의 앵커 id (faq-e01) */
  anchor: string;
  q: string;
  a: string;
  /** 같은 언어의 답 위치 주소 (/ko/contact/#faq-e01) */
  href: string;
  /** 색인 페이지의 위치 표시 */
  where: string;
};
export type FaqGroup = { key: string; label: string; items: FaqEntry[] };

const entry = (it: (typeof data.items)[number], loc: Loc): FaqEntry => ({
  id: it.id,
  group: it.group,
  page: it.page,
  anchor: it.anchor,
  q: it[loc].q,
  a: it[loc].a,
  href: `${getRelativeLocaleUrl(loc, it.page)}#${it.anchor}`,
  where: FAQ_PAGES.find((p) => p.page === it.page)?.[loc] ?? it.page,
});

const grouped = (items: FaqEntry[], loc: Loc): FaqGroup[] =>
  FAQ_GROUPS.map((g) => ({ key: g.key, label: g[loc], items: items.filter((x) => x.group === g.key) })).filter((g) => g.items.length);

/** 38개 전체 — 원본 순서(E, F, Q, M, T). */
export const faqAll = (loc: Loc): FaqEntry[] => data.items.map((it) => entry(it, loc));

/** 색인 페이지용 — 분류별 전체. */
export const faqIndexGroups = (loc: Loc): FaqGroup[] => grouped(faqAll(loc), loc);

/** 한 페이지에 답이 있는 항목 — 분류별(그 페이지에 처음 나오는 순서). page 는 '/contact/' 같은 언어 접두사 없는 경로. */
export function faqGroupsFor(page: string, loc: Loc): FaqGroup[] {
  const items = faqAll(loc).filter((x) => x.page === page);
  const order = [...new Set(items.map((x) => x.group))];
  return grouped(items, loc).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/** 관련 질문 링크 — 이 페이지에 질문 문구만 링크로 보여줄 항목(답은 다른 페이지에 있다). 데이터에 적힌 순서 그대로. */
export function faqRelatedFor(page: string, loc: Loc): FaqEntry[] {
  const ids = (data.related as Record<string, string[]>)[page] ?? [];
  const all = faqAll(loc);
  return ids.map((id) => all.find((x) => x.id === id)).filter((x): x is FaqEntry => !!x);
}

/**
 * 한 페이지에 보여줄 질문 전체 — 그 페이지에 답이 있는 항목(FaqSection 이 그리는 것) 다음에 관련 질문(FaqRelated 가 그리는 것).
 * 소재 라이브러리의 모달이 소재 상세 페이지와 같은 목록을 쓰기 위한 것이다(대상을 따로 적지 않는다).
 */
export const faqShownOn = (page: string, loc: Loc): FaqEntry[] => [
  ...faqGroupsFor(page, loc).flatMap((g) => g.items),
  ...faqRelatedFor(page, loc),
];

/** 색인 페이지 주소(같은 언어). */
export const faqIndexHref = (loc: Loc) => getRelativeLocaleUrl(loc, '/faq/');
