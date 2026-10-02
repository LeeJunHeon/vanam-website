// 고객 메일(접수 확인 메일) 운영/테스트 — **빌드 시점에** 정한다. (빌드 설정 전용 — 런타임 코드는 import 금지)
//
// 구글챗(chat-mode.js)과 같은 원칙: "어디서 만든 빌드인가"로 정한다.
//   Cloudflare Workers Builds 의 main 빌드만 운영(MAIL_MODE_LIVE) — 고객 주소로 보낸다.
//   맥미니·로컬·기타 빌드는 전부 테스트(MAIL_MODE_TEST) — 회사 주소(@vanam.co.kr)로만 보내고,
//   그 밖의 주소는 코드에서 막는다(src/lib/mail-send.ts). 로컬 설정에 기대지 않는다.
//
// ⚠️ 운영 표식 문자열은 이 파일에만 둔다. 런타임 파일에 있으면 번들 안의 표식이
//    몇 개인지로 운영/테스트를 판정할 수 없게 된다(scripts/check-mail-guard.mjs 가 막는다).

export const MAIL_MODE_LIVE = 'MAIL_MODE_LIVE';
export const MAIL_MODE_TEST = 'MAIL_MODE_TEST';

/**
 * @param {Record<string, string | undefined>} env 보통 process.env
 * @returns {'MAIL_MODE_LIVE' | 'MAIL_MODE_TEST'}
 * @throws Cloudflare 빌드(WORKERS_CI=1)인데 브랜치 정보가 없을 때 — 조용히 테스트 모드로 배포되는 것을 막는다.
 */
export function mailModeAtBuild(env) {
  if (env?.WORKERS_CI === '1') {
    const branch = env?.WORKERS_CI_BRANCH;
    if (typeof branch !== 'string' || branch.trim() === '') {
      throw new Error('Cloudflare 빌드인데 브랜치 정보가 없습니다 — 고객 메일 모드 판정 불가');
    }
    return branch === 'main' ? MAIL_MODE_LIVE : MAIL_MODE_TEST;
  }
  return MAIL_MODE_TEST;
}
