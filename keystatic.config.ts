// VANAM 콘텐츠 관리자 (Keystatic) 설정
// - 접속: 개발 중 http://localhost:4321/keystatic
// - 저장 방식: 아래 storage 참고. local = 파일에 직접 저장(개발/사내 Mac mini용),
//   배포 후 편집자가 웹에서 쓰려면 github 모드로 전환:
//   storage: { kind: 'github', repo: { owner: 'LeeJunHeon', name: 'vanam-website' } }
import { config, fields, collection } from '@keystatic/core';

export default config({
  storage: { kind: 'local' },

  ui: {
    brand: { name: 'VANAM 콘텐츠 관리' },
    navigation: {
      '콘텐츠': ['news', 'team', 'faq'],
      '회사 정보': ['history', 'achievements', 'partners'],
      '기술 데이터': ['services', 'materials'],
    },
  },

  collections: {
    // ── 뉴스 ──────────────────────────────────────────
    news: collection({
      label: '뉴스',
      path: 'src/content/news/*',
      format: { data: 'json' },
      slugField: 'title',
      columns: ['tag', 'outlet', 'order'],
      schema: {
        title: fields.slug({
          name: { label: '제목', validation: { isRequired: true } },
          slug: { label: '파일 ID (영문/숫자)', description: '예: news-6 — 만든 뒤에는 바꾸지 마세요' },
        }),
        url: fields.url({ label: '원문 기사 링크', validation: { isRequired: true } }),
        tag: fields.select({
          label: '분류',
          options: [
            { label: 'Press (언론 보도)', value: 'Press' },
            { label: 'Investment (투자)', value: 'Investment' },
            { label: 'Feature (특집)', value: 'Feature' },
          ],
          defaultValue: 'Press',
        }),
        outlet: fields.text({ label: '매체명', description: '예: 전자신문' }),
        date: fields.date({ label: '게재일' }),
        order: fields.integer({ label: '노출 순서', description: '숫자가 작을수록 위에 표시', defaultValue: 99, validation: { isRequired: true } }),
        thumbnail: fields.text({ label: '썸네일 경로 (선택, 개발자용)' }),
      },
    }),

    // ── 팀 ────────────────────────────────────────────
    team: collection({
      label: '팀원',
      path: 'src/content/team/*',
      format: { data: 'json' },
      slugField: 'name',
      columns: ['role', 'order'],
      schema: {
        name: fields.slug({
          name: { label: '이름', description: '예: Dr. SD HAN', validation: { isRequired: true } },
          slug: { label: '파일 ID (영문)', description: '예: sd-han' },
        }),
        role: fields.text({ label: '직책', description: '예: CEO / CTO / Senior Researcher' }),
        photo: fields.image({
          label: '프로필 사진',
          directory: 'src/assets/team',
          publicPath: '/src/assets/team/',
        }),
        linkedin: fields.url({ label: 'LinkedIn 주소 (선택)' }),
        order: fields.integer({ label: '표시 순서', defaultValue: 99, validation: { isRequired: true } }),
      },
    }),

    // ── FAQ ───────────────────────────────────────────
    faq: collection({
      label: 'FAQ (자주 묻는 질문)',
      path: 'src/content/faq/*',
      format: { data: 'json' },
      slugField: 'question',
      columns: ['published', 'order'],
      schema: {
        question: fields.slug({
          name: { label: '질문', validation: { isRequired: true } },
          slug: { label: '파일 ID (영문)', description: '예: lead-time' },
        }),
        answer: fields.text({ label: '답변', multiline: true, description: '비워두면 사이트에 표시되지 않습니다' }),
        published: fields.checkbox({ label: '사이트에 공개', defaultValue: true }),
        order: fields.integer({ label: '표시 순서', defaultValue: 99, validation: { isRequired: true } }),
      },
    }),

    // ── 연혁 ──────────────────────────────────────────
    history: collection({
      label: '연혁',
      path: 'src/content/history/*',
      format: { data: 'json' },
      slugField: 'year',
      columns: ['order'],
      schema: {
        year: fields.slug({
          name: { label: '연도', description: '예: 2026', validation: { isRequired: true } },
          slug: { label: '파일 ID', description: '연도와 동일하게 (예: 2026)' },
        }),
        items: fields.array(
          fields.text({ label: '내용 (영문)' }),
          { label: '해당 연도 주요 사건 (영문 — About 페이지)', itemLabel: (props) => props.value || '(비어 있음)' },
        ),
        summaryKo: fields.text({ label: '한 줄 요약 (한글 — 홈 화면)', multiline: true }),
        order: fields.integer({ label: '표시 순서', description: '오래된 연도가 작은 숫자', defaultValue: 99, validation: { isRequired: true } }),
      },
    }),

    // ── 성과/활동 ─────────────────────────────────────
    achievements: collection({
      label: '성과·활동',
      path: 'src/content/achievements/*',
      format: { data: 'json' },
      slugField: 'name',
      columns: ['year', 'kind', 'order'],
      schema: {
        name: fields.slug({
          name: { label: '이름', description: '예: CES 2024', validation: { isRequired: true } },
          slug: { label: '파일 ID (영문)' },
        }),
        year: fields.text({ label: '연도', description: '예: 2024' }),
        location: fields.text({ label: '장소', description: '예: Las Vegas' }),
        kind: fields.select({
          label: '종류',
          options: [
            { label: '전시회', value: 'exhibition' },
            { label: '컨퍼런스', value: 'conference' },
            { label: '액셀러레이터', value: 'accelerator' },
            { label: '수상', value: 'award' },
          ],
          defaultValue: 'exhibition',
        }),
        order: fields.integer({ label: '표시 순서', defaultValue: 99, validation: { isRequired: true } }),
      },
    }),

    // ── 파트너 ────────────────────────────────────────
    partners: collection({
      label: '협력 기관·파트너',
      path: 'src/content/partners/*',
      format: { data: 'json' },
      slugField: 'name',
      columns: ['kind', 'order'],
      schema: {
        name: fields.slug({
          name: { label: '기관명', description: '예: KIST', validation: { isRequired: true } },
          slug: { label: '파일 ID (영문)' },
        }),
        logo: fields.image({
          label: '로고 이미지',
          directory: 'src/assets/partners',
          publicPath: '/src/assets/partners/',
        }),
        url: fields.url({ label: '웹사이트 주소 (선택)' }),
        kind: fields.select({
          label: '종류',
          options: [
            { label: '연구기관', value: 'institute' },
            { label: '대학', value: 'university' },
            { label: '기업', value: 'company' },
            { label: '금융', value: 'finance' },
          ],
          defaultValue: 'company',
        }),
        order: fields.integer({ label: '표시 순서', defaultValue: 99, validation: { isRequired: true } }),
      },
    }),

    // ── 서비스 ────────────────────────────────────────
    services: collection({
      label: '서비스',
      path: 'src/content/services/*',
      format: { data: 'json' },
      slugField: 'title',
      columns: ['order'],
      schema: {
        title: fields.slug({
          name: { label: '서비스명', validation: { isRequired: true } },
          slug: { label: '파일 ID (영문)' },
        }),
        description: fields.text({ label: '설명', multiline: true, validation: { isRequired: true } }),
        order: fields.integer({ label: '표시 순서', defaultValue: 99, validation: { isRequired: true } }),
      },
    }),

    // ── 소재 라이브러리 (개발자/연구팀용) ─────────────
    materials: collection({
      label: '소재 라이브러리',
      path: 'src/content/materials/*',
      format: { data: 'json' },
      slugField: 'formula',
      columns: ['system', 'category', 'order'],
      schema: {
        formula: fields.slug({
          name: { label: '화학식', description: '예: VO2, Al2O3', validation: { isRequired: true } },
          slug: { label: '파일 ID', description: '예: m37 — 기존 항목은 m01~m36' },
        }),
        system: fields.select({
          label: '증착 방식',
          options: [
            { label: 'Sputter / Evaporator (PVD)', value: 'sputter' },
            { label: 'ALD', value: 'ald' },
          ],
          defaultValue: 'sputter',
        }),
        category: fields.select({
          label: '분류',
          options: [
            { label: 'Oxide (산화물)', value: 'Oxide' },
            { label: 'Nitride (질화물)', value: 'Nitride' },
            { label: 'Metal (금속)', value: 'Metal' },
          ],
          defaultValue: 'Oxide',
        }),
        order: fields.integer({ label: 'Technology 페이지 표시 순서', defaultValue: 99, validation: { isRequired: true } }),
        home: fields.integer({ label: '홈 화면 노출 순서 (비우면 미노출)' }),
      },
    }),
  },
});
