# VanaM Website

반암(VANAM INC.)의 공식 웹사이트 소스코드입니다. Astro 기반 정적 사이트로 빌드되어 Cloudflare에 배포됩니다.

- **Live**: https://vanam.co.kr (전환 진행 중)
- **Stack**: Astro 6 · Tailwind CSS 4 · Keystatic CMS
- **요구사항**: Node.js 22.12+

## 개발

```bash
npm install
npm run dev      # http://localhost:4321 — 사이트 / /keystatic — 콘텐츠 관리자
npm run build    # 프로덕션 빌드 (Cloudflare 어댑터, dist/client + dist/server)
```

## 콘텐츠 편집 (비개발자용)

개발 서버 실행 후 http://localhost:4321/keystatic 접속. 뉴스·팀·FAQ·연혁·성과·파트너·서비스·소재를 폼으로 편집할 수 있고, 저장하면 `src/content/` 아래 JSON 파일이 직접 수정됩니다. 커밋/푸시하면 사이트에 반영됩니다.

## 구조

- `src/content/` — 콘텐츠 컬렉션 (항목당 JSON 파일 1개, 8종)
- `src/data/site.json` — 페이지 문구 (EN/KO)
- `src/components/pages/` — 페이지 화면 (Home / About / Technology / News / Contact)
- `src/pages/` — 라우트 (영문 기본 `/`, 한국어 `/ko`)
- `keystatic.config.ts` — 콘텐츠 관리자 정의

## 언어

영문이 기본, 한국어는 `/ko` 접두사. hreflang·사이트맵 자동 생성.
