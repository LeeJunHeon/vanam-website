// 구글챗 채널 — 어느 채팅방(웹훅)으로 보낼지와 대체 순서를 정하는 순수 함수.
//
// 채널: 'main'(기본 — 문의·견적·주문·결제 알림) · 'alert'(메일 발송 오류 알림 — 별도 채팅방).
//   'alert' 채널의 웹훅이 설정돼 있지 않으면 기존(main) 채팅방으로 보낸다 — 알림을 잃지 않게.
//   'alert' 채팅방으로 보냈는데 실패(http_error · fetch_error)하면 기존 채팅방으로 한 번 더 보낸다.
//
// ⚠️ .js 이고 다른 모듈을 import 하지 않는다 — node 테스트(scripts/test-chat-guard.mjs)가 빌드 없이 확인한다.
// ⚠️ 웹훅 값은 인자로만 받는다 — 비밀값 이름·읽기는 chat-send.ts 에만 둔다(scripts/check-chat-guard.mjs).
//    여기서는 값을 로그·오류 문구에 싣지 않는다.

/** @typedef {'main' | 'alert'} ChatChannel */

/** 채널 이름 정리 — 'alert' 가 아니면 모두 'main'. @param {unknown} channel @returns {ChatChannel} */
export function chatChannelOf(channel) {
  return channel === 'alert' ? 'alert' : 'main';
}

/**
 * 보낼 곳 목록(앞에서부터 시도). 비어 있으면 웹훅 미설정.
 *   main  → [기존]
 *   alert → [오류 방, 기존] · 오류 방 웹훅이 없으면 [기존] · 두 값이 같으면 한 번만
 * @param {unknown} channel
 * @param {{ main?: string, alert?: string }} urls 정리된 웹훅 값(없으면 빈 문자열)
 * @returns {{ channel: ChatChannel, url: string }[]}
 */
export function chatTargets(channel, urls) {
  const main = typeof urls?.main === 'string' ? urls.main : '';
  const alert = typeof urls?.alert === 'string' ? urls.alert : '';
  const out = [];
  if (chatChannelOf(channel) === 'alert' && alert) out.push({ channel: /** @type {ChatChannel} */ ('alert'), url: alert });
  if (main && !out.some((t) => t.url === main)) out.push({ channel: /** @type {ChatChannel} */ ('main'), url: main });
  return out;
}

/** 이 결과면 다음 곳으로 한 번 더 보낸다(전송 실패만). @param {{ sent?: boolean, reason?: string } | null | undefined} r */
export function chatShouldFallback(r) {
  return !r?.sent && (r?.reason === 'http_error' || r?.reason === 'fetch_error');
}

/**
 * 목록을 앞에서부터 보낸다 — 성공하면 멈추고, 전송 실패면 다음 곳으로. 마지막 결과를 돌려준다.
 * @template {{ sent: boolean, reason: string }} R
 * @param {{ channel: ChatChannel, url: string }[]} targets
 * @param {(t: { channel: ChatChannel, url: string }) => Promise<R>} post 한 곳으로 보내기(실제 통로는 chat-send.ts · 테스트는 가짜)
 * @returns {Promise<(R & { channel: ChatChannel, fallback: boolean }) | null>} 목록이 비면 null
 */
export async function chatDeliver(targets, post) {
  let last = null;
  for (let i = 0; i < targets.length; i++) {
    const r = await post(targets[i]);
    last = { ...r, channel: targets[i].channel, fallback: i > 0 };
    if (!chatShouldFallback(r)) break;
  }
  return last;
}
