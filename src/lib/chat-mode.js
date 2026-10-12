// 구글챗 알림 켜짐/꺼짐 — **빌드 시점에** 정한다. (빌드 설정 전용 — 런타임 코드는 import 금지)
//
// 왜 빌드 시점인가:
//   맥미니에서 빌드하면 .env 의 웹훅이 번들·.dev.vars 로 따라 들어가, 로컬 테스트 한 번이
//   실제 채팅방 알림이 됐다. 로컬 설정(.env 를 비워라)에 기대면 언젠가 또 잊는다.
//   → "어디서 만든 빌드인가"로 정한다. Cloudflare Workers Builds 는 WORKERS_CI=1,
//     WORKERS_CI_BRANCH=<브랜치> 를 설정한다. 그 main 빌드만 켜고 나머지는 전부 끈다.
//
// ⚠️ 켜짐 표식 문자열은 이 파일에만 둔다. 런타임 파일에 있으면 번들 안의 표식이
//    몇 개인지로 켜짐/꺼짐을 판정할 수 없게 된다(scripts/check-chat-guard.mjs 가 막는다).

export const CHAT_MODE_ON = 'CHAT_MODE_ON';
export const CHAT_MODE_OFF = 'CHAT_MODE_OFF';

/**
 * @param {Record<string, string | undefined>} env 보통 process.env
 * @returns {'CHAT_MODE_ON' | 'CHAT_MODE_OFF'}
 * @throws Cloudflare 빌드(WORKERS_CI=1)인데 브랜치 정보가 없을 때 — 조용히 꺼진 채 배포되는 것을 막는다.
 */
export function chatModeAtBuild(env) {
  if (env?.WORKERS_CI === '1') {
    const branch = env?.WORKERS_CI_BRANCH;
    if (typeof branch !== 'string' || branch.trim() === '') {
      throw new Error('Cloudflare 빌드인데 브랜치 정보가 없습니다 — 구글챗 알림 판정 불가');
    }
    return branch === 'main' ? CHAT_MODE_ON : CHAT_MODE_OFF;
  }
  return CHAT_MODE_OFF;
}
