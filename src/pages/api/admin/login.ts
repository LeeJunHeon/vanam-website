// 관리자 로그인 · 로그아웃.
//
// 10-13 정리(로그인 버튼을 눌러도 '바로 안 된다'는 현상):
//   · 횟수 제한은 '틀린 비밀번호'만 센다(IP당 15분에 5번). 예전에는 성공한 로그인도 세서, 사무실(같은 IP)에서
//     여러 번 들어가거나 응답을 기다리다 다시 누르면 맞는 비밀번호로도 막혔고, 화면에는 '비밀번호가 맞지 않습니다'가 떴다.
//   · 두 가지 요청을 받는다.
//       JSON(fetch)      → JSON 응답(화면 스크립트가 문구를 띄운다)
//       폼 제출(스크립트가 아직 안 붙었을 때 누른 경우) → 303 으로 /admin 에 돌려보낸다(성공이면 쿠키와 함께, 실패면 ?login=사유)
//     예전에는 스크립트가 붙기 전에 누르면 폼이 /admin 으로 제출돼 아무 일도 없던 것처럼 보였다.
import type { APIRoute } from 'astro';
import { checkPassword, makeSessionCookie, clearSessionCookie, adminConfigured } from '../../../lib/admin-auth';
import { db } from '../../../lib/db';
import { rateCheck, rateLimit } from '../../../lib/rate-limit';

export const prerender = false;

const jsonRes = (b: unknown, s: number, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
/** 폼 제출이면 /admin 으로 돌려보낸다(303 — 새로고침해도 다시 제출되지 않는다) */
const back = (reason: string | null, extra: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { Location: reason ? `/admin?login=${reason}` : '/admin', 'Cache-Control': 'no-store', ...extra } });

export const POST: APIRoute = async ({ request }) => {
  const ct = (request.headers.get('content-type') ?? '').toLowerCase();
  const isForm = ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data');

  if (!adminConfigured()) return isForm ? back('not_configured') : jsonRes({ ok: false, error: 'not_configured' }, 503);

  // 무차별 대입 차단: 틀린 시도가 IP당 15분에 5번을 넘으면 막는다(맞는 비밀번호여도 그 동안은 막힌다 — 대입 방어).
  const d = await db();
  const rc = await rateCheck(d, 'login', request);
  if (!rc.ok) {
    return isForm ? back('limited') : jsonRes({ ok: false, error: 'rate_limited', retryAfterSec: rc.retryAfterSec }, 429, { 'Retry-After': String(rc.retryAfterSec) });
  }

  let password = '';
  try {
    if (isForm) {
      const v = (await request.formData()).get('password');
      password = typeof v === 'string' ? v : '';
    } else {
      const body = (await request.json()) as Record<string, unknown>;
      password = typeof body.password === 'string' ? body.password : '';
    }
  } catch {
    return isForm ? back('bad') : jsonRes({ ok: false, error: 'bad_request' }, 400);
  }
  // 빈 값은 시도로 세지 않는다(자동 입력이 아직 채워지지 않은 채 눌린 경우 등)
  if (!password) return isForm ? back('empty') : jsonRes({ ok: false, error: 'empty' }, 400);

  if (!(await checkPassword(password))) {
    await rateLimit(d, 'login', request); // 틀린 시도만 센다
    await new Promise((r) => setTimeout(r, 700)); // 무차별 대입을 조금이라도 늦춘다
    return isForm ? back('invalid') : jsonRes({ ok: false, error: 'invalid' }, 401);
  }

  const cookie = await makeSessionCookie();
  return isForm ? back(null, { 'Set-Cookie': cookie }) : jsonRes({ ok: true }, 200, { 'Set-Cookie': cookie });
};

// 로그아웃
export const DELETE: APIRoute = async () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() },
  });
