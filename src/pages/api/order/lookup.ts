// 비회원 주문 조회.
// 로그인이 없으므로 "주문번호 + 주문 시 입력한 이메일"이 일치해야 상세를 보여준다.
// (주문번호만으로 조회하게 두면 임의 대입으로 남의 주문을 볼 수 있다)
import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { rateLimit, tooMany } from '../../../lib/rate-limit';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request }) => {
  // 주문번호 무차별 대입 차단: IP당 1분에 10회.
  const rl = await rateLimit(await db(), 'lookup', request);
  if (!rl.ok) return tooMany(rl.retryAfterSec);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  const id = typeof body.id === 'string' ? body.id.trim().toUpperCase() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  if (!/^ORD-\d{8}-[A-Z0-9]{4}$/.test(id) || !email) {
    return json({ ok: false, error: 'not_found' }, 404);
  }

  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  try {
    const o = await d
      .prepare(
        `SELECT id, status, amount, currency, buyer_name, buyer_email, buyer_company,
                needs_shipping, ship_name, ship_phone, ship_country, ship_zip,
                ship_addr1, ship_addr2, ship_city, ship_state, ship_memo,
                tax_invoice, inquiry_id, created_at, paid_at
           FROM orders WHERE id = ?`,
      )
      .bind(id)
      .first<Record<string, unknown>>();

    // 존재하지 않든 이메일이 다르든 같은 응답 — 주문번호 존재 여부를 흘리지 않는다
    if (!o || String(o.buyer_email ?? '').toLowerCase() !== email) {
      await new Promise((r) => setTimeout(r, 500));
      return json({ ok: false, error: 'not_found' }, 404);
    }

    const { results: items } = await d
      .prepare(`SELECT sku, name, unit_price, qty, subtotal FROM order_items WHERE order_id = ?`)
      .bind(id)
      .all();

    return json({ ok: true, order: o, items });
  } catch (e) {
    console.error('[order/lookup] 조회 실패:', e);
    return json({ ok: false, error: 'db_error' }, 500);
  }
};
