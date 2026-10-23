// PayPal 결제 캡처(확정) — 성공 시 D1 에 결제 기록 + 구글챗 알림.
// 순서: ref 형식 → 사전 확인(precheckCapture — 이미 결제됨·오래된 결제창·결제 불가면 캡처하지 않는다)
//       → 캡처 → settlePayment(대조·확정·알림).
// 본문: { orderID, ref } — ref 는 화면의 주문/견적 번호. 없거나 형식이 틀리면 캡처하지 않고 400(옛 화면이 캐시된 경우도 돈이 빠지지 않는다).
import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { rateLimit, tooMany } from '../../../lib/rate-limit';
import { ppCapture } from '../../../lib/paypal';
import { settlePayment, precheckCapture, isOrdRef, isInqRef } from '../../../lib/paypal-settle';

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
  const reqRef = typeof body.ref === 'string' ? body.ref.trim().toUpperCase() : '';
  if (!isOrdRef(reqRef) && !isInqRef(reqRef)) return json({ ok: false, error: 'bad_request' }, 400);

  try {
    // 돈을 가져오기 전에 확인 — 여기서 막힌 건은 캡처하지 않으므로 고객 돈이 빠지지 않는다.
    //   already_paid: 이미 결제된 주문(다른 창에서 결제 끝남) · stale_order: 다른 창에서 새 결제창이 만들어짐 → 새로고침 안내
    //   not_payable: 주문이 없거나 결제할 수 있는 상태가 아님
    const pre = await precheckCapture(d, { ref: reqRef, ppOrderId: orderID });
    if (!pre.ok) {
      console.warn('[paypal] 캡처 전 확인에서 멈춤:', pre.code, pre.ref, orderID);
      return json({ ok: false, error: pre.code }, 409);
    }

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
    // ⚠️ 10-12: 주문(order) 상태가 COMPLETED 여도 캡처(실제 돈) 상태는 PENDING·DECLINED 일 수 있다(PayPal 문서).
    //    캡처가 COMPLETED 일 때만 결제 완료로 기록한다. PENDING 은 PayPal 이 확정을 미룬 것 —
    //    나중에 웹훅(PAYMENT.CAPTURE.COMPLETED)이 확정한다. 화면은 '재결제 금지' 안내를 띄운다(이중 청구 방지).
    const capStatus = String(capture.status ?? '');
    if (capStatus && capStatus !== 'COMPLETED') {
      console.warn('[paypal] 캡처 미완료:', capStatus, String(capture.custom_id ?? pu.reference_id ?? ''));
      if (capStatus === 'PENDING') return json({ ok: false, error: 'capture_pending' }, 409);
      return json({ ok: false, error: 'declined', restart: true }, 402);
    }
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
      // duplicate_payment = 이미 결제된 주문에 이 결제가 또 들어옴(돈은 빠졌다) → 화면은 held 와 같이 '재결제 금지' 안내
      const code = r.code === 'not_found' ? 404 : r.code === 'bad_ref' ? 500 : 409;
      return json({ ok: false, error: r.code === 'bad_ref' ? 'ref_missing' : r.code }, code);
    }
    return json({ ok: true, ref: r.ref, paidUsd: r.paidUsd, duplicate: r.duplicate });
  } catch (e) {
    console.error('[paypal] capture 실패:', e);
    return json({ ok: false, error: 'paypal_error' }, 502);
  }
};
