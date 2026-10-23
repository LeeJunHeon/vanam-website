// 구글챗 알림 본문 조립 — 순수 함수.
//
// 왜 파일로 뺐나: 예전에는 이 템플릿이 api/inquiry.ts 안에 인라인으로 있었다.
// 그래서 알림 문구를 확인하려면 **실제로 제출해 실제 채팅방에 메시지를 쏘는 수밖에** 없었고,
// 폼 항목을 늘릴 때마다 담당자 채팅방에 테스트 알림이 쌓였다.
// 순수 함수로 빼두면 node 로 직접 호출해 최종 텍스트를 확인할 수 있다(제출 없음).
//
// ⚠️ .js 인 이유는 material-value.js·quote-fields.js 와 같다 —
//    Astro(.ts)와 node 스크립트가 빌드 없이 같은 파일을 import 해야 한다.
//
// ⚠️ 문구·줄 구성은 옮기기 전과 **바이트 단위로 같아야 한다**. 담당자가 이 형식에 익숙하고,
//    줄이 바뀌면 과거 알림과 대조가 안 된다.

const DASH = '—';

// 고객이 쓴 글을 구글챗 문법으로 해석시키지 않는다 (10-12 점검).
//   구글챗은 꺾쇠 문법을 해석한다 — <users/all>(방 전원 호출) · <https://주소|글자>(다른 주소로 가는 링크).
//   고객이 쓴 칸의 꺾쇠만 전각(＜＞)으로 바꾼다. 꺾쇠가 없는 보통 글은 **바이트 단위로 그대로**다.
//   주문 알림(buildOrderChatDetail)·결제 완료 알림(safeStoredChat)도 같은 규칙을 쓴다(10-23).
const safe = (v) => String(v ?? '').replace(/</g, '＜').replace(/>/g, '＞');
export const chatSafe = safe;

/** 알림 한 통에 싣는 요청 본문 상한(글자) — 넘는 부분은 관리자 화면에서 본다(DB·확인 메일 PDF 에는 전체가 있다) */
export const CHAT_BODY_MAX = 3000;
// 구글챗 메시지 크기 한도 안에 들게 한다 — 넘으면 알림 자체가 실패한다.
const MORE = '\n… (이하 생략 — 관리자 화면에서 전체 보기)';
const clip = (s) => (s.length > CHAT_BODY_MAX ? `${s.slice(0, CHAT_BODY_MAX)}${MORE}` : s);

/**
 * 견적/문의 알림 본문.
 *
 * @param {{
 *   type: 'quote' | 'general',
 *   productName?: string,
 *   product?: string,
 *   who: string,            // "담당: 이름 (회사) · 이메일 · 전화" — 호출부가 만든다
 *   substrate?: string,
 *   sampleCount?: string,
 *   details?: string,
 *   message?: string,
 *   waferLine?: string,
 *   meta: string,           // "접수번호 … · locale · KST"
 *   estimateLine?: string,  // 자동 견적 한 줄(buildEstimateChatLine) — 공정 견적에서 요청 본문 다음·meta 앞
 * }} p
 * @returns {string}
 */
export function buildInquiryChatText(p) {
  if (p.type === 'quote') {
    return [
      '📩 *새 견적 요청*',
      `상품: ${safe(p.productName)} (${safe(p.product)})`,
      safe(p.who),
      `기판: ${safe(p.substrate) || DASH} | 총 샘플: ${safe(p.sampleCount) || DASH}`,
      // ⚠️ 예전 견적 폼의 '두께·수량·납기' 줄은 뺐다. 지금 폼에는 그 항목이 없어서
      //    **항상 `두께: — | 수량: — | 납기: —`** 로만 찍혔다(실제 입력값이 아니다).
      //    같은 정보는 아래 요청 본문에 '총 샘플 수량'·'완료 희망일'로 이미 들어 있다.
      `\n${clip(safe(p.details)) || DASH}`,
      // 값이 없으면 빈 문자열 → filter(Boolean) 에 걸러져 기존 출력과 바이트 단위로 같다
      p.estimateLine ? `\n${p.estimateLine}` : '',
      p.meta,
    ].filter(Boolean).join('\n');
  }
  // 웨이퍼 문의면 상품·수량·다이싱을 별도 줄로 먼저 보여준다(본문에도 같은 내용이 들어 있지만
  // 담당자가 목록에서 한눈에 구분할 수 있어야 한다).
  return ['✉️ *새 문의*', safe(p.who), p.waferLine, `내용: ${clip(safe(p.message))}`, p.meta]
    .filter(Boolean).join('\n');
}

/** 자동 견적 알림 줄에 싣는 담당자 확인 사유 최대 개수 */
export const ESTIMATE_LINE_MAX = 8;

/**
 * 접수 시 자동 견적 한 줄(담당자용). 이 파일은 다른 모듈을 import 하지 않는다 —
 * 담당자 확인 사유 문구(manualAdmin)는 호출부가 quote-customer.js 의 manualLabelAdmin 으로 미리 만든다.
 *
 * @param {{ kind: 'estimate' | 'manual', total?: number | null, seenTotal?: number | null, manualAdmin?: string[] }} p
 * @returns {string}
 */
export function buildEstimateChatLine(p) {
  const won = (n) => `₩${Number(n).toLocaleString('ko-KR')}`;
  if (p.kind === 'estimate') {
    const differs = typeof p.seenTotal === 'number' && p.seenTotal !== p.total;
    return `💰 예상 견적(자동): ${won(p.total)} (부가세 포함 · 확정 전)` + (differs ? ` · 고객 화면 금액 ${won(p.seenTotal)} 과 다름` : '');
  }
  // 사유는 앞 8개까지만 — 단계·분석이 많아도 알림 한 통이 너무 길어지지 않게(나머지는 관리자 화면에서 본다)
  const list = Array.isArray(p.manualAdmin) ? p.manualAdmin : [];
  const shown = list.slice(0, ESTIMATE_LINE_MAX).join(' / ');
  const more = list.length > ESTIMATE_LINE_MAX ? ` 외 ${list.length - ESTIMATE_LINE_MAX}건` : '';
  return `💰 예상 견적(자동): 담당자 확인 필요 — ${shown}${more}`;
}

// ── 주문 알림 ────────────────────────────────────────────────────────────────────
// 새 주문(계좌이체 — 접수 즉시)·PayPal 결제 완료(paypal-settle — orders.chat_detail 을 다시 보냄) 알림의 본문.
// 예전에는 api/order.ts 안에서 템플릿으로 직접 조립했다 — 고객 입력이 꺾쇠 그대로 · 길이 상한 없이 실렸다(10-23).
// ⚠️ 꺾쇠 없는 입력이면 옮기기 전과 **바이트 단위로 같다**(줄 순서·문구·filter(Boolean)) — scripts/test-order-chat.mjs 가 옛 조립과 비교한다.

/** 주문 알림 본문 상한(글자) — CHAT_BODY_MAX 와 같은 기준(구글챗 메시지 크기 한도 안에 들게 한다 — 넘으면 알림 자체가 실패한다) */
export const ORDER_CHAT_MAX = CHAT_BODY_MAX;

/** 앞 n 글자 + '…'(서로게이트 쌍을 가르지 않는다) */
function cutTo(s, n) {
  if (s.length <= n) return s;
  let k = Math.max(0, n - 1);
  if (k > 0 && /[\uD800-\uDBFF]/.test(s[k - 1])) k--;
  return `${s.slice(0, k)}…`;
}

/**
 * 주문 알림 본문(orders.chat_detail 로도 저장된다).
 * 고객 입력 칸은 모두 chatSafe · 서버 값(주문번호·금액·환율·상품 줄·locale·접수 시각)은 그대로.
 * 전체가 ORDER_CHAT_MAX 를 넘으면 요청사항 → 배송 주소 → 세금계산서 순으로 줄이고, 그래도 넘치면 상품 줄을 '외 N건'으로 줄인 뒤
 * 끝에 생략 표시를 붙인다. 주문번호·금액·상품(최소 '외 N건')·주문자·접수 시각 줄은 항상 남는다.
 *
 * @param {{
 *   orderId: string, amount: number, amountUsd: number, rate: number,
 *   lines: { sku: string, name: string, qty: number, subtotal: number, dicing: boolean, dicingFee: number }[],
 *   buyerName: string, buyerCompany?: string, buyerEmail: string, buyerPhone?: string,
 *   desiredDate?: string, orderNote?: string,
 *   needsShipping: boolean, shipCountry?: string, shipName?: string, shipPhone?: string, shipZip?: string,
 *   shipAddr1?: string, shipAddr2?: string, shipCity?: string, shipState?: string, shipCourierAcct?: string,
 *   taxInvoice: boolean, taxBizName?: string, taxBizNo?: string, taxEmail?: string,
 *   inquiryId?: string, locale: string, receivedKst: string,
 * }} p
 * @returns {string}
 */
export function buildOrderChatDetail(p) {
  const won = (n) => Number(n).toLocaleString('ko-KR');
  const rate = Number(p.rate);
  // 다이싱 표기는 웨이퍼 줄에만 붙인다 (다른 상품에는 존재하지 않는 옵션이라 '불필요'가 정보를 주지 않는다).
  const productLines = (p.lines ?? []).map((l) => {
    const dice = !String(l.sku).startsWith('wafer:')
      ? ''
      : l.dicing
        ? ` · 다이싱: 필요 (+₩${won(l.dicingFee)}/박스 × ${l.qty})`
        : ' · 다이싱: 불필요';
    return `· ${l.name} × ${l.qty} = ₩${won(l.subtotal)} (≈ $${(l.subtotal / rate).toFixed(2)})${dice}`;
  });
  // 줄이기 대상(고객 글) — 접두어는 그대로 두고 내용만 줄인다
  const note = { pre: '요청사항: ', body: p.orderNote ? safe(p.orderNote) : '' };
  const ship = p.needsShipping
    ? { pre: `배송[${safe(p.shipCountry)}]: `, body: `${safe(p.shipName)} · ${safe(p.shipPhone)}\n  (${safe(p.shipZip)}) ${[p.shipAddr1, p.shipAddr2, p.shipCity, p.shipState].filter(Boolean).map(safe).join(', ')}` }
    : null;
  const tax = p.taxInvoice ? { pre: '📄 세금계산서 요청 — ', body: `${safe(p.taxBizName)} (${safe(p.taxBizNo)}) → ${safe(p.taxEmail)}` } : null;
  let shown = productLines.length; // 보일 상품 줄 수(나머지는 '외 N건')

  const assemble = (more) => [
    `주문번호: ${p.orderId}`,
    `금액: ₩${won(p.amount)} (≈ $${Number(p.amountUsd).toFixed(2)} USD · 환율 ${Math.round(rate).toLocaleString('ko-KR')})`,
    ...productLines.slice(0, shown),
    shown < productLines.length ? `· 외 ${productLines.length - shown}건` : '',
    `주문자: ${safe(p.buyerName)}${p.buyerCompany ? ` (${safe(p.buyerCompany)})` : ''} · ${safe(p.buyerEmail)}${p.buyerPhone ? ` · ${safe(p.buyerPhone)}` : ''}`,
    p.desiredDate ? `희망 완료: ${safe(p.desiredDate)}` : '',
    note.body ? note.pre + note.body : '',
    ship ? ship.pre + ship.body : '배송 없음 (분석 서비스)',
    p.shipCourierAcct ? `택배사 계정(착불): ${safe(p.shipCourierAcct)}` : '',
    tax ? tax.pre + tax.body : '세금계산서: 미요청',
    p.inquiryId ? `견적: ${safe(p.inquiryId)}` : '',
    // 이 본문은 결제 완료 알림에도 그대로 재사용되므로 '접수' 라고 못 박아 결제 시각으로 오해하지 않게 한다.
    `(${p.locale} · 접수 ${p.receivedKst} KST)`,
  ].filter(Boolean).join('\n') + (more ? MORE : '');

  let out = assemble(false);
  if (out.length <= ORDER_CHAT_MAX) return out;
  // 넘침 — 요청사항 → 배송 주소 → 세금계산서 순으로 넘친 만큼 줄인다(생략 표시 길이까지 계산)
  for (const part of [note, ship, tax]) {
    if (!part || !part.body) continue;
    const over = assemble(true).length - ORDER_CHAT_MAX;
    if (over <= 0) break;
    part.body = cutTo(part.body, Math.max(1, part.body.length - over));
  }
  // 그래도 넘치면 상품 줄을 뒤에서부터 줄인다('외 N건')
  while (assemble(true).length > ORDER_CHAT_MAX && shown > 0) shown--;
  out = assemble(true);
  // 마지막 안전장치(주문자 줄 등 남겨야 할 줄만으로도 넘는 비정상 입력) — 상한에서 자른다
  return out.length <= ORDER_CHAT_MAX ? out : cutTo(out, ORDER_CHAT_MAX - MORE.length) + MORE;
}

/**
 * 저장해 둔 알림 본문을 다시 보낼 때(결제 완료 — orders.chat_detail) — 꺾쇠 무력화 + 상한 자르기.
 * 옛 주문(10-23 전 저장, 꺾쇠·길이 그대로)의 본문도 안전하게 만든다. 두 번 적용해도 같다.
 * @param {unknown} text @returns {string}
 */
export function safeStoredChat(text) {
  const s = safe(text);
  return s.length <= ORDER_CHAT_MAX ? s : cutTo(s, ORDER_CHAT_MAX - MORE.length) + MORE;
}
