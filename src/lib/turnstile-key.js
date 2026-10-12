// Turnstile 사이트 키 — **빌드 시점에** 정한다. (빌드 설정 전용 — astro.config.mjs 와 검사 스크립트만 import)
//
// 왜: 운영 사이트 키는 localhost 에서 위젯이 뜨지 않아, 로컬에서 폼 제출 시험을 할 수 없다.
//   Cloudflare 공식 테스트 사이트 키(어느 도메인에서나 항상 통과)를 npm run local 빌드에만 쓴다.
//   로컬 .dev.vars 의 TURNSTILE_SECRET 은 빈 값이라 서버 검증은 원래 건너뛴다(기존 동작).
//
// ⚠️ Cloudflare 빌드(WORKERS_CI=1)에 VANAM_LOCAL_TURNSTILE 가 있으면(빈 값 포함) 빌드를 멈춘다 —
//    테스트 키가 운영에 나가는 사고를 구조로 막는다.
// ⚠️ 두 키 문자열은 이 파일에만 둔다(scripts/check-turnstile-key.mjs 가 확인한다).

export const TURNSTILE_SITEKEY_PROD = '0x4AAAAAAD5eNOFVFYfnvXUA';
export const TURNSTILE_SITEKEY_TEST = '1x00000000000000000000AA';

/**
 * @param {Record<string, string | undefined>} env 보통 process.env
 * @returns {string} 사이트 키
 * @throws Cloudflare 빌드에 VANAM_LOCAL_TURNSTILE 가 정의돼 있을 때
 */
export function turnstileSitekeyAtBuild(env) {
  if (env?.WORKERS_CI === '1') {
    if (env?.VANAM_LOCAL_TURNSTILE !== undefined) {
      throw new Error('Cloudflare 빌드에서는 Turnstile 테스트 키를 쓸 수 없습니다 (VANAM_LOCAL_TURNSTILE 를 지우세요)');
    }
    return TURNSTILE_SITEKEY_PROD;
  }
  return env?.VANAM_LOCAL_TURNSTILE === 'test' ? TURNSTILE_SITEKEY_TEST : TURNSTILE_SITEKEY_PROD;
}
