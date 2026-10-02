// 관리자: 견적 요청 접수 확인 메일 다시 보내기 (실패했거나 고객이 못 받았다고 할 때)
//
// 내용은 접수 때와 같다(src/lib/quote-ack-run.ts) — 견적 요청서 PDF, 예상 견적이면 예상 견적서도.
// 테스트 빌드에서는 @vanam.co.kr 주소로만 나간다(mail-send.ts 가 막는다).
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db } from '../../../lib/db';
import { runQuoteAck } from '../../../lib/quote-ack-run';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);

  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!/^INQ-\d{8}-[A-Z0-9]{4}$/.test(id)) return json({ ok: false, error: 'bad_id' }, 400);

  const r = await runQuoteAck(d, id, { by: 'admin', origin: new URL(request.url).origin });
  if (r.reason === 'no_inquiry') return json({ ok: false, error: 'not_found' }, 404);
  if (r.reason === 'not_quote') return json({ ok: false, error: 'not_quote' }, 400);
  // 접수 직후 자동 발송이 아직 도는 중 — 두 번 보내지 않는다(2분 뒤에도 그대로면 '중단됨'으로 보이고 다시 보낼 수 있다)
  if (r.reason === 'in_progress') return json({ ok: false, error: 'in_progress' }, 409);
  return json({ ok: r.status === 'sent', result: r });
};
