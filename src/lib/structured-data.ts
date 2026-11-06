// Schema.org 구조화 데이터(JSON-LD) 노드 생성 — 이 파일이 유일한 출처다. 페이지·컴포넌트는 여기 함수만 부른다.
//
// 원칙: 값은 모두 "그 페이지 화면에 실제로 보이는 내용"이다.
//   - 호출하는 쪽이 화면 렌더링에 쓰는 바로 그 변수를 넘긴다(컬렉션을 따로 다시 읽지 않는다).
//   - 이 파일에는 화면에 없는 문구를 새로 만드는 코드가 없다. 고정 분류어(serviceType)와
//     Service·Dataset 이름의 고정 어구("… thin film deposition" 등)만 예외다.
//   - scripts/check-structured-data.mjs 가 빌드 결과에서 이 규칙을 기계적으로 검사한다.

export const SITE = 'https://vanam.co.kr';
export const ORG_ID = `${SITE}/#organization`;
export const WEBSITE_ID = `${SITE}/#website`;
const CTX = 'https://schema.org';

export type ServiceKey = 'deposition' | 'wafers' | 'analysis' | 'equipment';
export const SERVICE_KEYS: ServiceKey[] = ['deposition', 'wafers', 'analysis', 'equipment'];
const SERVICE_TYPE: Record<ServiceKey, string> = {
  deposition: 'Thin film deposition',
  wafers: 'Wafer supply',
  analysis: 'Thin film analysis and measurement',
  equipment: 'Deposition equipment',
};

export const serviceId = (key: ServiceKey, isKo = false) =>
  `${SITE}${isKo ? '/ko' : ''}/product/#service-${key}`;

// 화면 메뉴 표기(BaseLayout 내비·카드 제목과 같은 글자). 게이트가 각 페이지 본문에 있는지 검사한다.
export const NAV = {
  en: { home: 'Home', product: 'Product & Solution', materials: 'Materials Library' },
  ko: { home: '홈', product: '제품 · 솔루션', materials: '소재 라이브러리' },
};
export const abs = (path: string) => (/^https?:/.test(path) ? path : new URL(path, SITE).href);

// /product/ 와 /technology/ (EN) 화면에 실제로 있는 용어 — 화면 표기 그대로.
//   Sputtering / Thermal Evaporator / In-line Sputter / ALD / Process Big Data Collection System /
//   Thin film process optimization / X-ray diffraction / X-ray photoelectron spectroscopy /
//   Atomic force microscopy / Scanning electron microscopy / Hall effect measurement
export const KNOWS_ABOUT = [
  'Sputtering',
  'Thermal Evaporator',
  'In-line Sputter',
  'ALD',
  'Process Big Data Collection System',
  'Thin film process optimization',
  'X-ray diffraction',
  'X-ray photoelectron spectroscopy',
  'Atomic force microscopy',
  'Scanning electron microscopy',
  'Hall effect measurement',
];

export function organizationNode(base: Record<string, unknown>) {
  return {
    '@context': CTX,
    '@type': 'Organization',
    '@id': ORG_ID,
    ...base,
    areaServed: 'Worldwide',
    knowsAbout: KNOWS_ABOUT,
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: 'VanaM services',
      itemListElement: SERVICE_KEYS.map((k) => ({
        '@type': 'Offer',
        itemOffered: { '@id': serviceId(k, false) },
      })),
    },
  };
}

export function websiteNode(inLanguage: string) {
  return {
    '@context': CTX,
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    name: 'VanaM',
    alternateName: ['VANAM', '반암'],
    url: SITE,
    inLanguage,
    publisher: { '@id': ORG_ID },
  };
}

export type Crumb = { name: string; url: string };
export function breadcrumbNode(items: Crumb[]) {
  return {
    '@context': CTX,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: abs(c.url),
    })),
  };
}

export function itemListNode(items: Crumb[]) {
  return {
    '@context': CTX,
    '@type': 'ItemList',
    numberOfItems: items.length,
    itemListElement: items.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      url: abs(c.url),
    })),
  };
}

// ── /product/ : 서비스 4종 ────────────────────────────────────────────
type Sub = { name: string; url?: string; description?: string };
export type ProductServiceInput = {
  isKo: boolean;
  base: string; // '' | '/ko'
  deposition: { name: string; description: string; categories: Sub[] };
  wafers: { name: string; description: string };
  analysis: { name: string; description: string };
  equipment: { name: string; description: string; groups: Sub[] };
};
const catalog = (name: string, subs: Sub[]) => ({
  '@type': 'OfferCatalog',
  name,
  itemListElement: subs.map((s) => ({
    '@type': 'OfferCatalog',
    name: s.name,
    ...(s.description ? { description: s.description } : {}),
    ...(s.url ? { url: abs(s.url) } : {}),
  })),
});

export function productServicesNode(i: ProductServiceInput) {
  const productUrl = `${i.base}/product/`;
  const mk = (key: ServiceKey, name: string, description: string, url: string, extra: object = {}) => ({
    '@type': 'Service',
    '@id': serviceId(key, i.isKo),
    name,
    description,
    serviceType: SERVICE_TYPE[key],
    provider: { '@id': ORG_ID },
    areaServed: 'Worldwide',
    url: abs(url),
    ...extra,
  });
  return {
    '@context': CTX,
    '@graph': [
      mk('deposition', i.deposition.name, i.deposition.description, productUrl, {
        hasOfferCatalog: catalog(i.deposition.name, i.deposition.categories),
      }),
      mk('wafers', i.wafers.name, i.wafers.description, `${i.base}/wafers/`),
      mk('analysis', i.analysis.name, i.analysis.description, productUrl),
      mk('equipment', i.equipment.name, i.equipment.description, productUrl, {
        hasOfferCatalog: catalog(i.equipment.name, i.equipment.groups),
      }),
    ],
  };
}

// ── 물질 상세 ─────────────────────────────────────────────────────────
// 사양 한 줄 "라벨: 값" 분리 규칙 — MaterialDetail 화면(굵은 라벨 + 값)과 같은 규칙이다.
export function splitSpec(s: string): { label: string | null; value: string } {
  const i = s.indexOf(':');
  return i > 0 && i < 44 ? { label: s.slice(0, i).trim(), value: s.slice(i + 1).trim() } : { label: null, value: s };
}

export type MaterialInput = {
  isKo: boolean;
  pageUrl: string;
  homeUrl: string;
  materialsUrl: string;
  displayName: string;
  formula: string;
  aka: string[];
  category: string; // 화면 공정 표기(예: 'PVD — Sputter & Evaporator')
  desc?: string;
  images: { url: string; caption?: string }[];
  sections: { title: string; rows: string[] }[]; // 화면에 보이는 사양 띠 (제목은 화면 배지)
};

export function materialNodes(m: MaterialInput) {
  const nav = m.isKo ? NAV.ko : NAV.en;
  const dedupe = (a: string[]) => [...new Set(a.filter(Boolean))];
  const { '@context': _ctx, ...crumb } = breadcrumbNode([
      { name: nav.home, url: m.homeUrl },
      { name: nav.materials, url: m.materialsUrl },
      { name: m.displayName, url: m.pageUrl },
    ]);
  const nodes: object[] = [crumb];
  const service = {
    '@type': 'Service',
    '@id': `${m.pageUrl}#service`,
    name: m.isKo ? `${m.displayName} 박막 증착` : `${m.displayName} thin film deposition`,
    serviceType: 'Thin film deposition',
    category: m.category,
    ...(m.desc ? { description: m.desc } : {}),
    provider: { '@id': ORG_ID },
    areaServed: 'Worldwide',
    url: m.pageUrl,
    serviceOutput: {
      '@type': 'Thing',
      name: m.displayName,
      alternateName: dedupe([m.formula, ...m.aka]),
    },
    ...(m.images.length
      ? {
          image: m.images.map((im) => ({
            '@type': 'ImageObject',
            contentUrl: im.url,
            ...(im.caption ? { caption: im.caption } : {}),
          })),
        }
      : {}),
  };
  const specRows = m.sections.flatMap((s) =>
    s.rows.map((r) => {
      const { label, value } = splitSpec(r);
      return { title: s.title, label, value };
    }),
  );
  const dataset = specRows.length
    ? (() => {
        const labels = dedupe(specRows.map((r) => r.label ?? ''));
        const description =
          m.desc && m.desc.length >= 50
            ? m.desc
            : m.isKo
              ? `반암이 측정한 ${m.displayName} 사양: ${labels.join(', ')}`
              : `${m.displayName} specifications measured by VanaM: ${labels.join(', ')}`;
        return {
          '@type': 'Dataset',
          '@id': `${m.pageUrl}#specs`,
          name: m.isKo ? `${m.displayName} 사양 — 반암` : `${m.displayName} specifications — VanaM`,
          description,
          creator: { '@id': ORG_ID },
          isAccessibleForFree: true,
          url: m.pageUrl,
          variableMeasured: specRows.map((r) => ({
            '@type': 'PropertyValue',
            name: r.label ? `${r.title}: ${r.label}` : r.title,
            value: r.value,
          })),
        };
      })()
    : null;
  nodes.push(service);
  if (dataset) nodes.push(dataset);
  return { '@context': CTX, '@graph': nodes };
}
