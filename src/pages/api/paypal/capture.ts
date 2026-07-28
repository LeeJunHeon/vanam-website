// PayPal 결제 캡처(확정) — 성공 시 D1 에 결제 기록 + 구글챗 알림.
import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { rateLimit, tooMany } from '../../../lib/rate-limit';
import { ppCapture, notifyChat, expectedUsdStr, toCents } from '../../../lib/paypal';

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
    const paidCur = String(capture?.amount?.currency_code ?? '');
    const isOrd = /^ORD-\d{8}-[A-Z0-9]{4}$/.test(ref);
    const isInq = /^INQ-\d{8}-[A-Z0-9]{4}$/.test(ref);
    if (!isOrd && !isInq) return json({ ok: false, error: 'ref_missing' }, 500);

    // ── 결제 검증 ──
    // PayPal 응답의 금액을 그대로 신뢰하지 않는다. 서버가 DB 에서 다시 계산한 값과 대조해
    // ①우리가 만든 주문인지 ②통화 ③금액 이 모두 맞을 때만 결제로 인정한다.
    const table = isInq ? 'inquiries' : 'orders';
    const row = await d
      .prepare(`SELECT * FROM ${table} WHERE id = ?`)
      .bind(ref)
      .first<Record<string, unknown>>();
    if (!row) {
      console.error('[paypal] 캡처 대상 없음:', ref, orderID);
      await notifyChat(`🚨 [PayPal 검증실패] ${ref} — 주문/견적 없음 (paypal: ${orderID}) · 수동 확인 필요`);
      return json({ ok: false, error: 'not_found' }, 404);
    }

    // 멱등: 이미 결제된 건은 DB 를 다시 쓰지 않고 알림도 재발송하지 않는다(중복 캡처 방어)
    if (row.paid_at) {
      return json({ ok: true, ref, paidUsd: Number(row.paid_usd ?? paidUsd), duplicate: true });
    }

    const bad: string[] = [];
    const savedPp = String(row.paypal_order_id ?? '');
    if (!savedPp || savedPp !== orderID) bad.push(`order_id(db=${savedPp || 'none'} req=${orderID})`);
    if (paidCur !== 'USD') bad.push(`currency=${paidCur || 'none'}`);
    const exp = expectedUsdStr(isInq ? 'inq' : 'ord', row);
    if (!exp) bad.push('amount_unavailable');
    else if (Math.abs(toCents(exp) - toCents(paidUsd)) > 1) bad.push(`amount(exp=${exp} paid=${paidUsd})`);

    if (bad.length) {
      // 돈은 이미 들어왔을 수 있으므로 자동 환불하지 않는다 — DB 는 건드리지 않고 사람이 확인한다.
      console.error('[paypal] 결제 검증 실패:', ref, bad.join(' / '));
      await notifyChat(`🚨 [PayPal 검증실패] ${ref} — ${bad.join(' / ')} · 자동 처리 중단, 수동 확인 필요`);
      return json({ ok: false, error: 'verify_failed' }, 409);
    }

    const now = new Date().toISOString();
    if (isInq) {
      await d
        .prepare(`UPDATE inquiries SET paid_at = COALESCE(paid_at, ?), paid_usd = ? WHERE id = ? AND paid_at IS NULL`)
        .bind(now, paidUsd, ref)
        .run();
    } else {
      await d
        .prepare(`UPDATE orders SET status = 'paid', paid_at = ?, paid_usd = ? WHERE id = ? AND paid_at IS NULL`)
        .bind(now, paidUsd, ref)
        .run();
    }

    await notifyChat(`💳 [PayPal 결제완료] ${ref} — $${paidUsd.toFixed(2)} USD (paypal: ${orderID})`);
    return json({ ok: true, ref, paidUsd });
  } catch (e) {
    console.error('[paypal] capture 실패:', e);
    return json({ ok: false, error: 'paypal_error' }, 502);
  }
};
