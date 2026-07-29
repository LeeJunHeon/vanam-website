// PayPal 결제 캡처(확정) — 성공 시 D1 에 결제 기록 + 구글챗 알림.
import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { rateLimit, tooMany } from '../../../lib/rate-limit';
import { ppCapture } from '../../../lib/paypal';
import { settlePayment, isOrdRef, isInqRef } from '../../../lib/paypal-settle';

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
    if (!isOrdRef(ref) && !isInqRef(ref)) return json({ ok: false, error: 'ref_missing' }, 500);

    // 검증·DB반영·알림은 공용 모듈이 담당한다(웹훅 경로와 완전히 동일한 검증).
    const r = await settlePayment(d, {
      ref,
      ppOrderId: orderID,
      paidUsd,
      paidCur,
      source: 'browser',
      captureId: String(capture?.id ?? '') || undefined,
    });
    if (!r.ok) {
      const code = r.code === 'not_found' ? 404 : r.code === 'bad_ref' ? 500 : 409;
      return json({ ok: false, error: r.code === 'bad_ref' ? 'ref_missing' : r.code }, code);
    }
    return json({ ok: true, ref: r.ref, paidUsd: r.paidUsd, duplicate: r.duplicate });
  } catch (e) {
    console.error('[paypal] capture 실패:', e);
    return json({ ok: false, error: 'paypal_error' }, 502);
  }
};
