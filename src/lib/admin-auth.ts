// /admin 접근 인증.
//
// ⚠️ 지금은 비밀번호 + HMAC 서명 쿠키 방식이다.
//    도메인(vanam.co.kr)이 붙으면 Cloudflare Access(구글 로그인, 무료)로 전환하는 것이 낫다.
//    workers.dev 임시 주소에는 Access를 걸 수 없어서 임시로 자체 인증을 쓴다.
//
// Cloudflare 워커 Settings → Variables and secrets 에 등록하는 값:
//   ADMIN_PASSWORD  (Secret) — 로그인 비밀번호. 16자 이상 권장.
//   SESSION_SECRET  (Secret) — 세션 쿠키 서명 키. 랜덤 32바이트.
//                              생성: openssl rand -base64 32
//
// ⚠️ 왜 세션 서명 키를 비밀번호와 분리하는가 (중요):
//   예전에는 세션 쿠키를 ADMIN_PASSWORD 로 HMAC 서명했다. 그런데 쿠키의 만료시각은
//   평문이라, 쿠키가 한 번 유출되면 공격자가 오프라인에서
//   HMAC(추측_비밀번호, 만료시각) == 서명 을 만족하는 비밀번호를 찾을 수 있었다.
//   서버에 로그인 시도를 한 번도 안 하므로 레이트리밋도 지연도 소용이 없다.
//   (8자 비밀번호면 GPU로 몇 시간. 실측으로 4ms 만에 후보 복구 확인.)
//   서명 키를 랜덤 SESSION_SECRET 으로 분리하면, 비밀번호를 복구하려면
//   먼저 2^256 짜리 SESSION_SECRET 을 뚫어야 하므로 불가능해진다.
import { env as cfEnv } from 'cloudflare:workers';

const COOKIE = 'vanam_admin';
const TTL_MS = 12 * 60 * 60 * 1000; // 12시간

function readEnv(name: string): string {
  const raw =
    (cfEnv as Record<string, unknown> | undefined)?.[name] ??
    (import.meta.env as Record<string, unknown>)[name] ??
    '';
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
}

/** 로그인 비밀번호 */
function secret(): string {
  return readEnv('ADMIN_PASSWORD');
}

/** 세션 쿠키 서명 키 — 비밀번호와 반드시 분리한다.
 *  SESSION_SECRET 이 없으면 ADMIN_PASSWORD 로 폴백하되, 취약하므로 경고를 남긴다.
 *  (미설정 시 관리자가 잠기는 것보다 폴백+경고가 운영상 안전) */
function signingKey(): string {
  const dedicated = readEnv('SESSION_SECRET');
  if (dedicated.length >= 16) return dedicated;
  const pw = secret();
  if (pw) {
    console.warn(
      '[admin-auth] SESSION_SECRET 미설정 — ADMIN_PASSWORD 로 폴백합니다. ' +
        '쿠키 유출 시 오프라인 대입에 취약하므로, openssl rand -base64 32 로 생성해 등록하세요.',
    );
  }
  return pw;
}

export const adminConfigured = () => secret().length >= 8;

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey()), // ← 비밀번호가 아니라 전용 서명 키
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
}

/** 로그인 성공 시 심을 쿠키 문자열 */
export async function makeSessionCookie(): Promise<string> {
  const exp = String(Date.now() + TTL_MS);
  const value = `${exp}.${await sign(exp)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL_MS / 1000}`;
}

export const clearSessionCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** 요청이 인증된 관리자인지 */
export async function isAdmin(request: Request): Promise<boolean> {
  if (!adminConfigured()) return false;

  const raw = request.headers.get('cookie') ?? '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;

  const [exp, sig] = m[1].split('.');
  if (!exp || !sig) return false;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;

  const expected = await sign(exp);
  // 길이가 같을 때만 비교 (타이밍 차이 최소화)
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** 입력한 비밀번호가 맞는지 */
export async function checkPassword(input: string): Promise<boolean> {
  const s = secret();
  if (!s || typeof input !== 'string') return false;
  const a = new TextEncoder().encode(s);
  const b = new TextEncoder().encode(input);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
