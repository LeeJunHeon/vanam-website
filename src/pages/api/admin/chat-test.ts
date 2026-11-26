// 관리자: 오류 알림 테스트 보내기 — 메일 오류 알림(alert 채널)이 실제로 어느 채팅방으로 가는지 확인한다
//
// sendChat 을 alert 채널로 한 번 부른다(유일한 발송 통로 — src/lib/chat-send.ts). 본문은 시험 메시지 한 줄뿐(고객 정보 없음).
// 응답의 result 는 결과 구분만 담는다(src/lib/chat-test.js) — 별도 채팅방 / 설정 없어 기존 채팅방 / 전송 실패로 기존 채팅방 / 실패 / 테스트 빌드.
//   웹훅 값은 돌려주지도 남기지도 않는다. 테스트 빌드에서는 보내지 않는다(chat-send.ts 가 막는다).
// 횟수 제한: 1분에 3회(RATE_RULES.chatTest) — 채팅방에 시험 메시지가 쏟아지지 않게.
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db, nowKst } from '../../../lib/db';
import { rateLimit, tooMany } from '../../../lib/rate-limit';
import { sendChat } from '../../../lib/chat-send';
import { chatTestMessage, chatTestOutcome, CHAT_TEST_TAG } from '../../../lib/chat-test.js';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const POST: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);

  // DB 가 없으면 횟수 제한 없이 통과한다(rateLimit 의 기존 동작 — 알림 확인은 DB 와 무관하게 돼야 한다)
  const rl = await rateLimit(await db(), 'chatTest', request);
  if (!rl.ok) return tooMany(rl.retryAfterSec);

  let outcome: ReturnType<typeof chatTestOutcome>;
  try {
    outcome = chatTestOutcome(await sendChat(chatTestMessage(nowKst()), { tag: CHAT_TEST_TAG, channel: 'alert' }));
  } catch {
    outcome = chatTestOutcome({ sent: false, reason: 'error' });
  }
  console.log(`[${CHAT_TEST_TAG}] ${outcome.code}${outcome.reason ? ` ${outcome.reason}` : ''}`);
  return json({ ok: outcome.ok, result: outcome });
};
