// 고객 메일 발송의 유일한 통로 — Gmail API 로 hello@vanam.co.kr 계정에서 보낸다.
//
// 비용: 회사가 이미 쓰는 Google Workspace 계정으로 보내므로 추가 비용이 없다(하루 2,000통 한도 — 충분).
// 보낸 메일은 hello@ 의 '보낸편지함'에 남고, 고객이 답장하면 hello@ 로 온다.
//
// 운영/테스트는 빌드가 정한다(src/lib/mail-mode.js · astro.config.mjs 의 define).
//   Cloudflare main 빌드만 고객 주소로 보낸다. 맥미니·로컬·기타 빌드는 @vanam.co.kr 주소로만 보내고,
//   그 밖의 주소는 여기서 fetch 자체를 하지 않는다 — Gmail 비밀값이 설정돼 있어도 마찬가지다.
//   운영 빌드도 운영 주소(vanam.co.kr)로 들어온 요청에서만 보낸다(운영 결과물을 다른 곳에서 띄운 경우 차단).
// 받는 사람은 이 파일이 원문(MIME)을 직접 조립해 넣는다 — 호출부가 만든 원문을 받으면 막은 주소가 원문에 섞여 나갈 수 있다.
//
// 비밀값(GMAIL_CLIENT_ID · GMAIL_CLIENT_SECRET · GMAIL_REFRESH_TOKEN)은 cloudflare:workers 의 env 에서만 읽는다.
//   빌드 환경 변수(import.meta 쪽)로 읽으면 빌드 때 .env 값이 번들에 문자열로 박힌다(구글챗 사고와 같은 길).
//   ⚠️ 이 파일에는 그 문자열(import.meta 다음 env)을 주석으로도 쓰지 않는다 — Astro 가 원문에서 그 글자를 찾으면
//      이 파일이 이름을 부르는 .env 키 값을 번들에 넣을 준비를 한다(scripts/check-mail-guard.mjs 가 막는다).
//   새로고침 토큰은 hello@ 가 'gmail.send'(보내기 전용) 권한만 승인한 것 — 메일함을 읽을 수 없다.
//   ⚠️ hello@ 의 비밀번호를 바꾸면 Google 이 이 토큰을 없앤다 → 'auth_failed'. 권한을 다시 승인해 새 토큰을 넣는다.
// ⚠️ 로그에 받는 주소·본문을 남기지 않는다 — 접수번호와 결과만.
import { env as cfEnv } from 'cloudflare:workers';
import company from '../data/company.json';
import { buildMime, isSafeAddress } from './mail-mime.js';
import { mailAllowed, hostAllowed } from './quote-ack.js';

declare const __VANAM_MAIL_MODE__: string;

// 비교 대상 문자열을 여기 적지 않는다: 번들 안에 표식이 정확히 하나(빌드가 넣은 값)만
// 남아야 게이트(scripts/check-mail-guard.mjs)가 이 빌드의 운영/테스트를 읽을 수 있다.
/** 운영 빌드(고객 주소로 발송)인가 */
export const MAIL_LIVE: boolean = __VANAM_MAIL_MODE__.endsWith('_LIVE');

/** 보내는 주소 — company.json 의 대표 메일(= 권한을 승인한 Google 계정) */
export const MAIL_FROM: string = String(company.email ?? '');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';

export type MailReason =
  | 'ok' | 'blocked_build' | 'blocked_host' | 'bad_recipient' | 'no_credentials'
  | 'auth_failed' | 'http_error' | 'fetch_error' | 'error';
export type MailResult = { sent: boolean; reason: MailReason; status?: number };

export type MailMessage = {
  to: string;
  fromName: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; contentType: string; bytes: Uint8Array }[];
};

function secret(k: string): string {
  const raw = (cfEnv as Record<string, unknown> | undefined)?.[k] ?? '';
  // 대시보드 입력칸에 개행·따옴표가 섞여 들어올 수 있어 정리한다.
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
}

/** Gmail 비밀값 세 개가 다 있는가 (값은 돌려주지 않는다) */
export function gmailConfigured(): boolean {
  return Boolean(secret('GMAIL_CLIENT_ID') && secret('GMAIL_CLIENT_SECRET') && secret('GMAIL_REFRESH_TOKEN'));
}

/** 남은 시간 안의 제한 시간(ms) — 상한과 마감 중 짧은 쪽 */
const within = (cap: number, deadline: number) => Math.max(1000, Math.min(cap, deadline - Date.now()));

// 접근 토큰(1시간짜리) — 워커 인스턴스가 살아 있는 동안 다시 쓴다. 만료 1분 전에 새로 받는다.
let cached: { token: string; until: number } | null = null;

type TokenResult = { ok: true; token: string } | { ok: false; reason: 'auth_failed' | 'fetch_error'; status?: number };

async function accessToken(deadline: number, fresh = false): Promise<TokenResult> {
  if (!fresh && cached && cached.until > Date.now()) return { ok: true, token: cached.token };
  cached = null;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: secret('GMAIL_CLIENT_ID'),
        client_secret: secret('GMAIL_CLIENT_SECRET'),
        refresh_token: secret('GMAIL_REFRESH_TOKEN'),
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(within(8000, deadline)),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
    if (!res.ok || typeof j.access_token !== 'string' || !j.access_token) {
      // 오류 코드(invalid_grant 등)만 남긴다 — 응답 본문 전체는 남기지 않는다.
      console.error('[mail] 접근 토큰 실패:', res.status, typeof j.error === 'string' ? j.error : '');
      return { ok: false, reason: 'auth_failed', status: res.status };
    }
    const life = Math.max(120, Math.min(3600, Number(j.expires_in) || 3600));
    cached = { token: j.access_token, until: Date.now() + (life - 60) * 1000 };
    return { ok: true, token: j.access_token };
  } catch (e) {
    console.error('[mail] 접근 토큰 연결 오류:', (e as Error)?.name ?? 'Error');
    return { ok: false, reason: 'fetch_error' };
  }
}

/**
 * 메일 한 통 보내기.
 * @param m 받는 사람·제목·본문·첨부 — 원문(MIME)은 여기서 조립한다(받는 사람은 m.to 하나뿐)
 * @param opts.tag 로그 구분 · opts.ref 접수번호(진단용, PII 아님)
 *             opts.origin 요청이 들어온 주소(운영 빌드는 vanam.co.kr 만) · opts.deadline 이 시각(ms)까지 끝낸다
 */
export async function sendMail(
  m: MailMessage,
  opts: { tag: string; ref?: string; origin: string; deadline?: number },
): Promise<MailResult> {
  const { tag, ref } = opts;
  const deadline = opts.deadline ?? Date.now() + 20000;
  const allowed = mailAllowed(MAIL_LIVE, m.to, isSafeAddress);
  if (!allowed.ok) {
    console.warn(`[mail-${allowed.reason}] ${tag} ${ref ?? ''}`);
    return { sent: false, reason: allowed.reason };
  }
  if (!hostAllowed(MAIL_LIVE, opts.origin)) {
    console.warn(`[mail-blocked_host] ${tag} ${ref ?? ''}`);
    return { sent: false, reason: 'blocked_host' };
  }
  if (!gmailConfigured() || !isSafeAddress(MAIL_FROM)) {
    console.warn(`[${tag}] Gmail 설정 없음 — 메일을 건너뜁니다.`, ref ?? '');
    return { sent: false, reason: 'no_credentials' };
  }

  let mime: string;
  try {
    mime = buildMime({
      from: { name: m.fromName, address: MAIL_FROM }, to: m.to,
      subject: m.subject, text: m.text, html: m.html, attachments: m.attachments,
    });
  } catch (e) {
    const msg = (e as Error)?.message;
    if (msg === 'bad_recipient' || msg === 'bad_sender') return { sent: false, reason: 'bad_recipient' };
    console.error(`[${tag}] 원문 만들기 오류:`, (e as Error)?.name ?? 'Error', ref ?? '');
    return { sent: false, reason: 'error' };
  }

  // 접근 토큰이 중간에 무효가 되면(401) 새로 받아 한 번만 다시 보낸다(시간이 남았을 때만).
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await accessToken(deadline, attempt > 0);
    if (!t.ok) return { sent: false, reason: t.reason, status: t.status };
    try {
      const res = await fetch(SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'message/rfc822' },
        body: mime,
        signal: AbortSignal.timeout(within(10000, deadline)),
      });
      if (res.status === 401 && attempt === 0 && deadline - Date.now() > 4000) {
        cached = null;
        continue;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { status?: unknown } };
        console.error(`[${tag}] Gmail 발송 실패:`, res.status, typeof j.error?.status === 'string' ? j.error.status : '', ref ?? '');
        // 403 은 'Gmail API 사용 안 함'·권한 범위 부족 등 여러 가지라 상태 코드와 함께 http_error 로 둔다.
        return { sent: false, reason: res.status === 401 ? 'auth_failed' : 'http_error', status: res.status };
      }
      return { sent: true, reason: 'ok', status: res.status };
    } catch (e) {
      console.error(`[${tag}] Gmail 연결 오류:`, (e as Error)?.name ?? 'Error', ref ?? '');
      return { sent: false, reason: 'fetch_error' };
    }
  }
  return { sent: false, reason: 'auth_failed' };
}
