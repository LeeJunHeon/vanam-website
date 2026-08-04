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

  const isOrd = /^ORD-\d{8}-[A-Z0-9]{4}$/.test(id);
  const isInq = /^INQ-\d{8}-[A-Z0-9]{4}$/.test(id);
  if ((!isOrd && !isInq) || !email) {
    return json({ ok: false, error: 'not_found' }, 404);
  }

  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  // 견적·주문 요청(INQ-) 조회 — 접수 상태·견적 금액·안내 메모를 보여준다.
  // SELECT * 인 이유: quote_currency 컬럼이 아직 없는 DB에서도 동작해야 해서 (마이그레이션 순서 무관)
  if (isInq) {
    try {
      const q = await d
        .prepare(`SELECT * FROM inquiries WHERE id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      if (!q || String(q.email ?? '').toLowerCase() !== email) {
        await new Promise((r) => setTimeout(r, 500));
        return json({ ok: false, error: 'not_found' }, 404);
      }
      return json({
        ok: true,
        inquiry: {
          id: q.id,
          type: q.type,
          status: q.status,
          // 접수 당시 언어로 굳은 product_name 대신, 화면이 보고 있는 언어로 다시 그리기 위해
          // 상품 id 도 함께 내려준다. (허용목록에서 빠지면 오류 없이 null 이 된다 — 지뢰 ㉟)
          product_sku: q.product_sku ?? null,
          product_name: q.product_name ?? null,
          material: q.material ?? null,
          method: q.method ?? null,
          substrate: q.substrate ?? null,
          details: q.details ?? null,
          // 라벨 붙이기 전의 구조화 사본 — 조회 화면이 '보는 언어'로 다시 그린다.
          // (허용목록에서 빠지면 오류 없이 null 이 된다 — 지뢰 ㉟)
          details_json: (q as Record<string, unknown>).details_json ?? null,
          quoted_amount: q.quoted_amount ?? null,
          quote_currency: (q.quote_currency as string) ?? 'KRW',
          quote_note: q.quote_note ?? null,
          paid_at: (q as Record<string, unknown>).paid_at ?? null,
          created_at: q.created_at,
        },
      });
    } catch (e) {
      console.error('[order/lookup] 문의 조회 실패:', e);
      return json({ ok: false, error: 'db_error' }, 500);
    }
  }

  try {
    const o = await d
      // SELECT * 인 이유: paid_usd·paypal_order_id 컬럼 마이그레이션 전 DB 에서도 동작해야 해서
      .prepare(`SELECT * FROM orders WHERE id = ?`)
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

    // 행 전체를 그대로 내보내면 관리자 메모까지 고객에게 전송된다.
    // 고객에게 필요한 항목만 골라서 내려보낸다.
    const safe = {
      id: o.id,
      status: o.status,
      amount: o.amount,
      currency: o.currency,
      amount_usd: o.amount_usd,
      paid_usd: o.paid_usd,
      paid_at: o.paid_at,
      pay_method: o.pay_method,
      created_at: o.created_at,
      needs_shipping: o.needs_shipping,
      // 배송지 표시용 — DB(SELECT *)에는 있었지만 허용목록에서 빠져
      // 조회 화면이 빈 값을 조합해 "·" 만 남던 결함(지뢰 ㉟형)의 수정.
      ship_name: o.ship_name ?? null,
      ship_phone: o.ship_phone ?? null,
      ship_zip: o.ship_zip ?? null,
      ship_addr1: o.ship_addr1 ?? null,
      ship_addr2: o.ship_addr2 ?? null,
      ship_city: o.ship_city ?? null,
      ship_state: o.ship_state ?? null,
      ship_country: o.ship_country,
      tracking_no: o.tracking_no,
      tracking_courier: o.tracking_courier,
      tax_invoice: o.tax_invoice,
    };
    return json({ ok: true, order: safe, items });
  } catch (e) {
    console.error('[order/lookup] 조회 실패:', e);
    return json({ ok: false, error: 'db_error' }, 500);
  }
};
