// 주문 생성.
//
// ⚠️ 보안 핵심: 금액은 절대 브라우저가 보낸 값을 믿지 않는다.
//    클라이언트는 {sku, qty}만 보내고, 서버가 상품 카탈로그에서 단가를 읽어 총액을 다시 계산한다.
//    (견적 주문은 DB의 quoted_amount 를 쓴다 — 이 역시 관리자가 넣은 값)
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { env as cfEnv } from 'cloudflare:workers';
import { db, newId, nowIso } from '../../lib/db';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const MAX = 500;

// 사업자등록번호 검증 (10자리 + 체크섬)
function validBizNo(raw: string): boolean {
  const n = raw.replace(/\D/g, '');
  if (n.length !== 10) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(n[i]) * w[i];
  sum += Math.floor((Number(n[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(n[9]);
}

export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  // 봇 차단
  if (str(body.vanam_hp_email) !== '') return json({ ok: true, orderId: 'SPAM', spam: true });

  // ── 1) 주문자 ──────────────────────────────────────
  const buyerName = str(body.buyerName).slice(0, MAX);
  const buyerEmail = str(body.buyerEmail).slice(0, MAX);
  const buyerPhone = str(body.buyerPhone).slice(0, MAX);
  const buyerCompany = str(body.buyerCompany).slice(0, MAX);
  const locale = str(body.locale) === 'ko' ? 'ko' : 'en';

  if (!buyerName || !buyerEmail) return json({ ok: false, error: 'missing_buyer' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
    return json({ ok: false, error: 'invalid_email' }, 400);
  }

  // ── 2) 필수 동의 ───────────────────────────────────
  if (str(body.privacy) !== 'agreed') return json({ ok: false, error: 'need_privacy' }, 400);
  // 청약철회 제한(주문 제작품) 고지 동의 — 전자상거래법상 사전 고지·동의가 있어야 효력이 있다
  if (str(body.agreeTerms) !== 'agreed') return json({ ok: false, error: 'need_terms' }, 400);

  // ── 3) 배송지 ──────────────────────────────────────
  const shipName = str(body.shipName).slice(0, MAX);
  const shipPhone = str(body.shipPhone).slice(0, MAX);
  const shipZip = str(body.shipZip).slice(0, 20);
  const shipAddr1 = str(body.shipAddr1).slice(0, MAX);
  const shipAddr2 = str(body.shipAddr2).slice(0, MAX);
  const shipMemo = str(body.shipMemo).slice(0, 1000);

  // ── 4) 세금계산서 ──────────────────────────────────
  const taxInvoice = body.taxInvoice === true || str(body.taxInvoice) === 'on';
  const taxBizNo = str(body.taxBizNo).slice(0, 20);
  const taxBizName = str(body.taxBizName).slice(0, MAX);
  const taxCeo = str(body.taxCeo).slice(0, MAX);
  const taxEmail = str(body.taxEmail).slice(0, MAX);

  if (taxInvoice) {
    if (!taxBizNo || !taxBizName || !taxEmail) return json({ ok: false, error: 'missing_tax' }, 400);
    if (!validBizNo(taxBizNo)) return json({ ok: false, error: 'invalid_biz_no' }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(taxEmail)) {
      return json({ ok: false, error: 'invalid_tax_email' }, 400);
    }
  }

  // ── 5) ⭐ 금액 계산 — 서버가 카탈로그에서 단가를 읽는다 ──
  const inquiryId = str(body.inquiryId).slice(0, 40);
  type Line = { sku: string; name: string; unit: number; qty: number; subtotal: number };
  const lines: Line[] = [];
  let amount = 0;

  const d = await db();

  if (inquiryId) {
    // ── 견적 주문: DB의 quoted_amount 를 쓴다 (관리자가 책정한 값)
    if (!/^INQ-\d{8}-[A-Z0-9]{4}$/.test(inquiryId)) return json({ ok: false, error: 'bad_inquiry' }, 400);
    if (!d) return json({ ok: false, error: 'no_db' }, 503);

    const q = await d
      .prepare(`SELECT id, product_sku, product_name, quoted_amount, status FROM inquiries WHERE id = ?`)
      .bind(inquiryId)
      .first<{ id: string; product_sku: string | null; product_name: string | null; quoted_amount: number | null; status: string }>();

    if (!q) return json({ ok: false, error: 'inquiry_not_found' }, 404);
    if (!q.quoted_amount || q.quoted_amount <= 0) return json({ ok: false, error: 'not_quoted' }, 409);
    if (q.status === 'closed') return json({ ok: false, error: 'quote_closed' }, 409);

    amount = q.quoted_amount;
    lines.push({
      sku: q.product_sku ?? inquiryId,
      name: q.product_name ?? '맞춤 견적',
      unit: amount,
      qty: 1,
      subtotal: amount,
    });
  } else {
    // ── 일반 주문: {sku, qty} 만 받고 단가는 서버 카탈로그에서
    const raw = Array.isArray(body.items) ? body.items : [];
    if (raw.length === 0 || raw.length > 50) return json({ ok: false, error: 'bad_items' }, 400);

    const catalog = await getCollection('products');
    const byId = new Map(catalog.map((p) => [p.id, p]));

    for (const it of raw) {
      const sku = str((it as Record<string, unknown>)?.sku);
      const qty = Number((it as Record<string, unknown>)?.qty);
      if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 999) {
        return json({ ok: false, error: 'bad_item' }, 400);
      }
      const p = byId.get(sku);
      if (!p || !p.data.published) return json({ ok: false, error: 'unknown_sku', sku }, 400);
      if (p.data.pricingType !== 'fixed' || typeof p.data.price !== 'number' || p.data.price <= 0) {
        return json({ ok: false, error: 'not_purchasable', sku }, 400);
      }
      const unit = Math.round(p.data.price); // 카탈로그 단가 (브라우저 값 무시)
      const subtotal = unit * qty;
      lines.push({
        sku,
        name: locale === 'en' ? (p.data.name_en ?? p.data.name) : p.data.name,
        unit,
        qty,
        subtotal,
      });
      amount += subtotal;
    }
  }

  if (amount <= 0 || amount > 100_000_000) return json({ ok: false, error: 'bad_amount' }, 400);

  // ── 6) 저장 ────────────────────────────────────────
  const orderId = newId('ORD');
  const created = nowIso();

  if (!d) {
    console.warn('[order] D1 미연결 — 주문을 저장할 수 없습니다.');
    return json({ ok: false, error: 'no_db' }, 503);
  }

  try {
    await d
      .prepare(
        `INSERT INTO orders
           (id, status, amount, currency,
            buyer_name, buyer_email, buyer_phone, buyer_company,
            ship_name, ship_phone, ship_zip, ship_addr1, ship_addr2, ship_memo,
            tax_invoice, tax_biz_no, tax_biz_name, tax_ceo, tax_email,
            inquiry_id, agreed_terms, locale, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        orderId, 'pending', amount, 'KRW',
        buyerName, buyerEmail, buyerPhone || null, buyerCompany || null,
        shipName || null, shipPhone || null, shipZip || null,
        shipAddr1 || null, shipAddr2 || null, shipMemo || null,
        taxInvoice ? 1 : 0, taxInvoice ? taxBizNo : null, taxInvoice ? taxBizName : null,
        taxInvoice ? (taxCeo || null) : null, taxInvoice ? taxEmail : null,
        inquiryId || null, 1, locale, created,
      )
      .run();

    for (const l of lines) {
      await d
        .prepare(
          `INSERT INTO order_items (order_id, sku, name, unit_price, qty, subtotal) VALUES (?,?,?,?,?,?)`,
        )
        .bind(orderId, l.sku, l.name, l.unit, l.qty, l.subtotal)
        .run();
    }

    // 견적에서 이어진 주문이면 견적 상태를 갱신
    if (inquiryId) {
      await d
        .prepare(`UPDATE inquiries SET status = 'replied', updated_at = ? WHERE id = ?`)
        .bind(created, inquiryId)
        .run();
    }
  } catch (e) {
    console.error('[order] 저장 실패:', e);
    return json({ ok: false, error: 'db_error' }, 500);
  }

  // ── 7) 구글챗 알림 ─────────────────────────────────
  const rawHook =
    (cfEnv as Record<string, unknown> | undefined)?.GOOGLE_CHAT_WEBHOOK ??
    import.meta.env.GOOGLE_CHAT_WEBHOOK ??
    '';
  const webhook = typeof rawHook === 'string' ? rawHook.trim().replace(/^["']|["']$/g, '') : '';

  const text = [
    '🛒 *새 주문 (결제 대기)*',
    `주문번호: ${orderId}`,
    `금액: ₩${amount.toLocaleString('ko-KR')}`,
    ...lines.map((l) => `· ${l.name} × ${l.qty} = ₩${l.subtotal.toLocaleString('ko-KR')}`),
    `주문자: ${buyerName}${buyerCompany ? ` (${buyerCompany})` : ''} · ${buyerEmail}${buyerPhone ? ` · ${buyerPhone}` : ''}`,
    shipAddr1 ? `배송: (${shipZip}) ${shipAddr1} ${shipAddr2}`.trim() : '배송지 없음',
    taxInvoice ? `📄 세금계산서 요청 — ${taxBizName} (${taxBizNo}) → ${taxEmail}` : '세금계산서: 미요청',
    inquiryId ? `견적: ${inquiryId}` : '',
    `(${locale} · ${created})`,
  ].filter(Boolean).join('\n');

  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ text }),
      });
    } catch (e) {
      console.error('[order] 알림 실패 (주문은 저장됨):', e);
    }
  } else {
    console.log('[order] GOOGLE_CHAT_WEBHOOK not set. Payload:\n' + text);
  }

  return json({ ok: true, orderId, amount });
};
