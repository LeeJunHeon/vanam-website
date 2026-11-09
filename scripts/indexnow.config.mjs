// IndexNow 설정 — 바뀐 주소를 참여 검색엔진(Bing·Naver·Yandex·Seznam·Yep 등)에 알리는 데 쓴다. 구글은 참여하지 않는다.
//   흐름: npm run build 의 scripts/indexnow-targets.mjs 가 알림 대상을 계산해 dist/indexnow-targets.json 에 남기고,
//        배포(npm run deploy)가 성공한 뒤 scripts/indexnow-submit.mjs 가 그 목록을 api.indexnow.org 로 보낸다.
//   키 파일: public/<key>.txt (내용은 키 문자열만) → https://vanam.co.kr/<key>.txt 에서 200 이어야 한다(검증 게이트 scripts/check-indexnow.mjs).
//   ⚠️ 키를 바꾸면 public/<옛 키>.txt 를 지우고 public/<새 키>.txt 를 만든다. 게이트가 둘의 일치를 확인한다.
export default {
  host: 'vanam.co.kr',
  key: 'gigeiyxur0kpdummfk7z8eumzmx1gt3z', // 영문 소문자·숫자 32자
  endpoint: 'https://api.indexnow.org/indexnow', // 환경변수 INDEXNOW_ENDPOINT 로 바꿀 수 있다(테스트용)
  productionBranch: 'main', // 이 브랜치의 Workers Builds 배포(WORKERS_CI=1 · WORKERS_CI_BRANCH)에서만 보낸다
  targetsFile: 'dist/indexnow-targets.json', // 알림 대상 목록 — dist/client 밖(공개되지 않는 위치)이어야 한다
  maxPerRequest: 10000, // IndexNow 1회 요청 상한
  live: {
    base: 'https://vanam.co.kr', // 환경변수 INDEXNOW_LIVE_BASE 로 바꿀 수 있다(테스트용)
    timeoutMs: 10000,
    // 보내기 전 "라이브가 이번 빌드인가" 확인 — /sitemap-lastmod.json 이 이번 빌드 것과 같아질 때까지 기다린다
    waitAttempts: 8,
    waitIntervalMs: 15000,
  },
};
