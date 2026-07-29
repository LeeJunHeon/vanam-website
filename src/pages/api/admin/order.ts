// 관리자 주문 관리 — 진행 상태(제작·발송·완료·취소)만 다룬다.
//
// ⚠️ 결제 상태(pending → paid)는 여기서 바꾸지 않는다.
//    결제 여부를 결정하는 곳은 PayPal(캡처·웹훅) 하나뿐이며, 관리자가 손으로 paid 로 바꾸면
//    ① 돈이 안 들어왔는데 결제 완료로 보이고
//    ② paid_usd 없이 paid_at 만 있는 모순된 데이터가 생기며
//    ③ 멱등 판정이 paid_at 을 보므로, 나중에 진짜 결제가 들어와도 "이미 처리됨"으로 건너뛴다.
//    국내 계좌이체 입금 확인은 별도 액션(confirmDeposit)으로 처리한다.
import type { APIRoute } from 'astro';
import { db, nowIso } from '../../../lib/db';
import { ppRefund, notifyChat } from '../../../lib/paypal';
import { isAdmin } from '../../../lib/admin-auth';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

// 관리자가 직접 지정할 수 있는 진행 상태.
// 'paid' 는 결제 경로(캡처·웹훅)만 기록한다 — 목록에서 의도적으로 제외했다.
// 'refunded' 는 환불 API 가 성공했을 때만 기록한다.
const STATUSES = ['preparing', 'shipped', 'done', 'cancelled'] as const;
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

  const action = str(body.action);

  // ── 국내 계좌이체 입금 확인 ──
  // PayPal 을 쓸 수 없는 국내 주문만 해당한다. 결제 경로가 없으므로 사람이 확인해 기록한다.
  // 이미 결제된 건은 절대 덮어쓰지 않는다(AND paid_at IS NULL).
  if (action === 'confirmDeposit') {
    const now2 = nowIso();
    const row = await d.prepare(`SELECT paid_at, amount FROM orders WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    if (!row) return json({ ok: false, error: 'not_found' }, 404);
    if (row.paid_at) return json({ ok: false, error: 'already_paid' }, 409);
    await d
      .prepare(`UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND paid_at IS NULL`)
      .bind(now2, now2, id)
      .run();
    await notifyChat(`🏦 [입금 확인] ${id} — ₩${Number(row.amount ?? 0).toLocaleString('ko-KR')} (관리자 수동 확인)`);
    return json({ ok: true, status: 'paid' });
  }

  // ── PayPal 환불 ──
  // 실제로 돈이 나가는 동작이므로, 캡처 ID 가 있는 건(=PayPal 로 결제된 건)만 허용한다.
  if (action === 'refund') {
    const row = await d
      .prepare(`SELECT paid_at, paid_usd, paypal_capture_id, status FROM orders WHERE id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) return json({ ok: false, error: 'not_found' }, 404);
    if (!row.paid_at) return json({ ok: false, error: 'not_paid' }, 409);
    if (String(row.status) === 'refunded') return json({ ok: false, error: 'already_refunded' }, 409);
    const capId = String(row.paypal_capture_id ?? '');
    if (!capId) return json({ ok: false, error: 'no_capture_id' }, 409);

    const { httpOk, body: rb } = await ppRefund(capId);
    if (!httpOk) {
      const detail = JSON.stringify(rb).slice(0, 300);
      console.error('[admin] 환불 실패:', id, detail);
      return json({ ok: false, error: 'refund_failed', detail }, 502);
    }
    const now2 = nowIso();
    await d
      .prepare(`UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?`)
      .bind(now2, id)
      .run();
    await notifyChat(`↩️ [환불 완료] ${id} — $${Number(row.paid_usd ?? 0).toFixed(2)} USD (관리자 처리)`);
    return json({ ok: true, status: 'refunded' });
  }

  let status = str(body.status) as Status;
  if (!STATUSES.includes(status)) return json({ ok: false, error: 'bad_status' }, 400);

  // 송장번호를 새로 넣었는데 상태가 아직 '제작 중'이면 '발송 완료'로 올린다.
  // 실무에서 송장 입력 = 발송이므로, 상태를 따로 바꾸는 것을 잊기 쉽다.
  if (trackingNo && status === 'preparing') status = 'shipped';

  let trackingNo = str(body.trackingNo).slice(0, 60);
  const trackingCourier = str(body.trackingCourier).slice(0, 40);
  const adminMemo = str(body.adminMemo).slice(0, 2000);
  const now = nowIso();

  try {
    await d
      .prepare(
        `UPDATE orders
            SET status = ?,
                tracking_no = ?,
                tracking_courier = ?,
                admin_memo = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(status, trackingNo || null, trackingCourier || null, adminMemo || null, now, id)
      .run();
  } catch (e) {
    console.error('[admin/order] 갱신 실패:', e);
    return json({ ok: false, error: 'db_error' }, 500);
  }

  return json({ ok: true, id, status, updatedAt: now });
};
