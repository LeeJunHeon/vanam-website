// 담당자 알림 메일 — 실행부(받는 주소 읽기 · 건너뛰기 · 발송 · 결과 기록 · 실패 알림).
//
// 부르는 곳: ① 문의 접수(api/inquiry.ts) — 고객에게 성공으로 응답하는 경로에서, 응답 뒤(waitUntil)에
//            ② 관리자 [담당자 메일 (다시) 보내기](api/admin/staff-mail.ts) — 저장된 접수 행으로 같은 내용을 다시 만든다
// 판정 순서와 제목·본문은 staff-notify.js(순수 함수)가 정한다 — 여기서는 실제 값과 통로만 넘긴다.
//   운영 빌드(MAIL_LIVE)만 보낸다. 테스트 빌드는 받는 주소도 읽지 않는다(시험 접수가 담당자 메일함으로 가지 않게).
//   발송은 mail-send.ts 의 sendMail 하나로만(호스트·주소 검사 그대로) · 실패 알림은 chat-send.ts 의 sendChat 으로만(오류 알림 채널 'alert').
// 결과는 inquiries.staff_mail 에 남긴다(기록 모양·순서는 staff-notify-record.js — '보내는 중' → 결과).
//   접수 행이 DB 에 저장되지 않은 접수(opts.d 없음)는 기록을 생략한다. 기록 실패는 삼키고 접수번호만 로그에 남긴다.
//   구글챗 실패 알림은 접수 직후 자동 발송에만 보낸다 — 관리자가 누른 발송은 화면에 결과가 나온다.
// 받는 주소는 Cloudflare 비밀값 INQUIRY_NOTIFY_TO — cloudflare:workers 의 env 에서만 읽는다(mail-send.ts 와 같은 방식).
//   ⚠️ 빌드 환경 변수 경로로 읽지 않는다(그 글자를 주석으로도 쓰지 않는다 — scripts/check-mail-guard.mjs).
// 원칙: 예외를 밖으로 던지지 않는다 — 접수 응답·확인 메일·구글챗에 영향이 없다.
//       로그에는 태그·접수번호·결과 사유만(주소·본문·고객 정보 금지).
import { env as cfEnv } from 'cloudflare:workers';
import type { D1 } from './db';
import { nowIso } from './db';
import { sendMail, MAIL_LIVE } from './mail-send';
import { sendChat } from './chat-send';
import { isSafeAddress } from './mail-mime.js';
import { staffSubject, staffText, staffHtml, STAFF_FROM_NAME } from './staff-notify.js';
import { staffNotifyRecorded } from './staff-notify-record.js';

const TAG = 'staff-mail';

function notifyTo(): string {
  const raw = (cfEnv as Record<string, unknown> | undefined)?.INQUIRY_NOTIFY_TO ?? '';
  // 대시보드 입력칸에 개행·따옴표가 섞여 들어올 수 있어 정리한다(mail-send.ts 의 secret 과 같게).
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
}

/** 받는 주소가 설정돼 있는가 — 관리자 화면 상태 줄용. 값은 내보내지 않는다(설정 여부만). */
export function staffNotifyConfigured(): boolean {
  return notifyTo() !== '';
}

export type StaffNotifyInput = Parameters<typeof staffText>[0];
export type StaffNotifyResult = { sent: boolean; reason: string; status: 'sent' | 'failed' | 'skipped' };
/**
 * d = 접수 행이 저장된 DB(없으면 기록 생략) · by = 'auto'(접수 직후 · 기본) | 'admin'(관리자가 누름)
 * prev = 이 접수의 이전 기록(inquiries.staff_mail — 방금 접수한 건은 없다)
 */
export type StaffNotifyOpts = { d?: D1 | null; by?: 'auto' | 'admin'; prev?: unknown };

/** 담당자 알림 한 통(접수 한 건). 결과를 기록하고 사유를 돌려준다. 예외를 던지지 않는다. */
export async function runStaffNotify(p: StaffNotifyInput, opts: StaffNotifyOpts = {}): Promise<StaffNotifyResult> {
  const d = opts.d ?? null;
  const by = opts.by === 'admin' ? 'admin' : 'auto';
  let r: StaffNotifyResult;
  try {
    r = await staffNotifyRecorded({
      by,
      prev: opts.prev ?? null,
      now: nowIso,
      write: d
        ? async (json: string) => {
            try {
              await d.prepare(`UPDATE inquiries SET staff_mail = ? WHERE id = ?`).bind(json, p.id).run();
            } catch (e) {
              console.warn(`[${TAG}] 결과 기록 실패:`, p.id, (e as Error)?.name ?? 'Error');
            }
          }
        : null,
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
      // 메일 오류 알림은 별도 채팅방(alert 채널)으로 — 없거나 실패하면 기존 채팅방(chat-send.ts)
      alert: (text: string) => sendChat(text, { tag: TAG, ref: p.id, channel: 'alert' }),
    });
  } catch {
    r = { sent: false, reason: 'error', status: 'failed' };
  }
  console.log(`[${TAG}] ${p.id} ${r.reason}${by === 'admin' ? ' (admin)' : ''}`);
  return r;
}
