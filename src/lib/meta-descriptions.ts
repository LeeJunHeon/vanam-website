// 검색 스니펫용 메타 설명 — 제품·웨이퍼·소재·문의 페이지.
//
// 왜 site.json 이 아니라 여기인가: 이 문장들은 **계산된다.** 물질 나열이 소재 라이브러리에서
// 자동으로 채워지므로(소재를 추가하면 설명도 따라온다) 정적 i18n 문자열 테이블에 둘 수 없다.
// 또 화면에 보이는 문구(products.summary, tech.materialsLibraryDesc)와 역할이 다르다 —
// 그쪽은 짧은 리드 문구고, 이쪽은 160자 이하 검색 설명이다(Bing 웹마스터 기준 — 넘으면 "너무 긴 설명"으로 표시된다).
// 섞으면 한쪽을 고칠 때 다른 쪽이 망가진다. 길이는 scripts/check-meta-descriptions.mjs 가 빌드 결과에서 잰다.
//
// ⚠️ 물질 목록은 하드코딩하지 않는다. {oxides} 같은 자리는 lib/material-lists.ts 가 채운다.
//    {oxides:6} 처럼 개수를 붙이면 라이브러리 순서 그대로 앞 6개만 쓰고, 잘렸을 때만 뒤에 " and more" / " 등" 을 붙인다.
//    개수가 없으면 전체. 소재가 늘어 160자를 넘으면 문장은 두고 개수(N)를 줄여 맞춘다.
import { materialsForDescription, joinFormulas } from './material-lists';

type Loc = 'ko' | 'en';

/** 메타 설명 길이 한도(코드포인트). Bing 웹마스터가 이보다 길면 "설명이 너무 깁니다"로 표시한다. */
export const META_DESC_LIMIT = 160;

const TEMPLATES: Record<string, Record<Loc, string>> = {
  'product/oxides': {
    ko: '산화물 박막 맞춤 증착 서비스 — 스퍼터·ALD로 {oxides:7} 박막을 2~6인치 기판에 증착합니다. 소량 R&D부터 온라인으로 견적을 요청하세요.',
    en: 'Custom oxide thin-film deposition by sputtering and ALD — {oxides:6}, on 2–6 inch substrates. Small-batch R&D welcome.',
  },
  'product/nitrides': {
    ko: '질화물 박막 맞춤 증착 서비스 — 스퍼터로 {nitrides:6} 박막을 증착합니다. 압전·강유전, 초전도 단광자 검출기, 광도파로·패시베이션 용도로 온라인 견적을 요청하세요.',
    en: 'Custom nitride thin-film deposition by sputtering — {nitrides:6}. Piezoelectric, ferroelectric, superconducting and waveguide films.',
  },
  'product/metals': {
    ko: '금속 박막 맞춤 증착 서비스 — 스퍼터·증발·ALD로 {metals:8} 박막을 증착합니다. 전극·배선, 접착층, 확산 방지막 용도로 온라인 견적을 요청하세요.',
    en: 'Custom metal thin-film deposition by sputtering, evaporation and ALD — {metals:7}. Electrodes, adhesion layers, diffusion barriers.',
  },
  'product/multilayers': {
    ko: '다층 박막 맞춤 증착 서비스 — 산화물·질화물·금속·반도체 {count}종을 원하는 순서로 적층합니다. DBR 고반사 미러(Si/SiO₂/TiO₂), 전극-절연막-전극 커패시터, 초전도·광도파로 적층 등 공정 시퀀스를 직접 구성하고 열처리·분석까지 지정해 온라인 견적을 요청하세요.',
    en: 'Custom multilayer deposition — stack any of {count} oxide, nitride, metal and semiconductor films in your own order, from DBR mirrors to capacitor stacks.',
  },
  // /product/wafers — 베어·박막 증착 웨이퍼 안내(맞춤 박막 코팅은 견적). /wafers 목록의 'wafers' 와 다른 문장.
  'product/wafers': {
    ko: '베어 웨이퍼와 박막 증착 웨이퍼 — 실리콘·산화막 실리콘 4·6인치, 사파이어 2인치 웨이퍼를 25장 1박스 단위로 온라인 주문하고, 맞춤 박막을 올린 웨이퍼는 견적을 요청하세요.',
    en: 'Bare and thin-film-deposited wafers — 4 and 6 inch silicon, oxide-coated silicon and 2-inch sapphire, sold per box of 25. Request a quote for custom coatings.',
  },
  // /wafers 목록 페이지.
  // ⚠️ 사양은 src/content/wafers 실데이터와 대조해 적었다 —
  //    Prime 등급은 6인치에만 있고(4인치는 Test), 다이싱은 사파이어를 뺀 5종 전부 제공한다.
  wafers: {
    ko: '반도체 웨이퍼 판매 — 실리콘 4인치(Test)·6인치(Prime/Test, P형 보론), 산화막(SiO₂ 300nm) 실리콘 4·6인치, 사파이어 2인치 웨이퍼를 25장 1박스 단위로 판매합니다. 가격 확인 후 온라인 즉시 주문, 실리콘·산화막 웨이퍼는 다이싱 옵션 제공.',
    en: 'Semiconductor wafers for sale — 4 and 6 inch p-type boron silicon (Test/Prime), oxide-coated silicon (300 nm SiO₂) and 2-inch sapphire, sold per box of 25.',
  },
  materials: {
    ko: '반암 박막 소재 라이브러리 — 스퍼터·ALD로 증착하는 소재 {count}종의 사양·측정 데이터. 산화물({oxides:3}), 질화물({nitrides:2}), 금속, 다층막({multilayers}). 바로 견적을 요청하세요.',
    en: 'VanaM thin-film materials library — specifications and measurement data for {count} materials: oxides ({oxides:2}), nitrides, metals and multilayers.',
  },
  contact: {
    // 문의 + 이 페이지 FAQ(일반 · 파운드리·주문·품질)의 주제
    ko: '반암에 박막 증착 견적과 기술 상담을 문의하세요. 증착 공정, 소재, 소량 주문, 견적 사양, 납기, 해외 배송 등 자주 묻는 질문을 확인할 수 있습니다.',
    en: 'Contact VanaM for thin-film deposition quotes and technical consultation, with FAQs on methods, materials, small orders, lead times and shipping.',
  },
};

/**
 * 페이지 키 + 로캘 → 메타 설명. 물질 목록·개수는 소재 라이브러리에서 채운다.
 * 템플릿이 없는 키는 undefined 를 돌려주고, 호출부가 기존 설명으로 폴백한다.
 *
 * 자리표시자: {oxides} {nitrides} {metals} {multilayers} = 전체 목록, {이름:N} = 앞 N개(+ 잘렸으면 " and more"/" 등"), {count} = 전체 소재 수.
 */
export async function metaDescriptionFor(key: string, locale: string): Promise<string | undefined> {
  const isKo = locale === 'ko';
  const tpl = TEMPLATES[key]?.[isKo ? 'ko' : 'en'];
  if (!tpl) return undefined;

  const m = await materialsForDescription();
  const lists: Record<string, string[]> = {
    oxides: m.oxides, nitrides: m.nitrides, metals: m.metals, multilayers: m.multilayers,
  };
  // 전체 {metals} 뒤에는 반도체(Si)를 덧붙인다 — 금속 제품 페이지가 Si 도 함께 받기 때문
  // (CATEGORY_TO_PRODUCT 에서 Semiconductor → metals 로 매핑돼 있다).
  // 개수 제한 {metals:N} 은 금속만 세고 Si 는 붙이지 않는다.
  const metalsWithSi = m.semiconductors.length
    ? `${joinFormulas(m.metals)}${isKo ? ' 및 ' : ' and '}${joinFormulas(m.semiconductors)}`
    : joinFormulas(m.metals);
  const more = isKo ? ' 등' : ' and more';

  return tpl
    .replace(/\{(oxides|nitrides|metals|multilayers)(?::(\d+))?\}/g, (_all, name: string, n?: string) => {
      const list = lists[name];
      if (n === undefined) return name === 'metals' ? metalsWithSi : joinFormulas(list);
      const limit = Number(n);
      return list.length > limit ? `${joinFormulas(list.slice(0, limit))}${more}` : joinFormulas(list);
    })
    .replaceAll('{count}', String(m.total));
}

/**
 * 메타 설명을 한도(기본 160자, 코드포인트 기준) 이하로 줄인다. 한도 이하면 그대로 돌려준다.
 *   - 기본: 문장 경계 우선("마침표 + 공백" 또는 문장 끝 — 'Al₂O₃.'·'2.53' 같은 화학식·소수점에 걸리지 않는다),
 *           한도 안에 문장 끝이 없으면 단어 경계.
 *   - ellipsis: true → 단어 경계에서 자르고 끝에 "…" 를 붙인다(이미 "…" 로 끝나면 겹쳐 붙이지 않는다). 블로그 요약용.
 */
export function clipMetaDescription(text: string, opts: { limit?: number; ellipsis?: boolean } = {}): string {
  const limit = opts.limit ?? META_DESC_LIMIT;
  const chars = [...text.trim()];
  if (chars.length <= limit) return chars.join('');

  const wordCut = (room: number) => {
    // room+1 번째 글자가 공백이면 room 글자가 통째로 단어 경계다.
    const cut = chars.slice(0, room).join('');
    if (/\s/.test(chars[room] ?? '')) return cut;
    const sp = cut.search(/\s\S*$/);
    return sp > 0 ? cut.slice(0, sp) : cut;
  };
  const tidy = (s: string) => s.replace(/[\s,;:·—–…-]+$/u, '');

  if (opts.ellipsis) return `${tidy(wordCut(limit - 1)).replace(/\.+$/, '')}…`;

  // 한도 안에서 끝나는 마지막 문장 경계
  const window = chars.slice(0, limit + 1).join('');
  let end = -1;
  for (const hit of window.matchAll(/[.!?](?=\s)/g)) end = hit.index + 1;
  if (end > 0) return window.slice(0, end).trim();
  return tidy(wordCut(limit));
}

/**
 * og:description — SNS 카드는 두세 줄만 보여주므로 긴 설명은 첫 문장만 쓴다.
 * 짧은 설명(en 160자 / ko 100자 이하)은 그대로 둔다.
 *
 * ⚠️ 마침표로 자를 때 'Al₂O₃.' 같은 약어·소수점에 걸리지 않도록
 *    "마침표 + 공백" 또는 문장 끝만 경계로 본다.
 */
export function ogDescriptionFrom(description: string, locale: string): string {
  const limit = locale === 'ko' ? 100 : 160;
  const text = description.trim();
  if (text.length <= limit) return text;

  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text);
  const first = m?.[0]?.trim();
  // 첫 문장이 없거나 오히려 한도를 크게 넘으면 단어 경계로 자른다.
  if (first && first.length <= limit * 1.6) return first;
  const cut = text.slice(0, limit);
  const sp = cut.lastIndexOf(' ');
  return (sp > limit * 0.5 ? cut.slice(0, sp) : cut).trim();
}
