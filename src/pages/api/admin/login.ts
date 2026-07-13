import type { APIRoute } from 'astro';
import { checkPassword, makeSessionCookie, clearSessionCookie, adminConfigured } from '../../../lib/admin-auth';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!adminConfigured()) {
    return new Response(JSON.stringify({ ok: false, error: 'not_configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let password = '';
  try {
    const body = (await request.json()) as Record<string, unknown>;
    password = typeof body.password === 'string' ? body.password : '';
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'bad_request' }), { status: 400 });
  }

  if (!(await checkPassword(password))) {
    // 무차별 대입을 조금이라도 늦춘다
    await new Promise((r) => setTimeout(r, 700));
    return new Response(JSON.stringify({ ok: false, error: 'invalid' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': await makeSessionCookie(),
    },
  });
};

// 로그아웃
export const DELETE: APIRoute = async () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() },
  });
