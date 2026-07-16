// VANAM 콘텐츠 관리자 (Keystatic) 설정
//
// 저장 방식: Keystatic Cloud
//   · 편집자는 배포된 사이트의 /keystatic 에서 바로 편집한다 (Mac mini 불필요).
//   · 저장하면 Keystatic 이 GitHub 에 직접 커밋 → Cloudflare 가 자동 재배포.
//     (SSH 로 들어가 git commit/push 하던 과정이 사라진다)
//   · 인증은 keystatic.cloud 가 처리한다. 편집자에게 GitHub 계정이 없어도 된다.
//   · 무료 플랜: 팀당 3명까지.
//
// ⚠️ 왜 github 모드가 아니라 cloud 모드인가 — 실측으로 확인했다:
//     cloud  모드 + 시크릿 없음 → 404 (설계대로. 서버 API 가 아무것도 안 한다)
//     github 모드 + 시크릿 없음 → 💣 "Missing required config ... clientId, clientSecret, secret"
//   github 모드는 저 시크릿 3개가 서버에 있어야 하는데, @keystatic/astro 는 그걸
//   `Astro.locals.runtime.env` 로 읽는다. 그 API 는 Astro 6 에서 제거됐다
//   (우리가 이미 폼 전송 500 으로 겪은 지뢰). cloud 모드는 그 경로를 아예 밟지 않는다.
//
// ⚠️ 콘텐츠 읽기/쓰기는 브라우저가 api.github.com/graphql 로 직접 한다.
//   워커는 관여하지 않으므로 Cloudflare 의 subrequest 한도(50/요청)와 무관하다.
//
// ⚠️ 저장소를 VANAM Org 로 옮기면 Keystatic Cloud 프로젝트도 다시 연결해야 한다.
import { config, fields, collection, singleton } from '@keystatic/core';

export default config({
  storage: { kind: 'cloud' },
  cloud: { project: 'vanam/vanam-website' },

  ui: {
    brand: { name: 'VANAM 콘텐츠 관리' },
    navigation: {
      '콘텐츠': ['news', 'team', 'faq'],
      '회사 정보': ['history', 'achievements', 'partners', 'certificates'],
      '기술 데이터': ['services', 'materials'],
      '스토어': ['products'],
      '사업자·정책': ['company', 'policies'],
    },
  },

  singletons: {
    // ── 사업자 정보 (푸터·정책 문서에 자동 반영) ──────────
    company: singleton({
      label: '사업자 정보',
      path: 'src/data/company',
      format: { data: 'json' },
      schema: {
        nameKo: fields.text({ label: '상호 (국문)', description: '사업자등록증과 동일해야 합니다', validation: { isRequired: true } }),
        nameEn: fields.text({ label: '상호 (영문)', validation: { isRequired: true } }),
        ceoKo: fields.text({ label: '대표자 (국문)', validation: { isRequired: true } }),
        ceoEn: fields.text({ label: '대표자 (영문)' }),
        bizNo: fields.text({ label: '사업자등록번호', description: '예: 894-86-02635', validation: { isRequired: true } }),
        mailOrderNo: fields.text({ label: '통신판매업 신고번호', description: '예: 2025-서울영등포-1534', validation: { isRequired: true } }),
        zip: fields.text({ label: '우편번호' }),
        addressKo: fields.text({ label: '사업장 주소 (국문)', validation: { isRequired: true } }),
        addressEn: fields.text({ label: '사업장 주소 (영문)' }),
        tel: fields.text({ label: '대표 전화', validation: { isRequired: true } }),
        email: fields.text({ label: '대표 이메일', validation: { isRequired: true } }),

        officerNameKo: fields.text({ label: '개인정보 보호책임자 — 성명 (국문)' }),
        officerNameEn: fields.text({ label: '개인정보 보호책임자 — 성명 (영문)' }),
        officerTitleKo: fields.text({ label: '개인정보 보호책임자 — 직책 (국문)' }),
        officerTitleEn: fields.text({ label: '개인정보 보호책임자 — 직책 (영문)' }),
        officerEmail: fields.text({ label: '개인정보 보호책임자 — 이메일' }),

        shipDomesticMode: fields.select({
          label: '국내 배송비',
          options: [
            { label: '무료 배송', value: 'free' },
            { label: '수령인 착불', value: 'collect' },
            { label: '주문 확인 후 별도 안내', value: 'quote' },
          ],
          defaultValue: 'free',
        }),
        shipIntlMode: fields.select({
          label: '해외 배송비',
          description: '착불을 고르면 주문서에서 수령인의 택배사 계정번호(FedEx/DHL 등)를 받습니다.',
          options: [
            { label: '무료 배송', value: 'free' },
            { label: '수령인 착불 (택배사 계정 청구)', value: 'collect' },
            { label: '주문 확인 후 별도 안내', value: 'quote' },
          ],
          defaultValue: 'free',
        }),
        shipLeadKo: fields.text({ label: '발송 소요 (국문)', multiline: true }),
        shipLeadEn: fields.text({ label: '발송 소요 (영문)', multiline: true }),
        shipCarrierKo: fields.text({ label: '택배사 (국문)' }),
        shipCarrierEn: fields.text({ label: '택배사 (영문)' }),

        withdrawDays: fields.integer({ label: '청약철회 기간 (일)', defaultValue: 7, validation: { isRequired: true } }),
        refundDays: fields.integer({ label: '환불 처리 기간 (영업일)', defaultValue: 3, validation: { isRequired: true } }),
      },
    }),
    banner: singleton({
      label: '상단 공지 배너',
      path: 'src/data/banner',
      format: { data: 'json' },
      schema: {
        enabled: fields.checkbox({ label: '배너 표시', description: '체크하면 사이트 최상단에 공지 배너가 뜹니다.', defaultValue: false }),
        textKo: fields.text({ label: '문구 (국문)', description: '예: 🎓 VANAM이 반도체대전(SEDEX)에 참가합니다 — 부스 A-12', multiline: true }),
        textEn: fields.text({ label: '문구 (영문)', multiline: true }),
        linkUrl: fields.text({ label: '링크 주소 (선택)', description: '누르면 이동할 주소. 비우면 링크 없는 안내만 표시됩니다. 예: /news 또는 https://…' }),
        linkLabelKo: fields.text({ label: '링크 버튼 문구 (국문)', description: '예: 자세히 보기' }),
        linkLabelEn: fields.text({ label: '링크 버튼 문구 (영문)', description: '예: Learn more' }),
        tone: fields.select({
          label: '배너 색상',
          description: '일반 공지는 브랜드, 중요/긴급은 강조 색을 쓰세요.',
          options: [
            { label: '브랜드 (기본)', value: 'brand' },
            { label: '강조 (중요·긴급)', value: 'accent' },
            { label: '차분 (은은한 안내)', value: 'muted' },
          ],
          defaultValue: 'brand',
        }),
        dismissible: fields.checkbox({ label: '"오늘 하루 보지 않기" 허용', description: '방문자가 배너를 하루 동안 닫을 수 있게 합니다.', defaultValue: true }),
      },
    }),
  },

  collections: {
    // ── 약관·정책 ──────────────────────────────────────
    // 본문에 {officerName} {officerTitle} {officerEmail} {tel} {email}
    //         {withdrawDays} {refundDays} {shipFee} {shipLead}
    // 를 쓰면 '사업자 정보'의 값으로 자동 치환됩니다.
    policies: collection({
      label: '약관·정책',
      path: 'src/content/policies/*',
      format: { data: 'json' },
      slugField: 'title',
      columns: ['kind', 'lang', 'updated'],
      schema: {
        title: fields.slug({
          name: { label: '제목', validation: { isRequired: true } },
          slug: { label: '파일 ID', description: '예: privacy-ko, terms-en' },
        }),
        kind: fields.select({
          label: '문서 종류',
          options: [
            { label: '개인정보처리방침', value: 'privacy' },
            { label: '이용약관', value: 'terms' },
            { label: '환불·교환 정책', value: 'refund' },
          ],
          defaultValue: 'privacy',
        }),
        lang: fields.select({
          label: '언어',
          options: [{ label: '한국어', value: 'ko' }, { label: 'English', value: 'en' }],
          defaultValue: 'ko',
        }),
        updated: fields.text({ label: '시행일', description: '예: 2026-07-13', validation: { isRequired: true } }),
        intro: fields.text({ label: '머리말', multiline: true }),
        sections: fields.array(
          fields.object({
            heading: fields.text({ label: '조항 제목', validation: { isRequired: true } }),
            body: fields.text({ label: '내용', multiline: true, validation: { isRequired: true } }),
          }),
          { label: '조항', itemLabel: (p) => p.fields.heading.value || '(제목 없음)' },
        ),
        order: fields.integer({ label: '표시 순서', defaultValue: 1, validation: { isRequired: true } }),
      },
    }),

    // ── 특허·인증서 ────────────────────────────────────
    certificates: collection({
      label: '특허·인증서',
      path: 'src/content/certificates/*',
      format: { data: 'json' },
      slugField: 'name',
      columns: ['kind', 'number', 'order'],
      schema: {
        name: fields.slug({
          name: { label: '명칭 (한글)', validation: { isRequired: true } },
          slug: { label: '파일 ID (영문/숫자)', description: '예: patent-10-1234567' },
        }),
        name_en: fields.text({ label: '명칭 (영문)' }),
        kind: fields.select({
          label: '종류',
          options: [
            { label: '특허', value: 'patent' },
            { label: '인증서', value: 'certification' },
          ],
          defaultValue: 'patent',
        }),
        number: fields.text({ label: '등록·확인 번호', description: '예: 10-2663966' }),
        date: fields.text({ label: '등록일', description: '예: 2024-05-02' }),
        image: fields.image({
          label: '증서 이미지',
          directory: 'src/assets/certificates',
          publicPath: '/src/assets/certificates/',
          validation: { isRequired: true },
        }),
        published: fields.checkbox({ label: '사이트에 공개', defaultValue: true }),
        order: fields.integer({ label: '표시 순서', defaultValue: 99, validation: { isRequired: true } }),
      },
    }),

    // ── 스토어 상품 ────────────────────────────────────
    products: collection({
      label: '스토어 상품',
      path: 'src/content/products/*',
      format: { data: 'json' },
      slugField: 'name',
      columns: ['category', 'pricingType', 'price', 'order'],
      schema: {
        name: fields.slug({
          name: { label: '상품명 (한글)', validation: { isRequired: true } },
          slug: {
            label: '상품 코드 (SKU · 영문/숫자/하이픈)',
            description: '주문·결제·주소에 쓰입니다. 예: vo2-sample-si2 — 만든 뒤에는 바꾸지 마세요',
          },
        }),
        name_en: fields.text({ label: '상품명 (영문)' }),
        category: fields.select({
          label: '분류',
          options: [
            { label: '시편·샘플', value: 'sample' },
            { label: '코팅 서비스', value: 'coating' },
            { label: '분석 서비스', value: 'analysis' },
            { label: '기타', value: 'etc' },
          ],
          defaultValue: 'sample',
        }),
        pricingType: fields.select({
          label: '가격 유형',
          description: '고정가 = 바로 장바구니·결제 / 견적가 = 스펙 접수 후 담당자가 금액을 책정해 결제 링크를 보냅니다',
          options: [
            { label: '고정가 (즉시 구매)', value: 'fixed' },
            { label: '견적가 (문의 후 책정)', value: 'quote' },
          ],
          defaultValue: 'fixed',
        }),
        requiresShipping: fields.checkbox({
          label: '실물 배송 필요',
          description: '체크 해제하면 주문서에서 배송지를 받지 않습니다. (예: 분석 서비스 — 고객이 시료를 보내오는 경우)',
          defaultValue: true,
        }),
        price: fields.number({
          label: '판매가 (원, 부가세 포함)',
          description: '고정가 상품만 입력하세요. 견적가 상품은 비워둡니다.',
        }),
        summary: fields.text({ label: '한 줄 소개 (한글)', validation: { isRequired: true } }),
        summary_en: fields.text({ label: '한 줄 소개 (영문)' }),
        description: fields.text({ label: '상세 설명 (한글)', multiline: true }),
        description_en: fields.text({ label: '상세 설명 (영문)', multiline: true }),
        image: fields.image({
          label: '대표 이미지',
          directory: 'src/assets/products',
          publicPath: '/src/assets/products/',
        }),
        specs: fields.array(
          fields.object({
            label: fields.text({ label: '항목', description: '예: 소재 / 두께 / 기판 / 크기' }),
            value: fields.text({ label: '값', description: '예: VO₂ / 100 nm / Si 2인치' }),
            label_en: fields.text({ label: '항목 (영문)', description: '예: Material / Thickness / Substrate' }),
            value_en: fields.text({ label: '값 (영문)', description: '비우면 국문 값이 그대로 표시됩니다' }),
          }),
          { label: '사양', itemLabel: (p) => `${p.fields.label.value}: ${p.fields.value.value}` },
        ),
        leadTime: fields.text({ label: '납기 안내 (한글)', description: '예: 주문 후 2~3주' }),
        leadTime_en: fields.text({ label: '납기 안내 (영문)' }),
        shipping: fields.text({ label: '배송 안내 (한글)', description: '예: 택배 발송 (배송비 3,000원)' }),
        shipping_en: fields.text({ label: '배송 안내 (영문)' }),
        published: fields.checkbox({ label: '사이트에 공개', defaultValue: true }),
        order: fields.integer({ label: '표시 순서', defaultValue: 99, validation: { isRequired: true } }),
      },
    }),

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
      columns: ['role_ko', 'order'],
      schema: {
        name: fields.slug({
          name: { label: '이름', description: '예: Dr. SD HAN', validation: { isRequired: true } },
          slug: { label: '파일 ID (영문)', description: '예: sd-han' },
        }),
        role: fields.text({ label: '직책 (영문)', description: '예: CEO · Ph.D' }),
        role_ko: fields.text({ label: '직책 (한글)', description: '예: 대표이사 · 박사' }),
        affiliation: fields.text({ label: '이력·소속 (영문)', description: '예: KIST · Univ. of Cambridge (UK)' }),
        affiliation_ko: fields.text({ label: '이력·소속 (한글)', description: '예: KIST · 케임브리지대 (영국)' }),
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
          name: { label: '질문 (한글)', validation: { isRequired: true } },
          slug: { label: '파일 ID (영문)', description: '예: lead-time' },
        }),
        answer: fields.text({ label: '답변 (한글)', multiline: true, description: '비워두면 사이트에 표시되지 않습니다' }),
        question_en: fields.text({ label: '질문 (영문)', description: '비우면 한글이 표시됩니다' }),
        answer_en: fields.text({ label: '답변 (영문)', multiline: true }),
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
          { label: '주요 사건 — 영문 (About EN)', itemLabel: (props) => props.value || '(비어 있음)' },
        ),
        items_ko: fields.array(
          fields.text({ label: '내용 (한글)' }),
          { label: '주요 사건 — 한글 (About KO, 비우면 영문이 표시됨)', itemLabel: (props) => props.value || '(비어 있음)' },
        ),
        summary_en: fields.text({ label: '한 줄 요약 — 영문 (홈 EN)', multiline: true }),
        summaryKo: fields.text({ label: '한 줄 요약 — 한글 (홈 KO)', multiline: true }),
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
          name: { label: '서비스명 (영문)', validation: { isRequired: true } },
          slug: { label: '파일 ID (영문)' },
        }),
        description: fields.text({ label: '설명 (영문)', multiline: true, validation: { isRequired: true } }),
        title_ko: fields.text({ label: '서비스명 (한글)', description: '비우면 영문이 표시됩니다' }),
        description_ko: fields.text({ label: '설명 (한글)', multiline: true }),
        bullets: fields.array(fields.text({ label: '항목' }), {
          label: '상세 항목 (영문)',
          itemLabel: (p) => p.value,
        }),
        bullets_ko: fields.array(fields.text({ label: '항목' }), {
          label: '상세 항목 (한글)',
          itemLabel: (p) => p.value,
        }),
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

    // ── 벌크 vs 박막 비교 (기술 페이지) ──────────────
    comparison: collection({
      label: '벌크 vs 박막 비교',
      path: 'src/content/comparison/*',
      format: { data: 'json' },
      slugField: 'label',
      columns: ['label_ko', 'order'],
      schema: {
        label: fields.slug({ name: { label: '비교 항목 (영문)', description: '예: Process steps' } }),
        label_ko: fields.text({ label: '비교 항목 (한글)', description: '예: 공정 단계' }),
        bulk: fields.text({ label: '기존 벌크 (영문)' }),
        bulk_ko: fields.text({ label: '기존 벌크 (한글)' }),
        film: fields.text({ label: '반암 박막 (영문)' }),
        film_ko: fields.text({ label: '반암 박막 (한글)' }),
        note: fields.text({ label: '보조 설명 (영문)', description: '박막 값 아래 작게 붙습니다. 예: under 1/10,000' }),
        note_ko: fields.text({ label: '보조 설명 (한글)' }),
        order: fields.integer({ label: '표시 순서', defaultValue: 0 }),
      },
    }),

    // ── 장비 ─────────────────────────────────────────
    equipment: collection({
      label: '장비',
      path: 'src/content/equipment/*',
      format: { data: 'json' },
      slugField: 'name',
      columns: ['name_ko', 'category', 'order'],
      schema: {
        name: fields.slug({ name: { label: '장비명 (영문)' } }),
        name_ko: fields.text({ label: '장비명 (한글)' }),
        category: fields.select({
          label: '분류',
          options: [
            { label: '증착 장비', value: 'deposition' },
            { label: '데이터 수집', value: 'data' },
            { label: '인프라', value: 'infra' },
          ],
          defaultValue: 'deposition',
        }),
        description: fields.text({ label: '설명 (영문)', multiline: true }),
        description_ko: fields.text({ label: '설명 (한글)', multiline: true }),
        order: fields.integer({ label: '표시 순서', defaultValue: 0 }),
      },
    }),

    // ── 분석·측정 항목 (스토어의 분석 상품과 연결) ───
    analysis: collection({
      label: '분석 · 측정 항목',
      path: 'src/content/analysis/*',
      format: { data: 'json' },
      slugField: 'name',
      columns: ['group', 'order'],
      schema: {
        name: fields.slug({ name: { label: '항목명', description: '예: XRD, I–V' } }),
        group: fields.select({
          label: '분류',
          options: [
            { label: '소재 분석', value: 'material' },
            { label: '소자 특성 분석', value: 'device' },
          ],
          defaultValue: 'material',
        }),
        description: fields.text({ label: '설명 (영문)' }),
        description_ko: fields.text({ label: '설명 (한글)' }),
        order: fields.integer({ label: '표시 순서', defaultValue: 0 }),
      },
    }),
  },
});
