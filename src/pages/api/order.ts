// 주문 생성.
//
// ⚠️ 보안 핵심: 금액은 절대 브라우저가 보낸 값을 믿지 않는다.
//    클라이언트는 {sku, qty}만 보내고, 서버가 상품 카탈로그에서 단가를 읽어 총액을 다시 계산한다.
//    (견적 주문은 DB의 quoted_amount 를 쓴다 — 이 역시 관리자가 넣은 값)
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { env as cfEnv } from 'cloudflare:workers';
import { db, newId, nowIso } from '../../lib/db';
import { isKnownCountry } from '../../lib/countries';
import { rateLimit, tooMany } from '../../lib/rate-limit';
import { verifyTurnstile } from '../../lib/turnstile';

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

  // 레이트리밋: IP당 1시간에 10건. (허니팟 통과 후 — 봇은 위에서 걸러진다)
  const rl = await rateLimit(await db(), 'order', request);
  if (!rl.ok) return tooMany(rl.retryAfterSec);

  // Turnstile 캡챠 검증. (허니팟 통과 후 — 사람만 검증)
  //   키 미설정/네트워크 오류면 통과(가용성 우선), 토큰 없음/무효면 차단.
  const ts = await verifyTurnstile(str(body['cf-turnstile-response']), request);
  if (!ts.ok) return json({ ok: false, error: 'captcha_failed' }, 400);

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
  // 실물 배송이 필요한 주문이면 주소가 필수다. (분석 서비스처럼 배송이 없으면 생략)
  const needsShipping = body.needsShipping !== false;
  const shipName = str(body.shipName).slice(0, MAX);
  const shipPhone = str(body.shipPhone).slice(0, MAX);
  const shipZip = str(body.shipZip).slice(0, 20);
  const shipAddr1 = str(body.shipAddr1).slice(0, MAX);
  const shipAddr2 = str(body.shipAddr2).slice(0, MAX);
  const shipCity = str(body.shipCity).slice(0, MAX);
  const shipState = str(body.shipState).slice(0, MAX);
  const shipMemo = str(body.shipMemo).slice(0, 1000);
  const desiredDate = str(body.desiredDate).slice(0, 120);
  const orderNote = str(body.orderNote).slice(0, 2000);
  const shipCourierAcct = str(body.shipCourierAcct).slice(0, 60);

  let shipCountry = str(body.shipCountry).toUpperCase().slice(0, 40);
  if (needsShipping) {
    if (!shipCountry || !isKnownCountry(shipCountry)) {
      return json({ ok: false, error: 'bad_country' }, 400);
    }
    if (shipCountry === 'OTHER') {
      const other = str(body.shipCountryOther).slice(0, 60);
      if (!other) return json({ ok: false, error: 'missing_country' }, 400);
      shipCountry = other; // 국가명을 그대로 저장
    }
    if (!shipName || !shipPhone) return json({ ok: false, error: 'missing_recipient' }, 400);
    if (!shipAddr1 || !shipZip) return json({ ok: false, error: 'missing_address' }, 400);
    // 해외는 도시가 필수 (한국 주소는 도로명에 포함됨)
    if (shipCountry !== 'KR' && !shipCity) return json({ ok: false, error: 'missing_city' }, 400);
  }

  // 연락처는 필수 (배송·통관 연락용)
  if (!buyerPhone) return json({ ok: false, error: 'missing_phone' }, 400);

  // ── 4) 세금계산서 ──────────────────────────────────
  // 세금계산서는 국내 사업자만 (해외 주문은 상업 송장으로 대체)
  const taxInvoice =
    (body.taxInvoice === true || str(body.taxInvoice) === 'on') &&
    (!needsShipping || shipCountry === 'KR');
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
    // 웨이퍼(공정가): sku 'wafer:{id}' — 가격은 항상 컬렉션 priceKrw 에서 재계산 (브라우저 값 무시)
    const waferCat = await getCollection('wafers');
    const waferById = new Map(waferCat.map((w) => [w.id, w]));

    for (const it of raw) {
      const sku = str((it as Record<string, unknown>)?.sku);
      const qty = Number((it as Record<string, unknown>)?.qty);
      if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 999) {
        return json({ ok: false, error: 'bad_item' }, 400);
      }
      if (sku.startsWith('wafer:')) {
        const w = waferById.get(sku.slice(6));
        if (!w || w.data.published === false || typeof w.data.priceKrw !== 'number' || w.data.priceKrw <= 0) {
          return json({ ok: false, error: 'unknown_sku', sku }, 400);
        }
        const unit = Math.round(w.data.priceKrw);
        const subtotal = unit * qty;
        lines.push({
          sku,
          name: locale === 'en' ? ((w.data as Record<string, unknown>).name_en as string ?? w.data.name) : w.data.name,
          unit,
          qty,
          subtotal,
        });
        amount += subtotal;
        continue;
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
            needs_shipping, ship_name, ship_phone, ship_country, ship_zip,
            ship_addr1, ship_addr2, ship_city, ship_state, ship_memo, ship_courier_acct,
            tax_invoice, tax_biz_no, tax_biz_name, tax_ceo, tax_email,
            desired_date, order_note,
            inquiry_id, agreed_terms, locale, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        orderId, 'pending', amount, 'KRW',
        buyerName, buyerEmail, buyerPhone, buyerCompany || null,
        needsShipping ? 1 : 0,
        shipName || null, shipPhone || null, needsShipping ? shipCountry : null, shipZip || null,
        shipAddr1 || null, shipAddr2 || null, shipCity || null, shipState || null, shipMemo || null,
        shipCourierAcct || null,
        taxInvoice ? 1 : 0, taxInvoice ? taxBizNo : null, taxInvoice ? taxBizName : null,
        taxInvoice ? (taxCeo || null) : null, taxInvoice ? taxEmail : null,
        desiredDate || null, orderNote || null,
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
    desiredDate ? `희망 완료: ${desiredDate}` : '',
    orderNote ? `요청사항: ${orderNote}` : '',
    needsShipping
      ? `배송[${shipCountry}]: ${shipName} · ${shipPhone}\n  (${shipZip}) ${[shipAddr1, shipAddr2, shipCity, shipState].filter(Boolean).join(', ')}`
      : '배송 없음 (분석 서비스)',
    shipCourierAcct ? `택배사 계정(착불): ${shipCourierAcct}` : '',
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
    // ⚠️ payload(text)에는 주문자 이름·이메일·전화·배송지가 들어있다. 로그에 남기지 않는다.
    //    진단은 주문번호만으로 충분하다.
    console.warn('[order] GOOGLE_CHAT_WEBHOOK 미설정 — 알림을 건너뜁니다. 주문번호:', orderId);
  }

  return json({ ok: true, orderId, amount });
};
