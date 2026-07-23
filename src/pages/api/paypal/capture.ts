// PayPal 결제 캡처(확정) — 성공 시 D1 에 결제 기록 + 구글챗 알림.
import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { rateLimit, tooMany } from '../../../lib/rate-limit';
import { ppCapture, notifyChat } from '../../../lib/paypal';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request }) => {
  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  const rl = await rateLimit(d, 'paypalCapture', request);
  if (!rl.ok) return tooMany(rl.retryAfterSec);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  const orderID = typeof body.orderID === 'string' ? body.orderID.trim() : '';
  if (!orderID || orderID.length > 64) return json({ ok: false, error: 'bad_request' }, 400);

  try {
    const { httpOk, body: cap } = await ppCapture(orderID);
    const status = String((cap as Record<string, unknown>).status ?? '');

    // 카드 거절 등 — 프론트가 결제 수단 재선택을 유도하도록 신호
    if (!httpOk) {
      const detail = JSON.stringify(cap).slice(0, 300);
      console.warn('[paypal] capture 거절/실패:', detail);
      const restart = detail.includes('INSTRUMENT_DECLINED');
      return json({ ok: false, error: restart ? 'declined' : 'capture_failed', restart }, 402);
    }
    if (status !== 'COMPLETED') return json({ ok: false, error: 'not_completed' }, 409);

    const pu = ((cap as Record<string, any>).purchase_units ?? [])[0] ?? {};
    const capture = ((pu.payments ?? {}).captures ?? [])[0] ?? {};
    const ref = String(capture.custom_id ?? pu.reference_id ?? '').toUpperCase();
    const paidUsd = Number(capture?.amount?.value ?? 0);
    const isOrd = /^ORD-\d{8}-[A-Z0-9]{4}$/.test(ref);
    const isInq = /^INQ-\d{8}-[A-Z0-9]{4}$/.test(ref);
    if (!isOrd && !isInq) return json({ ok: false, error: 'ref_missing' }, 500);

    const now = new Date().toISOString();
    if (isInq) {
      await d
        .prepare(`UPDATE inquiries SET paid_at = COALESCE(paid_at, ?), paypal_order_id = ? WHERE id = ?`)
        .bind(now, orderID, ref)
        .run();
    } else {
      await d
        .prepare(`UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), paid_usd = ?, paypal_order_id = ? WHERE id = ?`)
        .bind(now, paidUsd, orderID, ref)
        .run();
    }

    await notifyChat(`💳 [PayPal 결제완료] ${ref} — $${paidUsd.toFixed(2)} USD (paypal: ${orderID})`);
    return json({ ok: true, ref, paidUsd });
  } catch (e) {
    console.error('[paypal] capture 실패:', e);
    return json({ ok: false, error: 'paypal_error' }, 502);
  }
};
