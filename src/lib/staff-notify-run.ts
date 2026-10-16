// 담당자 알림 메일 — 실행부(받는 주소 읽기 · 건너뛰기 · 발송 · 실패 알림).
//
// 부르는 곳: 문의 접수(api/inquiry.ts) — 고객에게 성공으로 응답하는 경로에서, 응답 뒤(waitUntil)에.
// 판정 순서와 제목·본문은 staff-notify.js(순수 함수)가 정한다 — 여기서는 실제 값과 통로만 넘긴다.
//   운영 빌드(MAIL_LIVE)만 보낸다. 테스트 빌드는 받는 주소도 읽지 않는다(시험 접수가 담당자 메일함으로 가지 않게).
//   발송은 mail-send.ts 의 sendMail 하나로만(호스트·주소 검사 그대로) · 실패 알림은 chat-send.ts 의 sendChat 으로만.
// 받는 주소는 Cloudflare 비밀값 INQUIRY_NOTIFY_TO — cloudflare:workers 의 env 에서만 읽는다(mail-send.ts 와 같은 방식).
//   ⚠️ 빌드 환경 변수 경로로 읽지 않는다(그 글자를 주석으로도 쓰지 않는다 — scripts/check-mail-guard.mjs).
// 원칙: 예외를 밖으로 던지지 않는다 — 접수 응답·확인 메일·구글챗에 영향이 없다.
//       로그에는 태그·접수번호·결과 사유만(주소·본문·고객 정보 금지).
import { env as cfEnv } from 'cloudflare:workers';
import { sendMail, MAIL_LIVE } from './mail-send';
import { sendChat } from './chat-send';
import { isSafeAddress } from './mail-mime.js';
import { staffNotifyFlow, staffSubject, staffText, staffHtml, STAFF_FROM_NAME } from './staff-notify.js';

const TAG = 'staff-mail';

function notifyTo(): string {
  const raw = (cfEnv as Record<string, unknown> | undefined)?.INQUIRY_NOTIFY_TO ?? '';
  // 대시보드 입력칸에 개행·따옴표가 섞여 들어올 수 있어 정리한다(mail-send.ts 의 secret 과 같게).
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
}

export type StaffNotifyInput = Parameters<typeof staffText>[0];

/** 담당자 알림 한 통(접수 한 건). 결과 사유를 돌려주고 예외를 던지지 않는다. */
export async function runStaffNotify(p: StaffNotifyInput): Promise<{ sent: boolean; reason: string }> {
  let r: { sent: boolean; reason: string };
  try {
    r = await staffNotifyFlow({
      live: MAIL_LIVE,
      id: p.id,
      readTo: notifyTo,
      isSafeAddress,
      send: (to: string) => {
        const text = staffText(p);
        return sendMail(
          { to, fromName: STAFF_FROM_NAME, subject: staffSubject(p), text, html: staffHtml(text) },
          { tag: TAG, ref: p.id, origin: p.origin },
        );
      },
      alert: (text: string) => sendChat(text, { tag: TAG, ref: p.id }),
    });
  } catch {
    r = { sent: false, reason: 'error' };
  }
  console.log(`[${TAG}] ${p.id} ${r.reason}`);
  return r;
}
