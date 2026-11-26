// 구글챗 발송의 유일한 통로.
//
// 문의(inquiry)·주문(order)·결제/환율 경보(paypal.ts notifyChat)·메일 오류 알림이 모두 여기로 보낸다.
// 경로가 여러 개면 한 곳을 막아도 다른 곳으로 새어 나간다 — 그래서 한 곳으로 모았다.
//
// 채널(11-26): 'main'(기본 — 문의·견적·주문·결제 알림) · 'alert'(메일 발송 오류 알림 — 별도 채팅방).
//   'alert' 는 런타임 비밀값 GOOGLE_CHAT_WEBHOOK_ALERT 의 웹훅으로 보낸다.
//   그 값이 비어 있으면 기존 GOOGLE_CHAT_WEBHOOK 으로 보낸다(알림을 잃지 않게).
//   오류 방으로 보냈는데 실패(http_error · fetch_error)하면 기존 웹훅으로 한 번 더 보낸다.
//   채널 선택·대체 판정은 chat-channel.js(순수 함수) — 여기서는 값 읽기와 실제 전송만 한다.
//
// 켜짐/꺼짐은 빌드가 정한다(src/lib/chat-mode.js · astro.config.mjs 의 define) — 두 채널 모두 똑같다.
//   Cloudflare main 빌드만 켜지고, 맥미니·로컬·기타 빌드는 코드에서 fetch 자체를 하지 않는다.
//   웹훅이 설정돼 있어도 마찬가지다.
//
// ⚠️ 웹훅은 cloudflare:workers 의 env(런타임 비밀값)에서만 읽는다 — 두 이름 모두 이 파일에서만.
//    import.meta.env 로 읽으면 빌드 때 .env 값이 번들에 문자열로 박힌다.
// ⚠️ 로그에는 태그·접수번호·결과·채널만 남긴다 — 본문(text: 이름·이메일·전화·문의 내용)·웹훅 주소·응답 본문은 남기지 않는다.
import { env as cfEnv } from 'cloudflare:workers';
import { chatChannelOf, chatTargets, chatDeliver } from './chat-channel.js';

declare const __VANAM_CHAT_MODE__: string;

// 비교 대상 문자열을 여기 적지 않는다: 번들 안에 표식이 정확히 하나(빌드가 넣은 값)만
// 남아야 게이트가 이 빌드의 켜짐/꺼짐을 읽을 수 있다.
export const CHAT_ENABLED: boolean = __VANAM_CHAT_MODE__.endsWith('_ON');

export type ChatChannel = 'main' | 'alert';

export type ChatResult = {
  sent: boolean;
  reason: 'blocked_build' | 'no_webhook' | 'http_error' | 'fetch_error' | 'ok';
  status?: number;
  /** 실제로 (마지막에) 보낸 채널 — 오류 방 미설정·전송 실패로 기존 방에 갔으면 'main' */
  channel?: ChatChannel;
};

function secret(name: 'GOOGLE_CHAT_WEBHOOK' | 'GOOGLE_CHAT_WEBHOOK_ALERT'): string {
  const raw = (cfEnv as Record<string, unknown> | undefined)?.[name] ?? '';
  // 대시보드 입력칸이 여러 줄이라 개행·따옴표가 섞여 들어올 수 있어 정리한다.
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
}
const webhookUrl = (): string => secret('GOOGLE_CHAT_WEBHOOK');
const alertWebhookUrl = (): string => secret('GOOGLE_CHAT_WEBHOOK_ALERT');

/** 오류 알림용 별도 채팅방이 설정돼 있는가 — 관리자 화면 상태 줄용. 값은 내보내지 않는다(설정 여부만). */
export function alertChannelConfigured(): boolean {
  return alertWebhookUrl() !== '';
}

type PostResult = { sent: boolean; reason: 'http_error' | 'fetch_error' | 'ok'; status?: number };

/** 웹훅 한 곳으로 보낸다. 예외를 던지지 않는다. */
async function post(url: string, text: string): Promise<PostResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return { sent: false, reason: 'http_error', status: res.status };
    return { sent: true, reason: 'ok', status: res.status };
  } catch {
    return { sent: false, reason: 'fetch_error' };
  }
}

/**
 * @param text 채팅 본문
 * @param opts.tag 로그 구분(inquiry·order·notify) · opts.ref 접수번호/주문번호(진단용, PII 아님)
 *             opts.channel 'main'(기본) | 'alert'(메일 오류 알림 — 별도 채팅방, 없거나 실패하면 기존 채팅방)
 */
export async function sendChat(text: string, opts: { tag: string; ref?: string; channel?: ChatChannel }): Promise<ChatResult> {
  const { tag, ref } = opts;
  const channel = chatChannelOf(opts.channel);
  if (!CHAT_ENABLED) {
    console.warn(`[chat-blocked] ${tag} ${ref ?? ''}${channel === 'alert' ? ' (alert)' : ''}`);
    return { sent: false, reason: 'blocked_build' };
  }

  const targets = chatTargets(channel, { main: webhookUrl(), alert: alertWebhookUrl() });
  if (!targets.length) {
    console.warn(`[${tag}] GOOGLE_CHAT_WEBHOOK 미설정 — 알림을 건너뜁니다.`, ref ?? '');
    return { sent: false, reason: 'no_webhook' };
  }

  const r = await chatDeliver(targets, async (t) => {
    const one = await post(t.url, text);
    if (!one.sent) console.error(`[${tag}] webhook ${one.reason}`, ref ?? '', one.status ?? '', `channel=${t.channel}`);
    return one;
  });
  if (!r) return { sent: false, reason: 'no_webhook' };
  // 오류 방이 아닌 곳으로 간 오류 알림(미설정 · 전송 실패 뒤 대체)은 한 줄 남긴다 — 태그·접수번호·결과·채널만
  if (channel === 'alert' && r.channel !== 'alert') {
    console.warn(`[${tag}] alert → main ${r.fallback ? '(대체 전송)' : '(별도 채팅방 미설정)'}`, ref ?? '', r.reason);
  }
  return { sent: r.sent, reason: r.reason, status: r.status, channel: r.channel };
}
