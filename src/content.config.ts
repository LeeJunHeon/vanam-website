import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Keystatic 등 편집기가 선택 필드를 비워 ''/null 로 저장해도 빌드가 깨지지 않도록
// optional 필드를 관대하게 처리하는 헬퍼 (''/null → undefined)
const opt = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());

// B 방식 전환 1차: team / news / history / materials 4개 컬렉션
// 모두 JSON 데이터 파일 + file() 로더 (Astro 6.x Content Layer API).
// partners / achievements / services 는 다음 단계.

// 1. TEAM ──────────────────────────────
const team = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/team' }),
  schema: z.object({
    name: z.string(),
    role: opt(z.string()),             // 직책/직함 (EN)
    role_ko: opt(z.string()),
    affiliation: opt(z.string()),      // 이력·소속 (EN)
    affiliation_ko: opt(z.string()),
    photo: opt(z.string()),      // 프로필 이미지 (※ 신규 수집 예정 — 현재 비움)
    linkedin: opt(z.string().url()),
    order: z.number().default(0),
  }),
});

// 2. NEWS ──────────────────────────────
const news = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/news' }),
  schema: z.object({
    title: z.string(),
    title_en: opt(z.string()),     // 영문 제목 (한글 기사의 번역본). EN 페이지에서 우선 사용
    url: z.string().url(),
    tag: opt(z.string()),          // Press / Investment / Feature — 분류는 수기, 없어도 통과
    date: opt(z.coerce.date()),    // 게재일 — 소스에 없음, 없어도 통과
    outlet: opt(z.string()),       // 매체명 (※ 신규 수집 예정)
    thumbnail: opt(z.string()),
    order: z.number().default(0),
  }),
});

// 2-1. BLOG ────────────────────────────
// 링크드인 글 등을 수동으로 등록(자동 수집은 링크드인 정책상 불가).
// url = 링크드인 원문 링크, excerpt = 요약. 콘텐츠는 추후 채움 → 지금은 비어 있어도 됨.
const blog = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),                 // 글 제목 (EN)
    title_ko: opt(z.string()),   // 글 제목 (KO)
    url: opt(z.string().url()),  // 링크드인 등 원문 링크 (있으면 클릭 시 이동)
    linkedinUrl: opt(z.string()),// (구) 링크드인 임베드 URL — 카드형 개편 후 링크 폴백으로만 사용
    category: z.enum(['linkedin', 'agent']).default('linkedin'),  // 글 출처 — 목록 필터 칩
    body: opt(z.string()),        // 본문(마크다운) — 있으면 상세 페이지(/blog/…) 생성 + 카드가 내부로 연결(SEO 색인)
    body_ko: opt(z.string()),     // 본문 한글판 — 비우면 영문 본문 폴백
    images: opt(z.array(z.string())),  // 본문 아래 사진 갤러리 (Keystatic 업로드 경로 배열)
    excerpt: opt(z.string()),    // 요약 (EN)
    excerpt_ko: opt(z.string()), // 요약 (KO)
    date: opt(z.coerce.date()),
    thumbnail: opt(z.string()),  // 썸네일 이미지 (추후)
    published: z.boolean().default(true),  // false면 목록에서 제외 (초안·예시용)
    order: z.number().default(0),
  }),
});

// 3. HISTORY ───────────────────────────
// items/items_ko = about 연혁 항목(EN/KO), summary_en/summaryKo = home 한 줄 요약(EN/KO).
const history = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/history' }),
  schema: z.object({
    year: z.string(),
    items: z.array(z.string()),          // 영문 연혁 항목 (about EN)
    items_ko: z.array(z.string()).optional(), // 한글 연혁 항목 (about KO)
    summary_en: opt(z.string()),   // 영문 한 줄 요약 (home EN)
    summaryKo: opt(z.string()),    // 한글 한 줄 요약 (home KO)
    order: z.number().default(0),
  }),
});

// 4. MATERIALS ─────────────────────────
// formula 단위 행. system/category/order 로 technology 페이지의 그룹 구조를,
// home(1..13) 으로 index 페이지의 큐레이션 목록 순서를 각각 재현한다.
const materials = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/materials' }),
  schema: z.object({
    system: z.enum(['sputter', 'ald']),  // sputter = PVD(Sputter & Evaporator)
    category: z.enum(['Oxide', 'Nitride', 'Metal', 'Semiconductor']),
    formula: z.string(),
    order: z.number(),                   // technology 그룹 내 표시 순서
    home: opt(z.number()),         // index 큐레이션 노출 순서 (없으면 미노출)
    // ── 물질 상세 페이지용 (콘텐츠는 추후 채움) ──
    name: opt(z.string()),         // 물질 정식 명칭 EN (예: "Vanadium Dioxide")
    name_ko: opt(z.string()),      // 물질 정식 명칭 KO (예: "이산화바나듐")
    image: opt(z.string()),        // 상세 이미지 경로 (※ 사박사님 제공 예정 — 현재 비움)
    description: opt(z.string()),      // 상세 설명 EN
    description_ko: opt(z.string()),   // 상세 설명 KO
  }),
});

// ── B 방식 전환 2차: partners / achievements / services ──────────

// 5. PARTNERS (collaboration) ──────────
const partners = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/partners' }),
  schema: z.object({
    name: z.string(),
    logo: opt(z.string()),       // 로고 이미지 (※ 신규 수집 예정 — 현재 비움)
    url: opt(z.string().url()),
    kind: opt(z.enum(['institute', 'university', 'company', 'finance'])),
    needsCheck: z.boolean().optional(),   // 대표님 확인 필요(로고·표기) — 빨간색 표시
    order: z.number().default(0),
  }),
});

// 6. ACHIEVEMENTS (global activity) ────
const achievements = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/achievements' }),
  schema: z.object({
    name: z.string(),
    year: opt(z.string()),
    location: opt(z.string()),
    kind: opt(z.enum(['exhibition', 'conference', 'accelerator', 'award'])),
    order: z.number().default(0),
  }),
});

// 7. SERVICES ──────────────────────────
const services = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/services' }),
  schema: z.object({
    title: z.string(),                       // EN
    description: z.string(),                 // EN
    title_ko: opt(z.string()),         // KO
    bullets: opt(z.array(z.string())),        // 상세 항목 (EN)
    bullets_ko: opt(z.array(z.string())),
    description_ko: opt(z.string()),   // KO
    order: z.number().default(0),
  }),
});

// 8. FAQ ───────────────────────────────
// 근거(사이트/콘텐츠 데이터)가 있는 답만 작성. 운영 정보처럼 근거 없는 항목은
// answer를 빈 문자열로 두고 published:false 로 표시(렌더·JSON-LD에서 제외).
const faq = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/faq' }),
  schema: z.object({
    question: z.string(),             // KO (원문)
    answer: z.string(),               // KO — 빈 값 허용 (미작성 placeholder)
    question_en: opt(z.string()), // EN
    answer_en: opt(z.string()),   // EN
    published: z.boolean().default(true),
    order: z.number().default(0),
  }),
});

// 9. PRODUCTS ──────────────────────────
// 제품 상품. 가격 유형 2종:
//   fixed = 고정가 (장바구니 → 즉시 결제)
//   quote = 견적가 (스펙 접수 → 관리자가 금액 책정 → 결제 링크 발송)
const products = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/products' }),
  schema: z.object({
    name: z.string(),                                   // KO 상품명 (파일 ID = SKU)
    name_en: opt(z.string()),
    category: z.enum(['sample', 'coating', 'analysis', 'wafer', 'etc']).default('etc'),
    pricingType: z.enum(['fixed', 'quote']).default('fixed'),
    requiresShipping: z.boolean().default(true),        // 실물 배송이 필요한가 (분석 서비스는 false)
    price: opt(z.number()),                             // fixed일 때 판매가 (원, VAT 포함)
    summary: z.string(),                                // KO 한 줄 소개
    summary_en: opt(z.string()),
    description: opt(z.string()),                       // KO 상세 설명
    description_en: opt(z.string()),
    image: opt(z.string()),                             // 대표 이미지 (Keystatic 업로드)
    specs: z.array(z.object({ label: z.string(), value: z.string(), label_en: z.string().optional(), value_en: z.string().optional() })).default([]),
    leadTime: opt(z.string()),                          // 납기 안내
    leadTime_en: opt(z.string()),
    shipping: opt(z.string()),                          // 배송 안내
    shipping_en: opt(z.string()),
    published: z.boolean().default(true),
    order: z.number().default(0),
  }),
});

// 웨이퍼 카탈로그. Product 의 'Wafers' 카드를 클릭하면 이 목록(/wafers)이 뜬다.
// 고정가 판매 — priceKrw(원)를 입력하면 사이트에 달러($)로 환산 표시된다(환율=company.usdRate). Keystatic '웨이퍼'에서 편집.
const wafers = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/wafers' }),
  schema: z.object({
    name: z.string(),                                   // KO 웨이퍼명 (파일 ID = 코드)
    name_en: opt(z.string()),
    summary: opt(z.string()),                           // KO 한 줄 소개
    summary_en: opt(z.string()),
    description: opt(z.string()),                        // KO 상세 설명
    description_en: opt(z.string()),
    image: opt(z.string()),                             // 대표 이미지 (Keystatic 업로드)
    specs: z.array(z.object({ label: z.string(), value: z.string(), label_en: z.string().optional(), value_en: z.string().optional() })).default([]),
    leadTime: opt(z.string()),                          // 납기 안내
    leadTime_en: opt(z.string()),
    refundPolicy: opt(z.string()),                      // 환불 규정 (스펙과 별도로 하단 표시)
    refundPolicy_en: opt(z.string()),
    priceKrw: opt(z.number()),                          // 판매가(원) — 사이트에는 달러($) 환산 표시. 비우면 '가격 문의'
    published: z.boolean().default(true),
    order: z.number().default(0),
  }),
});

// 10. CERTIFICATES ────────────────────
// 특허증·인증서. 이미지를 클릭하면 확대(라이트박스)로 볼 수 있다.
const certificates = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/certificates' }),
  schema: z.object({
    name: z.string(),                    // KO 명칭
    name_en: opt(z.string()),
    kind: z.enum(['patent', 'certification']).default('patent'),
    country: opt(z.string()),            // 국가 코드/명 (예: KR, US, JP) — 배지로 표시
    number: opt(z.string()),             // 등록/확인 번호
    date: opt(z.string()),               // 등록일
    image: z.string(),                   // 증서 이미지 (Keystatic 업로드)
    published: z.boolean().default(true),
    order: z.number().default(0),
  }),
});

// 11. POLICIES ────────────────────────
// 법적 고지 문서(개인정보처리방침·이용약관·환불정책). 언어별로 파일이 하나씩.
// body 안의 {officerName} {tel} 같은 자리표시자는 company.json 값으로 치환된다.
const policies = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/policies' }),
  schema: z.object({
    kind: z.enum(['privacy', 'terms', 'refund']),
    lang: z.enum(['ko', 'en']),
    title: z.string(),
    updated: z.string(),
    intro: opt(z.string()),
    sections: z.array(z.object({ heading: z.string(), body: z.string() })),
    order: z.number().default(0),
  }),
});

// 기존 벌크 공정 vs 반암 박막 공정 비교 (기술 페이지)
const comparison = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/comparison' }),
  schema: z.object({
    label: z.string(),                 // 비교 항목 (EN)
    label_ko: opt(z.string()),
    bulk: z.string(),                  // 기존 벌크 쪽 값
    bulk_ko: opt(z.string()),
    film: z.string(),                  // 반암 박막 쪽 값
    film_ko: opt(z.string()),
    note: opt(z.string()),             // 박막 값에 붙는 보조 설명 (예: "1만분의 1 이하")
    note_ko: opt(z.string()),
    order: z.number().default(0),
  }),
});

// 증착 장비 · 공정 데이터 수집 시스템
const equipment = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/equipment' }),
  schema: z.object({
    name: z.string(),
    name_ko: opt(z.string()),
    category: z.enum(['deposition', 'data', 'infra']).default('deposition'),
    description: z.string(),
    description_ko: opt(z.string()),
    image: opt(z.string()),  // 장비 사진 (배경 제거 투명 PNG 권장) — 없으면 카드 자동 숨김
    order: z.number().default(0),
  }),
});

// 분석·측정 항목 (제품의 분석 서비스 상품과 연결된다)
const analysis = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/analysis' }),
  schema: z.object({
    name: z.string(),                          // SEM, XRD, I–V …
    group: z.enum(['material', 'device']),     // 소재 분석 / 소자 특성 분석
    description: z.string(),
    description_ko: opt(z.string()),
    order: z.number().default(0),
  }),
});

export const collections = {
  team, news, blog, history, materials, partners, achievements, services, faq,
  products, certificates, policies, comparison, equipment, analysis,
  wafers,
};
