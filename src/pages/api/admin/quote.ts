// 관리자용: 견적 금액 책정 · 상태 변경
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db, nowIso } from '../../../lib/db';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// 관리자가 직접 지정할 수 있는 상태.
// 'paid' 는 결제 경로(캡처·웹훅)만 기록한다 — 손으로 바꾸면 결제 사실과 어긋난다.
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

  // 통화 — KRW/USD 만 허용 (기본 KRW)
  const currency = body.currency === 'USD' ? 'USD' : 'KRW';

  const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';
  // 상태는 클라이언트가 정하지 않는다. 금액 책정 여부로 서버가 판단한다.
  // (드롭다운으로 임의 변경하면 결제 버튼이 사라지는 등 사고가 난다)
  let status: string | null = null;
  // 이미 결제된 견적은 상태를 되돌리지 않는다(결제 사실이 최우선).
  const cur = await d
    .prepare(`SELECT status, paid_at FROM inquiries WHERE id = ?`)
    .bind(id)
    .first<{ status: string; paid_at: string | null }>();
  if (cur?.paid_at) return json({ ok: false, error: 'already_paid' }, 409);

  // 금액이 있으면 '견적 발송', 없으면 기존 상태를 유지한다.
  status = amount != null && amount > 0 ? 'quoted' : (cur?.status ?? 'new');

  if (!status) return json({ ok: false, error: 'bad_status' }, 400);

  try {
    await d
      .prepare(
        `UPDATE inquiries
            SET quoted_amount = ?, quote_currency = ?, quote_note = ?, status = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(amount, currency, note || null, status, nowIso(), id)
      .run();
    return json({ ok: true, id, amount, status });
  } catch (e) {
    console.error('[admin/quote] 저장 실패:', e);
    return json({ ok: false, error: 'db_error' }, 500);
  }
};
