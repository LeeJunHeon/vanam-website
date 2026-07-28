// PayPal 주문 생성 — 금액은 서버가 D1 에서 재조회/재계산한다 (클라이언트 금액 무시).
// INQ-: 관리자가 USD 로 확정한 견적만 / ORD-: KRW 합계를 환산.
// 금액 계산은 lib/paypal 의 expectedUsdStr 하나만 사용한다(캡처 검증과 동일 함수 = 기준 불일치 원천 차단).
import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { rateLimit, tooMany } from '../../../lib/rate-limit';
import { paypalCfg, ppCreateOrder, expectedUsdStr } from '../../../lib/paypal';
import { getRate, pickWaitUntil } from '../../../lib/fx';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, locals }) => {
  let lenv: Record<string, unknown> | undefined;
  try {
    lenv = (locals as unknown as { runtime?: { env?: Record<string, unknown> } })?.runtime?.env;
  } catch { lenv = undefined; }
  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  const rl = await rateLimit(d, 'paypalCreate', request);
  if (!rl.ok) return tooMany(rl.retryAfterSec);

  if (!paypalCfg(lenv).enabled) return json({ ok: false, error: 'disabled' }, 503);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  const ref = typeof body.ref === 'string' ? body.ref.trim().toUpperCase() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const isOrd = /^ORD-\d{8}-[A-Z0-9]{4}$/.test(ref);
  const isInq = /^INQ-\d{8}-[A-Z0-9]{4}$/.test(ref);
  // email 은 선택 항목이다. 주문완료 화면은 주문번호만으로 열리므로 이메일까지 DOM 에 실으면
  // 주문번호를 아는 사람에게 구매자 이메일이 그대로 노출된다. 보내온 경우에만 대조한다.
  if (!isOrd && !isInq) return json({ ok: false, error: 'bad_request' }, 400);

  try {
    const fxRate = (await getRate(d, pickWaitUntil(locals))).rate;
  let valueUsd = '';
    let description = '';

    if (isInq) {
      const q = await d.prepare(`SELECT * FROM inquiries WHERE id = ?`).bind(ref).first<Record<string, unknown>>();
      if (!q || (email && String(q.email ?? '').toLowerCase() !== email)) return json({ ok: false, error: 'not_found' }, 404);
      if (q.paid_at) return json({ ok: false, error: 'already_paid' }, 409);
      const st = String(q.status ?? '');
      const exp = expectedUsdStr('inq', q, fxRate);
      if (!exp || !['quoted', 'replied'].includes(st)) {
        return json({ ok: false, error: 'not_payable' }, 409);
      }
      valueUsd = exp;
      description = `VanaM quote ${ref}`;
    } else {
      const o = await d.prepare(`SELECT * FROM orders WHERE id = ?`).bind(ref).first<Record<string, unknown>>();
      if (!o || (email && String(o.buyer_email ?? '').toLowerCase() !== email)) return json({ ok: false, error: 'not_found' }, 404);
      if (o.paid_at) return json({ ok: false, error: 'already_paid' }, 409);
      if (String(o.status ?? '') !== 'pending') return json({ ok: false, error: 'not_payable' }, 409);
      const exp = expectedUsdStr('ord', o, fxRate);
      if (!exp) return json({ ok: false, error: 'not_payable' }, 409);
      valueUsd = exp;
      description = `VanaM order ${ref}`;
    }

    const created = await ppCreateOrder(valueUsd, ref, description);

    // 대사(참조)용으로 PayPal 주문번호 저장 — 컬럼 미이관 DB 면 명확한 에러로 안내
    try {
      const table = isInq ? 'inquiries' : 'orders';
      await d.prepare(`UPDATE ${table} SET paypal_order_id = ? WHERE id = ?`).bind(created.id, ref).run();
    } catch (e) {
      console.error('[paypal] paypal_order_id 저장 실패 — D1 마이그레이션 필요:', e);
      return json({ ok: false, error: 'db_migration_required' }, 500);
    }

    return json({ ok: true, id: created.id, value: valueUsd });
  } catch (e) {
    console.error('[paypal] create-order 실패:', e);
    return json({ ok: false, error: 'paypal_error' }, 502);
  }
};
