// 구글챗 발송의 유일한 통로.
//
// 문의(inquiry)·주문(order)·결제/환율 경보(paypal.ts notifyChat)가 모두 여기로 보낸다.
// 경로가 여러 개면 한 곳을 막아도 다른 곳으로 새어 나간다 — 그래서 한 곳으로 모았다.
//
// 켜짐/꺼짐은 빌드가 정한다(src/lib/chat-mode.js · astro.config.mjs 의 define).
//   Cloudflare main 빌드만 켜지고, 맥미니·로컬·기타 빌드는 코드에서 fetch 자체를 하지 않는다.
//   웹훅이 설정돼 있어도 마찬가지다.
//
// ⚠️ 웹훅은 cloudflare:workers 의 env(런타임 비밀값)에서만 읽는다.
//    import.meta.env 로 읽으면 빌드 때 .env 값이 번들에 문자열로 박힌다.
// ⚠️ 로그에 본문(text)을 남기지 않는다 — 이름·이메일·전화·문의 내용이 들어 있다.
import { env as cfEnv } from 'cloudflare:workers';

declare const __VANAM_CHAT_MODE__: string;

// 비교 대상 문자열을 여기 적지 않는다: 번들 안에 표식이 정확히 하나(빌드가 넣은 값)만
// 남아야 게이트가 이 빌드의 켜짐/꺼짐을 읽을 수 있다.
export const CHAT_ENABLED: boolean = __VANAM_CHAT_MODE__.endsWith('_ON');

export type ChatResult = {
  sent: boolean;
  reason: 'blocked_build' | 'no_webhook' | 'http_error' | 'fetch_error' | 'ok';
  status?: number;
};

function webhookUrl(): string {
  const raw = (cfEnv as Record<string, unknown> | undefined)?.GOOGLE_CHAT_WEBHOOK ?? '';
  // 대시보드 입력칸이 여러 줄이라 개행·따옴표가 섞여 들어올 수 있어 정리한다.
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
}

/**
 * @param text 채팅 본문
 * @param opts.tag 로그 구분(inquiry·order·notify) · opts.ref 접수번호/주문번호(진단용, PII 아님)
 */
export async function sendChat(text: string, opts: { tag: string; ref?: string }): Promise<ChatResult> {
  const { tag, ref } = opts;
  if (!CHAT_ENABLED) {
    console.warn(`[chat-blocked] ${tag} ${ref ?? ''}`);
    return { sent: false, reason: 'blocked_build' };
  }

  const webhook = webhookUrl();
  if (!webhook) {
    console.warn(`[${tag}] GOOGLE_CHAT_WEBHOOK 미설정 — 알림을 건너뜁니다.`, ref ?? '');
    return { sent: false, reason: 'no_webhook' };
  }

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`[${tag}] webhook failed:`, res.status, await res.text().catch(() => ''));
      return { sent: false, reason: 'http_error', status: res.status };
    }
    return { sent: true, reason: 'ok', status: res.status };
  } catch (err) {
    console.error(`[${tag}] webhook error:`, err);
    return { sent: false, reason: 'fetch_error' };
  }
}
