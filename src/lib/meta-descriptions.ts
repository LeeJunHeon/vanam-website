// 검색 스니펫용 메타 설명 — 제품·웨이퍼·소재·문의 페이지.
//
// 왜 site.json 이 아니라 여기인가: 이 문장들은 **계산된다.** 물질 나열이 소재 라이브러리에서
// 자동으로 채워지므로(소재를 추가하면 설명도 따라온다) 정적 i18n 문자열 테이블에 둘 수 없다.
// 또 화면에 보이는 문구(products.summary, tech.materialsLibraryDesc)와 역할이 다르다 —
// 그쪽은 짧은 리드 문구고, 이쪽은 검색 결과에 뜨는 긴 설명이다. 섞으면 한쪽을 고칠 때 다른 쪽이 망가진다.
//
// ⚠️ 물질 목록은 하드코딩하지 않는다. {oxides} 같은 자리는 lib/material-lists.ts 가 채운다.
import { materialsForDescription, joinFormulas } from './material-lists';

type Loc = 'ko' | 'en';

const TEMPLATES: Record<string, Record<Loc, string>> = {
  'product/oxides': {
    ko: '산화물 박막 맞춤 증착 서비스 — 스퍼터·ALD로 {oxides} 박막을 증착합니다. 2~6인치 실리콘·산화막·유리·사파이어 기판, 두께·공정 순서·열처리·분석(XRD·SEM·TEM·XPS·AFM·전기 특성)까지 지정해 온라인으로 견적을 요청하세요. 소량 R&D부터 대응합니다.',
    en: 'Custom oxide thin-film deposition by sputtering and ALD — {oxides}. Silicon, oxide, glass and sapphire substrates from 2 to 6 inch; specify thickness, process sequence, annealing and analysis (XRD, SEM, TEM, XPS, AFM, electrical) and request a quote online. Small-batch R&D welcome.',
  },
  'product/nitrides': {
    ko: '질화물 박막 맞춤 증착 서비스 — 스퍼터로 {nitrides} 박막을 증착합니다. 압전·강유전(AlScN), 초전도 단광자 검출기(NbN·NbTiN), 확산 방지·경질 코팅(TiN), 광도파로·패시베이션(SiNₓ) 용도. 2~6인치 기판, 두께·공정 순서·분석까지 지정해 온라인 견적을 요청하세요.',
    en: 'Custom nitride thin-film deposition by sputtering — {nitrides}. Piezoelectric and ferroelectric (AlScN), superconducting single-photon detectors (NbN, NbTiN), diffusion barriers and hard coatings (TiN), waveguides and passivation (SiNₓ). Substrates 2–6 inch; specify thickness, sequence and analysis to request a quote.',
  },
  'product/metals': {
    ko: '금속 박막 맞춤 증착 서비스 — 스퍼터·증발·ALD로 {metals} 박막을 증착합니다. 전극·배선, 접착층, 확산 방지막, 촉매층, 수소 센서 용도. 2~6인치 기판, 두께·다층 순서·분석까지 지정해 온라인 견적을 요청하세요.',
    en: 'Custom metal thin-film deposition by sputtering, evaporation and ALD — {metals}. Electrodes and interconnects, adhesion layers, diffusion barriers, catalytic layers, hydrogen sensors. Substrates 2–6 inch; specify thickness, stack order and analysis to request a quote.',
  },
  'product/multilayers': {
    ko: '다층 박막 맞춤 증착 서비스 — 산화물·질화물·금속·반도체 {count}종을 원하는 순서로 적층합니다. DBR 고반사 미러(Si/SiO₂/TiO₂), 전극-절연막-전극 커패시터, 초전도·광도파로 적층 등 공정 시퀀스를 직접 구성하고 열처리·분석까지 지정해 온라인 견적을 요청하세요.',
    en: 'Custom multilayer deposition — stack any of {count} oxide, nitride, metal and semiconductor films in your own order. DBR high-reflectance mirrors (Si/SiO₂/TiO₂), electrode–dielectric–electrode capacitors, superconducting and waveguide stacks. Build the process sequence, add annealing and analysis, and request a quote online.',
  },
  // /product/wafers 와 /wafers 가 같은 문장을 쓴다(둘 다 웨이퍼 판매 안내).
  // ⚠️ 사양은 src/content/wafers 실데이터와 대조해 적었다 —
  //    Prime 등급은 6인치에만 있고(4인치는 Test), 다이싱은 사파이어를 뺀 5종 전부 제공한다.
  wafers: {
    ko: '반도체 웨이퍼 판매 — 실리콘 4인치(Test)·6인치(Prime/Test, P형 보론), 산화막(SiO₂ 300nm) 실리콘 4·6인치, 사파이어 2인치 웨이퍼를 25장 1박스 단위로 판매합니다. 가격 확인 후 온라인 즉시 주문, 실리콘·산화막 웨이퍼는 다이싱 옵션 제공.',
    en: 'Semiconductor wafers for sale — 4-inch (Test) and 6-inch (Prime/Test) p-type boron silicon, oxide-coated silicon (300 nm SiO₂) in 4 and 6 inch, and 2-inch sapphire, sold per box of 25. Check prices and order online; dicing available for the silicon and oxide wafers.',
  },
  materials: {
    ko: '반암 박막 소재 라이브러리 — 스퍼터·ALD로 증착하는 소재 {count}종의 사양·측정 데이터. 산화물({oxides}), 질화물({nitrides}), 금속({metals}). XRD·SEM·TEM·전기 특성과 타겟·전구체 정보를 확인하고 바로 견적을 요청하세요.',
    en: 'VanaM thin-film materials library — specifications and measurement data for {count} materials deposited by sputtering and ALD: oxides ({oxides}), nitrides ({nitrides}), metals ({metals}). XRD, SEM, TEM, electrical data, target and precursor specs; request a quote directly.',
  },
  contact: {
    ko: '박막 증착·분석 의뢰, 웨이퍼 구매, 협업 문의를 남겨 주세요. 서울 도심형 마이크로 파운드리 반암(VanaM)의 담당자가 확인 후 회신합니다.',
    en: 'Contact VanaM for thin-film deposition and analysis requests, wafer purchases and partnerships. Seoul-based urban micro-foundry — our team will follow up.',
  },
};

/**
 * 페이지 키 + 로캘 → 메타 설명. 물질 목록·개수는 소재 라이브러리에서 채운다.
 * 템플릿이 없는 키는 undefined 를 돌려주고, 호출부가 기존 설명으로 폴백한다.
 */
export async function metaDescriptionFor(key: string, locale: string): Promise<string | undefined> {
  const tpl = TEMPLATES[key]?.[locale === 'ko' ? 'ko' : 'en'];
  if (!tpl) return undefined;

  const m = await materialsForDescription();
  // metals 뒤에는 반도체(Si)를 덧붙인다 — 금속 제품 페이지가 Si 도 함께 받기 때문
  // (CATEGORY_TO_PRODUCT 에서 Semiconductor → metals 로 매핑돼 있다).
  const metalsWithSi = m.semiconductors.length
    ? `${joinFormulas(m.metals)}${locale === 'ko' ? ' 및 ' : ' and '}${joinFormulas(m.semiconductors)}`
    : joinFormulas(m.metals);

  return tpl
    .replaceAll('{oxides}', joinFormulas(m.oxides))
    .replaceAll('{nitrides}', joinFormulas(m.nitrides))
    .replaceAll('{metals}', metalsWithSi)
    .replaceAll('{count}', String(m.total));
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
