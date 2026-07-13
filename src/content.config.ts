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
    role: opt(z.string()),       // 직책/직함 (※ 신규 수집 예정 — 현재 비움)
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
    url: z.string().url(),
    tag: opt(z.string()),          // Press / Investment / Feature — 분류는 수기, 없어도 통과
    date: opt(z.coerce.date()),    // 게재일 — 소스에 없음, 없어도 통과
    outlet: opt(z.string()),       // 매체명 (※ 신규 수집 예정)
    thumbnail: opt(z.string()),
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
    category: z.enum(['Oxide', 'Nitride', 'Metal']),
    formula: z.string(),
    order: z.number(),                   // technology 그룹 내 표시 순서
    home: opt(z.number()),         // index 큐레이션 노출 순서 (없으면 미노출)
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
// 스토어 상품. 가격 유형 2종:
//   fixed = 고정가 (장바구니 → 즉시 결제)
//   quote = 견적가 (스펙 접수 → 관리자가 금액 책정 → 결제 링크 발송)
const products = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/products' }),
  schema: z.object({
    name: z.string(),                                   // KO 상품명 (파일 ID = SKU)
    name_en: opt(z.string()),
    category: z.enum(['sample', 'coating', 'analysis', 'etc']).default('etc'),
    pricingType: z.enum(['fixed', 'quote']).default('fixed'),
    price: opt(z.number()),                             // fixed일 때 판매가 (원, VAT 포함)
    summary: z.string(),                                // KO 한 줄 소개
    summary_en: opt(z.string()),
    description: opt(z.string()),                       // KO 상세 설명
    description_en: opt(z.string()),
    image: opt(z.string()),                             // 대표 이미지 (Keystatic 업로드)
    specs: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
    leadTime: opt(z.string()),                          // 납기 안내
    leadTime_en: opt(z.string()),
    shipping: opt(z.string()),                          // 배송 안내
    shipping_en: opt(z.string()),
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
    number: opt(z.string()),             // 등록/확인 번호
    date: opt(z.string()),               // 등록일
    image: z.string(),                   // 증서 이미지 (Keystatic 업로드)
    published: z.boolean().default(true),
    order: z.number().default(0),
  }),
});

export const collections = { team, news, history, materials, partners, achievements, services, faq, products, certificates };
