// 관리자용: 견적 금액 책정 · 상태 변경
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db, nowIso } from '../../../lib/db';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const STATUSES = ['new', 'quoted', 'replied', 'closed'];

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

  // 금액: 빈 값이면 null(미책정), 아니면 0 이상의 정수
  let amount: number | null = null;
  if (body.amount !== '' && body.amount != null) {
    const n = Number(body.amount);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) {
      return json({ ok: false, error: 'bad_amount' }, 400);
    }
    amount = n;
  }

  const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';
  const status = typeof body.status === 'string' && STATUSES.includes(body.status) ? body.status : null;
  if (!status) return json({ ok: false, error: 'bad_status' }, 400);

  try {
    await d
      .prepare(
        `UPDATE inquiries
            SET quoted_amount = ?, quote_note = ?, status = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(amount, note || null, status, nowIso(), id)
      .run();
    return json({ ok: true, id, amount, status });
  } catch (e) {
    console.error('[admin/quote] 저장 실패:', e);
    return json({ ok: false, error: 'db_error' }, 500);
  }
};
