// 관리자 주문 관리.
// 결제 연동 전에도 "입금 확인 → 제작 → 발송 → 완료" 흐름을 수동으로 굴릴 수 있게 한다.
// (무통장입금으로 시작하더라도 이 화면 하나로 운영이 된다)
import type { APIRoute } from 'astro';
import { db, nowIso } from '../../../lib/db';
import { isAdmin } from '../../../lib/admin-auth';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// 주문 상태. 결제 연동 후에도 그대로 쓴다.
const STATUSES = ['pending', 'paid', 'preparing', 'shipped', 'done', 'cancelled', 'refunded'] as const;
type Status = (typeof STATUSES)[number];

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export const POST: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  const id = str(body.id).toUpperCase();
  if (!/^ORD-\d{8}-[A-Z0-9]{4}$/.test(id)) return json({ ok: false, error: 'bad_id' }, 400);

  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  const status = str(body.status) as Status;
  if (!STATUSES.includes(status)) return json({ ok: false, error: 'bad_status' }, 400);

  const trackingNo = str(body.trackingNo).slice(0, 60);
  const trackingCourier = str(body.trackingCourier).slice(0, 40);
  const adminMemo = str(body.adminMemo).slice(0, 2000);
  const now = nowIso();

  // 결제 완료로 바꾸는 순간 결제 시각을 남긴다 (무통장입금은 관리자가 통장 확인 후 누른다)
  const markPaid = status === 'paid' || status === 'preparing' || status === 'shipped' || status === 'done';

  try {
    await d
      .prepare(
        `UPDATE orders
            SET status = ?,
                tracking_no = ?,
                tracking_courier = ?,
                admin_memo = ?,
                paid_at = CASE WHEN paid_at IS NULL AND ? = 1 THEN ? ELSE paid_at END,
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(status, trackingNo || null, trackingCourier || null, adminMemo || null, markPaid ? 1 : 0, now, now, id)
      .run();
  } catch (e) {
    console.error('[admin/order] 갱신 실패:', e);
    return json({ ok: false, error: 'db_error' }, 500);
  }

  return json({ ok: true, id, status, updatedAt: now });
};
