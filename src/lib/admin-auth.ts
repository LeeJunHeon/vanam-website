// /admin 접근 인증.
//
// ⚠️ 지금은 비밀번호 + HMAC 서명 쿠키 방식이다.
//    도메인(vanam.co.kr)이 붙으면 Cloudflare Access(구글 로그인, 무료)로 전환하는 것이 낫다.
//    workers.dev 임시 주소에는 Access를 걸 수 없어서 임시로 자체 인증을 쓴다.
//
// 비밀번호는 Cloudflare 워커 Settings → Variables and secrets 에
// ADMIN_PASSWORD (타입: Secret) 로 등록한다.
import { env as cfEnv } from 'cloudflare:workers';

const COOKIE = 'vanam_admin';
const TTL_MS = 12 * 60 * 60 * 1000; // 12시간

function secret(): string {
  const raw =
    (cfEnv as Record<string, unknown> | undefined)?.ADMIN_PASSWORD ??
    import.meta.env.ADMIN_PASSWORD ??
    '';
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
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
    new TextEncoder().encode(secret()),
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
