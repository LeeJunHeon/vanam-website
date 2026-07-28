// PayPal 웹훅 수신 — 브라우저를 거치지 않는 두 번째 확정 경로.
//
// 왜 필요한가: 기존에는 고객 브라우저가 /api/paypal/capture 를 호출해야만 주문이 확정됐다.
// 승인 직후 창을 닫거나 네트워크가 끊기면 "돈은 빠졌는데 주문은 pending" 상태로 남는다.
// PayPal 서버가 직접 우리 서버로 통보하는 이 경로는 브라우저와 무관하게 동작한다.
//
// 보안: 이 주소는 인터넷에 열려 있다. 서명 검증 없이는 누구나 "결제 완료" 를 위조해
// 무료로 주문을 확정시킬 수 있으므로, 검증 실패 시 즉시 폐기한다.
import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ppVerifyWebhook, ppCapture, notifyChat, paypalCfg } from '../../../lib/paypal';
import { settlePayment } from '../../../lib/paypal-settle';

export const prerender = false;

const ok = (b: unknown = { ok: true }, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

/** 캡처 응답/이벤트 자원에서 주문번호·금액을 꺼낸다. */
const pickCapture = (res: Record<string, any>) => ({
  ref: String(res?.custom_id ?? '').toUpperCase(),
  paidUsd: Number(res?.amount?.value ?? 0),
  paidCur: String(res?.amount?.currency_code ?? ''),
  ppOrderId: String(res?.supplementary_data?.related_ids?.order_id ?? ''),
});

export const POST: APIRoute = async ({ request }) => {
  // 원문을 먼저 확보한다 — 서명 검증에 쓰는 이벤트 본문이 파싱 전후로 달라지면 안 된다.
  let raw = '';
  try {
    raw = await request.text();
  } catch {
    return ok({ ok: false, error: 'bad_request' }, 400);
  }
  if (!raw || raw.length > 200_000) return ok({ ok: false, error: 'bad_request' }, 400);

  let event: Record<string, any>;
  try {
    event = JSON.parse(raw) as Record<string, any>;
  } catch {
    return ok({ ok: false, error: 'bad_json' }, 400);
  }

  const cfg = paypalCfg();
  if (!cfg.enabled) return ok({ ok: false, error: 'paypal_disabled' }, 503);
  if (!cfg.webhookId) {
    // 환경변수 미설정 상태에서 조용히 통과시키면 위조 요청을 그대로 처리하게 된다.
    console.error('[paypal-webhook] PAYPAL_WEBHOOK_ID 미설정 — 이벤트 폐기');
    return ok({ ok: false, error: 'no_webhook_id' }, 503);
  }

  // ── 서명 검증 (이 관문을 통과하지 못하면 아무것도 하지 않는다) ──
  const v = await ppVerifyWebhook(request.headers, event);
  if (!v.verified) {
    console.warn('[paypal-webhook] 서명 검증 실패:', v.reason, String(event.event_type ?? ''));
    return ok({ ok: false, error: 'invalid_signature' }, 401);
  }

  const type = String(event.event_type ?? '');
  const res = (event.resource ?? {}) as Record<string, any>;

  const d = await db();
  if (!d) return ok({ ok: false, error: 'no_db' }, 503);

  try {
    switch (type) {
      // 고객이 승인만 하고 이탈한 경우 — 서버가 대신 캡처해 매출 유실을 막는다.
      case 'CHECKOUT.ORDER.APPROVED': {
        const ppOrderId = String(res?.id ?? '');
        const ref = String(res?.purchase_units?.[0]?.custom_id ?? '').toUpperCase();
        if (!ppOrderId || !ref) return ok({ ok: true, skipped: 'no_ref' });

        const { httpOk, body: cap } = await ppCapture(ppOrderId);
        const status = String((cap as Record<string, any>).status ?? '');
        if (!httpOk || status !== 'COMPLETED') {
          // 이미 캡처된 주문이면 PayPal 이 오류를 준다 — 정상 상황이므로 조용히 넘어간다.
          const detail = JSON.stringify(cap).slice(0, 200);
          if (detail.includes('ORDER_ALREADY_CAPTURED')) return ok({ ok: true, skipped: 'already_captured' });
          console.warn('[paypal-webhook] 승인건 캡처 실패:', ref, status, detail);
          return ok({ ok: true, skipped: 'capture_failed' });
        }
        const c = ((cap as Record<string, any>).purchase_units?.[0]?.payments?.captures ?? [])[0] ?? {};
        const r = await settlePayment(d, {
          ref,
          ppOrderId,
          paidUsd: Number(c?.amount?.value ?? 0),
          paidCur: String(c?.amount?.currency_code ?? ''),
          source: 'webhook',
        });
        return ok({ ok: r.ok, via: 'approved' });
      }

      // 결제가 실제로 완료됨 — 브라우저 경로가 실패했더라도 여기서 확정된다.
      case 'PAYMENT.CAPTURE.COMPLETED': {
        const { ref, paidUsd, paidCur, ppOrderId } = pickCapture(res);
        if (!ref) return ok({ ok: true, skipped: 'no_ref' });
        const r = await settlePayment(d, { ref, ppOrderId, paidUsd, paidCur, source: 'webhook' });
        return ok({ ok: r.ok, via: 'completed' });
      }

      // 거절·환불 — 자동으로 상태를 되돌리지 않고 사람이 판단하도록 알린다.
      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.CAPTURE.REVERSED':
      case 'PAYMENT.CAPTURE.REFUNDED': {
        const { ref, paidUsd } = pickCapture(res);
        const label = type.endsWith('REFUNDED') ? '환불' : type.endsWith('REVERSED') ? '취소' : '거절';
        console.warn(`[paypal-webhook] ${label}:`, ref, paidUsd);
        await notifyChat(`⚠️ [PayPal ${label}] ${ref || '(주문번호 없음)'} — $${paidUsd.toFixed(2)} USD · 주문 상태를 확인해 주세요`);
        return ok({ ok: true, via: label });
      }

      default:
        // 구독하지 않은 이벤트도 200 으로 받아준다 — 4xx 를 주면 PayPal 이 계속 재전송한다.
        return ok({ ok: true, skipped: type || 'unknown' });
    }
  } catch (e) {
    console.error('[paypal-webhook] 처리 실패:', type, e);
    // 5xx 를 주면 PayPal 이 재전송하므로 일시적 오류는 자동 복구된다.
    return ok({ ok: false, error: 'handler_error' }, 500);
  }
};
