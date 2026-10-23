// scripts/test-order-chat.mjs — 주문 구글챗 알림 본문(src/lib/chat-message.js buildOrderChatDetail · safeStoredChat) 테스트
//
//   ① 꺾쇠 없는 보통 주문이면 옮기기 전 api/order.ts 의 조립(아래 OLD — 고정 사본)과 **바이트 단위로 같다**
//   ② 고객 입력의 꺾쇠(<users/all> · <주소|글자>)는 전각으로 — 상품·금액 줄은 그대로
//   ③ 길이 상한(ORDER_CHAT_MAX) — 요청사항 → 배송 주소 → 세금계산서 순으로 줄이고, 상품 줄이 많으면 '외 N건'
//   ④ safeStoredChat — 옛 본문의 꺾쇠 · 두 번 적용해도 같음
//   ⑤ api/order.ts 오류 응답에 내부 메시지(detail)가 없다 · 결제 완료 알림이 safeStoredChat 을 거친다(정적 검사)
// 네트워크 없이 돈다. 주문은 가짜.
import { readFileSync } from 'node:fs';
import { buildOrderChatDetail, safeStoredChat, chatSafe, ORDER_CHAT_MAX, CHAT_BODY_MAX } from '../src/lib/chat-message.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}

// ── 옮기기 전 api/order.ts(c8577e8) 의 조립 — 고정 사본(바꾸지 않는다) ─────────────────
function OLD(p) {
  const { orderId, amount, amountUsd, lines, buyerName, buyerCompany, buyerEmail, buyerPhone, desiredDate, orderNote,
    needsShipping, shipCountry, shipName, shipPhone, shipZip, shipAddr1, shipAddr2, shipCity, shipState, shipCourierAcct,
    taxInvoice, taxBizName, taxBizNo, taxEmail, inquiryId, locale } = p;
  const fx = { rate: p.rate };
  const nowKst = () => p.receivedKst;
  return [
    `주문번호: ${orderId}`,
    `금액: ₩${amount.toLocaleString('ko-KR')} (≈ $${amountUsd.toFixed(2)} USD · 환율 ${Math.round(fx.rate).toLocaleString('ko-KR')})`,
    ...lines.map((l) => {
      const dice = !l.sku.startsWith('wafer:')
        ? ''
        : l.dicing
          ? ` · 다이싱: 필요 (+₩${l.dicingFee.toLocaleString('ko-KR')}/박스 × ${l.qty})`
          : ' · 다이싱: 불필요';
      return `· ${l.name} × ${l.qty} = ₩${l.subtotal.toLocaleString('ko-KR')} (≈ $${(l.subtotal / fx.rate).toFixed(2)})${dice}`;
    }),
    `주문자: ${buyerName}${buyerCompany ? ` (${buyerCompany})` : ''} · ${buyerEmail}${buyerPhone ? ` · ${buyerPhone}` : ''}`,
    desiredDate ? `희망 완료: ${desiredDate}` : '',
    orderNote ? `요청사항: ${orderNote}` : '',
    needsShipping
      ? `배송[${shipCountry}]: ${shipName} · ${shipPhone}\n  (${shipZip}) ${[shipAddr1, shipAddr2, shipCity, shipState].filter(Boolean).join(', ')}`
      : '배송 없음 (분석 서비스)',
    shipCourierAcct ? `택배사 계정(착불): ${shipCourierAcct}` : '',
    taxInvoice ? `📄 세금계산서 요청 — ${taxBizName} (${taxBizNo}) → ${taxEmail}` : '세금계산서: 미요청',
    inquiryId ? `견적: ${inquiryId}` : '',
    `(${locale} · 접수 ${nowKst()} KST)`,
  ].filter(Boolean).join('\n');
}

// ── 가짜 주문들 ─────────────────────────────────────────────────────────────────
const LINES = [
  { sku: 'wafer:si-4in', name: '실리콘 웨이퍼 4인치', qty: 2, subtotal: 300000, dicing: true, dicingFee: 50000 },
  { sku: 'wafer:sapphire', name: '사파이어 웨이퍼', qty: 1, subtotal: 120000, dicing: false, dicingFee: 0 },
  { sku: 'target-ti', name: 'Ti 타깃', qty: 3, subtotal: 450000, dicing: false, dicingFee: 0 },
];
const BASE = {
  orderId: 'ORD-20261023-AB12', amount: 870000, amountUsd: 621.43, rate: 1400.0, lines: LINES,
  buyerName: '홍길동', buyerCompany: '테스트대학교', buyerEmail: 'hong@example.com', buyerPhone: '010-0000-0000',
  desiredDate: '11월 말', orderNote: '포장 꼼꼼히 부탁드립니다.\n두 번째 줄',
  needsShipping: true, shipCountry: 'KR', shipName: '홍길동', shipPhone: '010-0000-0000', shipZip: '06000',
  shipAddr1: '서울시 강남구 테헤란로 1', shipAddr2: '101호', shipCity: '', shipState: '', shipCourierAcct: '',
  taxInvoice: true, taxBizName: '(주)테스트', taxBizNo: '123-45-67890', taxEmail: 'tax@example.com',
  inquiryId: '', locale: 'ko', receivedKst: '2026-10-23 10:00',
};
const CASES = {
  '국내·계좌이체·세금계산서': BASE,
  '해외·PayPal·택배 계정·세금계산서 없음': { ...BASE, locale: 'en', buyerCompany: '', shipCountry: 'US', shipCity: 'Boston', shipState: 'MA',
    shipZip: '02115', shipAddr1: '1 Main St', shipAddr2: '', shipCourierAcct: 'FedEx 123456', taxInvoice: false, taxBizName: '', taxBizNo: '', taxEmail: '',
    desiredDate: '', orderNote: '', amountUsd: 0.5, rate: 1385.62 },
  '배송 없음(분석)': { ...BASE, needsShipping: false, shipCountry: '', shipName: '', shipPhone: '', shipZip: '', shipAddr1: '', shipAddr2: '', lines: [LINES[2]] },
  '견적번호 있음·전화 없음': { ...BASE, inquiryId: 'INQ-20261001-ZZ99', buyerPhone: '' },
  '기타 국가 직접 입력·주소 일부': { ...BASE, shipCountry: 'Republic of Testland', shipAddr2: '', shipCity: 'Testville', taxInvoice: false },
};

// ① 바이트 동일
for (const [label, p] of Object.entries(CASES)) {
  const a = buildOrderChatDetail(p);
  const b = OLD(p);
  eq(`바이트 동일: ${label}`, Buffer.compare(Buffer.from(a), Buffer.from(b)), 0);
}

// ② 꺾쇠 무력화
{
  const p = { ...BASE, buyerName: '<users/all>', buyerCompany: '<users/all> 회사', orderNote: '<https://evil.example|입금 계좌 확인>',
    shipAddr1: '<https://x.example|주소>', shipName: 'a<b>c', taxBizName: '<users/all>(주)', taxEmail: '<t@x.y>', desiredDate: '<내일>',
    shipCourierAcct: '<acct>', shipCountry: 'Other <land>', shipZip: '<1>' };
  const out = buildOrderChatDetail(p);
  eq('꺾쇠: 출력에 < > 없음', [out.includes('<'), out.includes('>')], [false, false]);
  eq('꺾쇠: 전각으로 바뀌어 남음', [out.includes('주문자: ＜users/all＞ (＜users/all＞ 회사)'), out.includes('요청사항: ＜https://evil.example|입금 계좌 확인＞'),
    out.includes('📄 세금계산서 요청 — ＜users/all＞(주)')], [true, true, true]);
  const lines = out.split('\n');
  eq('꺾쇠: 주문번호·금액·상품 줄은 그대로', [lines[0], lines[1], lines[2], lines[3], lines[4]], OLD(BASE).split('\n').slice(0, 5));
}

// ③ 길이 상한 — 모든 칸 최대 길이(order.ts 의 slice 상한)
const MAXED = {
  ...BASE,
  buyerName: '가'.repeat(500), buyerCompany: 'C'.repeat(500), buyerEmail: `${'e'.repeat(480)}@example.com`, buyerPhone: '1'.repeat(500),
  desiredDate: 'D'.repeat(120), orderNote: '요'.repeat(2000), shipCountry: 'Q'.repeat(60), shipName: 'N'.repeat(500), shipPhone: '2'.repeat(500),
  shipZip: 'Z'.repeat(20), shipAddr1: '주'.repeat(500), shipAddr2: '소'.repeat(500), shipCity: 'Y'.repeat(500), shipState: 'S'.repeat(500),
  shipCourierAcct: 'K'.repeat(60), taxBizName: '상'.repeat(500), taxBizNo: '9'.repeat(20), taxEmail: `${'t'.repeat(480)}@example.com`,
};
{
  const out = buildOrderChatDetail(MAXED);
  const L = out.split('\n');
  eq('최대 길이: 상한 이하', out.length <= ORDER_CHAT_MAX, true);
  eq('최대 길이: 주문번호·금액·상품 3줄·주문자·접수 시각 줄 남음 · 생략 표시',
    [L[0], L[1].startsWith('금액: ₩870,000'), L.slice(2, 5), L.some((x) => x === `주문자: ${MAXED.buyerName} (${MAXED.buyerCompany}) · ${MAXED.buyerEmail} · ${MAXED.buyerPhone}`),
      L.includes('(ko · 접수 2026-10-23 10:00 KST)'), out.endsWith('\n… (이하 생략 — 관리자 화면에서 전체 보기)')],
    [`주문번호: ${BASE.orderId}`, true, OLD(BASE).split('\n').slice(2, 5), true, true, true]);
  eq('최대 길이: 요청사항부터 줄임(줄 머리는 남음)', [L.some((x) => x.startsWith('요청사항: ') && x.endsWith('…')), L.some((x) => x.startsWith('배송[')), L.some((x) => x.startsWith('📄 세금계산서 요청 — '))], [true, true, true]);
  // 요청사항만 길면 요청사항만 줄고 배송·세금계산서는 그대로
  const p2 = { ...BASE, orderNote: '요'.repeat(5000) };
  const o2 = buildOrderChatDetail(p2);
  const old2 = OLD(BASE).split('\n');
  eq('요청사항만 길 때: 상한 이하 · 배송·세금계산서 줄 그대로', [o2.length <= ORDER_CHAT_MAX, o2.includes(old2.find((x) => x.startsWith('배송['))), o2.includes(old2.find((x) => x.startsWith('📄')))], [true, true, true]);
  // 상한 바로 아래는 자르지 않는다
  const pad = ORDER_CHAT_MAX - OLD({ ...BASE, orderNote: '' }).length - '\n요청사항: '.length;
  const p3 = { ...BASE, orderNote: 'x'.repeat(pad) };
  eq('상한 딱 맞음: 자르지 않음(옛 조립과 같음)', [buildOrderChatDetail(p3).length, buildOrderChatDetail(p3) === OLD(p3)], [ORDER_CHAT_MAX, true]);
}
// 상품 줄이 매우 많음
{
  const many = Array.from({ length: 50 }, (_, i) => ({ sku: `wafer:w${i}`, name: `아주 긴 이름의 웨이퍼 상품 ${'가'.repeat(30)} ${i}`, qty: 99, subtotal: 9900000, dicing: true, dicingFee: 100000 }));
  const out = buildOrderChatDetail({ ...MAXED, lines: many });
  const L = out.split('\n');
  const more = L.find((x) => /^· 외 \d+건$/.test(x));
  const shown = L.filter((x) => x.startsWith('· 아주 긴 이름')).length;
  eq('상품 많음: 상한 이하 · 외 N건(보인 줄 + N = 50) · 주문자·접수 시각 남음',
    [out.length <= ORDER_CHAT_MAX, Boolean(more), shown + Number(/(\d+)/.exec(more ?? '0')[1]), L.some((x) => x.startsWith('주문자: ')), L.includes('(ko · 접수 2026-10-23 10:00 KST)')],
    [true, true, 50, true, true]);
}

// ④ safeStoredChat
{
  const oldStored = OLD({ ...BASE, buyerName: '<users/all>', orderNote: '<https://evil.example|입금 계좌 확인>' });
  const s1 = safeStoredChat(oldStored);
  eq('safeStoredChat: 꺾쇠 없음 · 두 번 적용해도 같음 · 꺾쇠 없는 본문은 그대로', [s1.includes('<') || s1.includes('>'), safeStoredChat(s1) === s1, safeStoredChat(OLD(BASE)) === OLD(BASE)], [false, true, true]);
  const long = `<users/all>${'x'.repeat(10000)}`;
  const s2 = safeStoredChat(long);
  eq('safeStoredChat: 긴 옛 본문 → 상한 이하 · 생략 표시 · 두 번 적용해도 같음', [s2.length <= ORDER_CHAT_MAX, s2.endsWith('관리자 화면에서 전체 보기)'), safeStoredChat(s2) === s2, s2.startsWith('＜users/all＞')], [true, true, true, true]);
  eq('safeStoredChat: 빈 값', [safeStoredChat(''), safeStoredChat(null)], ['', '']);
  eq('chatSafe · 상한 기준', [chatSafe('<a>'), ORDER_CHAT_MAX === CHAT_BODY_MAX], ['＜a＞', true]);
}

// ⑤ 정적 검사 — order.ts · paypal-settle.ts
{
  const order = readFileSync('src/pages/api/order.ts', 'utf8');
  const settle = readFileSync('src/lib/paypal-settle.ts', 'utf8');
  eq('order.ts: 오류 응답에 detail 없음 · server_error 500', [/error:\s*'server_error'\s*,\s*detail/.test(order), /json\(\{ ok: false, error: 'server_error' \}, 500\)/.test(order), /err\??\.message/.test(order)], [false, true, false]);
  eq('order.ts: 알림 본문은 buildOrderChatDetail 로만(템플릿 직접 조립 없음)', [/buildOrderChatDetail\(\{/.test(order), /`주문자: \$\{/.test(order), /`요청사항: \$\{/.test(order)], [true, false, false]);
  eq('paypal-settle: 결제 완료 알림의 저장 본문은 safeStoredChat 을 거친다', /const detail = safeStoredChat\(String\(row\.chat_detail/.test(settle), true);
}

if (failed) {
  console.error(`\n주문 알림 본문 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 주문 알림 본문(buildOrderChatDetail·safeStoredChat) — ${total}건 통과 · 옛 조립과 바이트 동일 ${Object.keys(CASES).length}종 · 꺾쇠 무력화 · 상한 ${ORDER_CHAT_MAX}자 · 오류 응답 detail 없음`);
