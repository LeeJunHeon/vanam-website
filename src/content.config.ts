import { defineCollection, z } from 'astro:content';
import { file } from 'astro/loaders';

// B 방식 전환 1차: team / news / history / materials 4개 컬렉션
// 모두 JSON 데이터 파일 + file() 로더 (Astro 6.x Content Layer API).
// partners / achievements / services 는 다음 단계.

// 1. TEAM ──────────────────────────────
const team = defineCollection({
  loader: file('src/content/team.json'),
  schema: z.object({
    name: z.string(),
    role: z.string().optional(),       // 직책/직함 (※ 신규 수집 예정 — 현재 비움)
    photo: z.string().optional(),      // 프로필 이미지 (※ 신규 수집 예정 — 현재 비움)
    linkedin: z.string().url().optional(),
    order: z.number().default(0),
  }),
});

// 2. NEWS ──────────────────────────────
const news = defineCollection({
  loader: file('src/content/news.json'),
  schema: z.object({
    title: z.string(),
    url: z.string().url(),
    tag: z.string().optional(),          // Press / Investment / Feature — 분류는 수기, 없어도 통과
    date: z.coerce.date().optional(),    // 게재일 — 소스에 없음, 없어도 통과
    outlet: z.string().optional(),       // 매체명 (※ 신규 수집 예정)
    thumbnail: z.string().optional(),
    order: z.number().default(0),
  }),
});

// 3. HISTORY ───────────────────────────
// items(영문) 가 정본. summaryKo 는 index 의 한글 축약 출력 보존용.
// ⚠️ TODO(표현 통일): 현재 index 는 summaryKo(한글), about 은 items(영문)를 사용한다.
//    추후 둘을 한 가지 언어/표현으로 통일할지는 미정 — 결정되면 한쪽 필드로 합칠 것.
const history = defineCollection({
  loader: file('src/content/history.json'),
  schema: z.object({
    year: z.string(),
    items: z.array(z.string()),          // 영문 연혁 항목 (about EN)
    items_ko: z.array(z.string()).optional(), // 한글 연혁 항목 (about KO)
    summary_en: z.string().optional(),   // 영문 한 줄 요약 (home EN)
    summaryKo: z.string().optional(),    // 한글 한 줄 요약 (home KO)
    order: z.number().default(0),
  }),
});

// 4. MATERIALS ─────────────────────────
// formula 단위 행. system/category/order 로 technology 페이지의 그룹 구조를,
// home(1..13) 으로 index 페이지의 큐레이션 목록 순서를 각각 재현한다.
const materials = defineCollection({
  loader: file('src/content/materials.json'),
  schema: z.object({
    system: z.enum(['sputter', 'ald']),  // sputter = PVD(Sputter & Evaporator)
    category: z.enum(['Oxide', 'Nitride', 'Metal']),
    formula: z.string(),
    order: z.number(),                   // technology 그룹 내 표시 순서
    home: z.number().optional(),         // index 큐레이션 노출 순서 (없으면 미노출)
  }),
});

// ── B 방식 전환 2차: partners / achievements / services ──────────

// 5. PARTNERS (collaboration) ──────────
const partners = defineCollection({
  loader: file('src/content/partners.json'),
  schema: z.object({
    name: z.string(),
    logo: z.string().optional(),       // 로고 이미지 (※ 신규 수집 예정 — 현재 비움)
    url: z.string().url().optional(),
    kind: z.enum(['institute', 'university', 'company', 'finance']).optional(),
    order: z.number().default(0),
  }),
});

// 6. ACHIEVEMENTS (global activity) ────
const achievements = defineCollection({
  loader: file('src/content/achievements.json'),
  schema: z.object({
    name: z.string(),
    year: z.string().optional(),
    location: z.string().optional(),
    kind: z.enum(['exhibition', 'conference', 'accelerator', 'award']).optional(),
    order: z.number().default(0),
  }),
});

// 7. SERVICES ──────────────────────────
const services = defineCollection({
  loader: file('src/content/services.json'),
  schema: z.object({
    title: z.string(),                       // EN
    description: z.string(),                 // EN
    title_ko: z.string().optional(),         // KO
    description_ko: z.string().optional(),   // KO
    order: z.number().default(0),
  }),
});

// 8. FAQ ───────────────────────────────
// 근거(사이트/콘텐츠 데이터)가 있는 답만 작성. 운영 정보처럼 근거 없는 항목은
// answer를 빈 문자열로 두고 published:false 로 표시(렌더·JSON-LD에서 제외).
const faq = defineCollection({
  loader: file('src/content/faq.json'),
  schema: z.object({
    question: z.string(),             // KO (원문)
    answer: z.string(),               // KO — 빈 값 허용 (미작성 placeholder)
    question_en: z.string().optional(), // EN
    answer_en: z.string().optional(),   // EN
    published: z.boolean().default(true),
    order: z.number().default(0),
  }),
});

export const collections = { team, news, history, materials, partners, achievements, services, faq };
