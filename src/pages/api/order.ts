// 주문 생성.
//
// ⚠️ 보안 핵심: 금액은 절대 브라우저가 보낸 값을 믿지 않는다.
//    클라이언트는 {sku, qty}만 보내고, 서버가 상품 카탈로그에서 단가를 읽어 총액을 다시 계산한다.
//    (견적 주문은 DB의 quoted_amount 를 쓴다 — 이 역시 관리자가 넣은 값)
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { db, newId, nowIso, nowKst } from '../../lib/db';
import { isKnownCountry } from '../../lib/countries';
import { rateLimit, tooMany } from '../../lib/rate-limit';
import { verifyTurnstile } from '../../lib/turnstile';
import { getRate, pickWaitUntil } from '../../lib/fx';
// 이메일 규칙 — 화면(주문서·견적·문의 폼)과 같은 파일을 쓴다(한쪽만 다르면 고객이 원인 모를 실패를 본다)
import { isEmail } from '../../lib/email-rule.js';
// 구글챗은 이 통로로만 보낸다 — Cloudflare main 빌드가 아니면 코드에서 차단된다.
import { sendChat } from '../../lib/chat-send';
// 주문 알림 본문(고객 입력 꺾쇠 무력화 · 길이 상한) — 견적·문의 알림과 같은 파일
import { buildOrderChatDetail } from '../../lib/chat-message.js';

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

export const POST: APIRoute = async ({ request, locals }) => {
  // 예기치 못한 예외가 그대로 500(빈 본문)으로 나가면 화면에는
  // "Unexpected end of JSON input" 만 보여 원인을 알 수 없다.
  // 어떤 실패든 JSON 으로 사유를 돌려주고 서버 로그에 남긴다.
  // 응답에는 내부 오류 메시지를 싣지 않는다(10-23 — 고객 화면은 쓰지 않고, 서버 구조가 드러난다). 원인은 서버 로그(stack)로 본다.
  try {
    return await handleOrder({ request, locals });
  } catch (e) {
    const err = e as Error;
    console.error('[order] 처리 실패:', err?.stack ?? err);
    return json({ ok: false, error: 'server_error' }, 500);
  }
};

async function handleOrder({ request, locals }: { request: Request; locals: unknown }) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  // 봇 차단
  // 미끼칸(신·구 이름 모두 검사 — 배포 시차 동안 양쪽이 공존할 수 있다)
  if (str(body.vanam_hp_note) !== '' || str(body.vanam_hp_email) !== '') {
    return json({ ok: true, orderId: 'SPAM', spam: true });
  }

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
  if (!isEmail(buyerEmail)) {
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
  // 결제 수단(paypal|bank) — 국내 고객은 PayPal 을 쓸 수 없어 계좌이체로 안내한다.
  const payMethod = str(body.payMethod) === 'bank' ? 'bank' : 'paypal';
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
    if (!isEmail(taxEmail)) {
      return json({ ok: false, error: 'invalid_tax_email' }, 400);
    }
  }

  // ── 5) ⭐ 금액 계산 — 서버가 카탈로그에서 단가를 읽는다 ──
  const inquiryId = str(body.inquiryId).slice(0, 40);
  // unit = 상품 단가(박스당) · dicingFee = 박스당 다이싱 비용(고르지 않았으면 0)
  // subtotal = (unit + dicingFee) × qty  ← 청구 근거는 언제나 이 식 하나다
  type Line = {
    sku: string; name: string; unit: number; qty: number; subtotal: number;
    dicing: boolean; dicingFee: number;
  };
  const lines: Line[] = [];
  let amount = 0;

  const d = await db();

  if (inquiryId) {
    // ⚠️ 10-12: 견적을 이 주문 API 로 결제하던 길(/checkout?quote=INQ-…)은 닫았다 — Checkout.astro 머리 주석.
    //    견적 통화(quote_currency)를 무시해 USD 견적이 같은 숫자의 원화로 주문됐고(₩1,500 → $1.09),
    //    결제가 끝난 견적도 다시 주문되며 상태가 'paid' → 'replied' 로 덮였다. 사이트 안에 이 길로 가는 링크는 없다.
    //    견적 결제는 '주문·견적 조회'(접수번호 + 이메일 확인 뒤 PayPal · 계좌 안내)에서만 한다.
    return json({ ok: false, error: 'quote_checkout_closed' }, 410);
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
      if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 99) { // 클라이언트 상한(99)과 일치
        return json({ ok: false, error: 'bad_item' }, 400);
      }
      if (sku.startsWith('wafer:')) {
        const w = waferById.get(sku.slice(6));
        if (!w || w.data.published === false || typeof w.data.priceKrw !== 'number' || w.data.priceKrw <= 0) {
          return json({ ok: false, error: 'unknown_sku', sku }, 400);
        }
        const unit = Math.round(w.data.priceKrw);
        // ⭐ 다이싱: 브라우저는 '골랐다/안 골랐다'만 보낸다. **금액은 여기서 컬렉션을 읽어 정한다.**
        //   컬렉션에 dicingFeeKrw 가 없는 웨이퍼(예: 사파이어)는 화면에 선택칸 자체가 없다 —
        //   그런 sku 로 dicing=true 가 들어오면 조작이므로 값을 무시하고 '불필요'로 처리한다.
        const feeKrw = (w.data as Record<string, unknown>).dicingFeeKrw;
        const dicingFee =
          typeof feeKrw === 'number' && feeKrw > 0 ? Math.round(feeKrw) : 0;
        const dicing = (it as Record<string, unknown>)?.dicing === true && dicingFee > 0;
        const subtotal = (unit + (dicing ? dicingFee : 0)) * qty;
        lines.push({
          sku,
          name: locale === 'en' ? ((w.data as Record<string, unknown>).name_en as string ?? w.data.name) : w.data.name,
          unit,
          qty,
          subtotal,
          dicing,
          dicingFee: dicing ? dicingFee : 0,
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
        dicing: false,      // 다이싱은 웨이퍼 전용 옵션이다
        dicingFee: 0,
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

  // 알림 본문(try 블록 밖)에서도 쓰이므로 블록 밖에 선언한다.
  // const 는 블록 스코프여서, try 안에 두면 아래에서 ReferenceError 가 난다.
  let fx: { rate: number } = { rate: 0 };
  let amountUsd = 0;

  try {
    // 주문 시점의 라이브 환율로 USD 를 확정한다. 이후 환율이 변해도 청구액은 이 값으로 고정된다.
    fx = await getRate(d, pickWaitUntil(locals));
    amountUsd = Math.round((amount / fx.rate) * 100) / 100;

    // 주문 본문 + 품목 + (있다면) 견적 상태를 하나의 원자 트랜잭션으로 저장한다 (0251).
    //   기존 순차 .run() 은 품목 INSERT 중간에 실패하면 품목 없는 '반쪽 주문'이 남았다.
    //   D1 batch() 는 배열 전체를 단일 암묵 트랜잭션으로 실행한다 — 하나라도 실패하면
    //   전부 롤백되고 아래 catch 로 떨어져 응답(db_error 500)은 종전과 동일하다.
    //   부수 효과로 DB 왕복도 (2 + 품목 수) → 1 로 줄어든다.
    const itemStmt = d.prepare(
      `INSERT INTO order_items (order_id, sku, name, unit_price, qty, subtotal, dicing, dicing_fee)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    const stmts = [
      d
        .prepare(
            `INSERT INTO orders
           (id, status, amount, currency,
            buyer_name, buyer_email, buyer_phone, buyer_company,
            needs_shipping, ship_name, ship_phone, ship_country, ship_zip,
            ship_addr1, ship_addr2, ship_city, ship_state, ship_memo, ship_courier_acct,
            tax_invoice, tax_biz_no, tax_biz_name, tax_ceo, tax_email,
            desired_date, order_note, amount_usd, pay_method,
            inquiry_id, agreed_terms, locale, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        // 주문 시점 환율로 USD 를 확정 저장한다. 이후 환율이 바뀌어도
        // 고객에게 보인 금액과 실제 청구액이 어긋나지 않는다(결제 대조의 기준값).
        amountUsd,
        payMethod,
        inquiryId || null, 1, locale, created,
        ),
      ...lines.map((l) =>
        itemStmt.bind(orderId, l.sku, l.name, l.unit, l.qty, l.subtotal, l.dicing ? 1 : 0, l.dicingFee),
      ),
    ];
    // 견적에서 이어진 주문이면 견적 상태 갱신도 같은 트랜잭션에 포함한다
    if (inquiryId) {
      stmts.push(
        d.prepare(`UPDATE inquiries SET status = 'replied', updated_at = ? WHERE id = ?`).bind(created, inquiryId),
      );
    }
    await d.batch(stmts);
  } catch (e) {
    console.error('[order] 저장 실패:', e);
    return json({ ok: false, error: 'db_error' }, 500);
  }

  // ── 7) 구글챗 알림 (chat-send.ts 가 유일한 발송 통로) ──────────────
  // 주문 상세 — 계좌이체는 접수 즉시, PayPal 은 결제가 완료된 뒤에 이 내용을 보낸다.
  //   조립은 lib/chat-message.js — 고객 입력 칸은 꺾쇠 무력화(견적·문의 알림과 같은 규칙) · 길이 상한(넘으면 긴 고객 글부터 줄인다).
  //   ⚠️ created 는 DB 저장용 UTC 다. 알림에는 한국 시간(접수 시각)으로 보여준다.
  const detail = buildOrderChatDetail({
    orderId, amount, amountUsd, rate: fx.rate, lines,
    buyerName, buyerCompany, buyerEmail, buyerPhone, desiredDate, orderNote,
    needsShipping, shipCountry, shipName, shipPhone, shipZip, shipAddr1, shipAddr2, shipCity, shipState, shipCourierAcct,
    taxInvoice, taxBizName, taxBizNo, taxEmail, inquiryId, locale, receivedKst: nowKst(),
  });

  // 결제 완료 시 같은 내용을 보낼 수 있도록 주문에 저장해 둔다.
  // (결제는 시간이 지난 뒤 다른 경로(웹훅)로 확정될 수 있어, 그 시점에 재구성이 어렵다)
  try {
    await d?.prepare(`UPDATE orders SET chat_detail = ? WHERE id = ?`).bind(detail, orderId).run();
  } catch (e) {
    console.error('[order] 알림 본문 저장 실패(주문은 정상):', e);
  }

  // PayPal 을 고른 주문은 여기서 알리지 않는다 — 결제하지 않고 이탈하는 경우가 많다.
  // 실제 결제가 확정되는 순간(paypal-settle)에 같은 내용이 발송된다.
  const text = payMethod === 'bank'
    ? ['🏦 *새 주문 (국내 · 계좌이체 안내 필요)*', detail].join('\n')
    : '';

  // PayPal 주문(text 비어 있음)은 결제 완료 시 발송되므로 접수 시점에는 보내지 않는다.
  // 전송 실패는 주문 결과에 영향을 주지 않는다(주문은 이미 저장됨) — 로그는 sendChat 이 남긴다.
  // ⚠️ payload(text)에는 주문자 이름·이메일·전화·배송지가 들어있다. 로그에는 주문번호만 남는다.
  if (text) await sendChat(text, { tag: 'order', ref: orderId });

  return json({ ok: true, orderId, amount });
}
