// scripts/test-quote-doc.mjs — 서류 HTML(src/lib/doc-excel.js) 테스트: 견적서 · 견적 요청서 · 주문서
//
//   ① 공통 틀 — 엑셀 「견적서」 배치(공급자 칸 글자·5줄 칸·정보 칸·합계 줄·품목표), 스크립트·자동 인쇄 없음, 이스케이프
//   ② 견적서 — 예상 견적 표시는 견적번호 줄 오른쪽 글자(상자 없음) · 확정은 표시·안내 없음 · 영문 · 달러
//   ③ 금액만 있는 예전 견적 → 품목 1줄(공급가액 + 세액 = 금액)
//   ④ 견적 요청서 — 접수 전/후 · 공정 · 웨이퍼 · 옛 접수 건 · 영문
//   ⑤ 주문서 — 다이싱 별도 줄 · 합계 · 결제 칸 · 영문
//   ⑥ 칸 맞춤(fitCells) — 가짜 DOM 으로 줄이기·줄바꿈 규칙
// 회사 정보는 가짜(실제 사업자 정보를 테스트에 쓰지 않는다). 공급자 칸 고정 글자(SUPPLIER_DOC_KO)는 엑셀 그대로인지 따로 확인한다.
import {
  buildQuoteHtml, buildRequestHtml, buildOrderHtml, quoteFromAmount, requestDocFrom, orderDocFrom, fitCells,
  SUPPLIER_DOC_KO, dateKr, dateEn, money, usd, telKr, telDisplay, ymdLocal, koreanAmount,
} from '../src/lib/doc-excel.js';
import { koreanAmount as engineKorean } from '../src/lib/quote-engine.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}
const HANGUL = /[가-힣ㄱ-ㆎ]/g;
const hangulOf = (h) => (h.match(HANGUL) ?? []).join('');
const tbodyRows = (h) => ((/<tbody>([\s\S]*?)<\/tbody>/.exec(h)?.[1] ?? '').match(/<tr /g) ?? []).length;
const has = (h, ...ws) => ws.every((w) => h.includes(w));

const FAKE = { bizNo: '000-00-00000', nameKo: '가짜상사', nameEn: 'Fake Co.', ceoKo: '홍길동', ceoEn: 'Gil-dong Hong',
  addressKo: '서울시 어딘가 1', addressEn: '1 Somewhere, Seoul', tel: '+82-2-0000-0000', email: 'fake@example.com' };
const LOGO = 'http://x/logo-light.png';

// ── ① 공통 틀(견적서로 본다) ───────────────────────────────────────────────────────────
const info = { customer: '테스트대학 홍길동', ref: '참조 <x>', title: 'Multilayers', date: '2026-01-10', quoteNo: 'INQ-20260101-TEST',
  manager: '담당', contact: '02-0000-0000', delivery: '계약 후 협의', validDays: '7', payment: '계좌이체' };
const item = (n) => ({ name: `품목 ${n}`, spec: `규격 ${n}\n둘째 줄`, qty: n, unit: '회', unitPrice: 1000 * n, supply: 1000 * n, vat: 100 * n });
const TWO = { info, items: [item(1), null, item(3)], supply: 4000, vat: 400, total: 4400, totalKorean: '사천사백', logoUrl: LOGO };
{
  const h = buildQuoteHtml(TWO, FAKE);
  eq('견적서: html lang·title·제목', has(h, '<html lang="ko">', '<title>견적서 INQ-20260101-TEST</title>', '<td class="title">견적서</td>'), true);
  eq('견적서: 귀하·참조(이스케이프)', h.includes('<td class="to">테스트대학 홍길동 귀하\n참조 : 참조 &lt;x&gt;</td>'), true);
  eq('견적서: 날짜 엑셀 형식', h.includes('<td class="date">2026년 1월 10일</td>'), true);
  eq('견적서: 로고 = 넘긴 주소', h.includes(`<img src="${LOGO}" alt="VanaM">`), true);
  eq('공급자 칸: 세로 라벨·사업자번호(회사 정보)', has(h, '공<br>급<br>자', '>000-00-00000<'), true);
  eq('공급자 칸: 엑셀 글자(상호·대표자 (인)·소재지·업태·종목)', has(h, '>반암주식회사<', '<span>한 수 덕</span><span>(인)</span>',
    '>서울특별시 영등포구 도신로4길 21-1, 반암<', '제조업,\n과학기술서비스업', '기타 반도체 소자 및 장비,\n공학연구개발, 엔지니어링'), true);
  eq('공급자 칸: company.json 한글 표기는 쓰지 않는다', [h.includes('가짜상사'), h.includes('(대림동)')], [false, false]);
  eq('공급자 칸: 담당자·연락처는 넣은 값(줄바꿈 허용 .fitw)', has(h, '<td class="s10 fitw">담당</td>', '<td class="s10 fitw">02-0000-0000</td>'), true);
  eq('공급자 칸: 고정 글자·라벨은 한 줄 맞춤(.fit)', has(h, '<th class="s10 fit">사업자번호</th>', '<td class="s9 fit">제조업,'), true);
  eq('정보 칸 4줄 + 유효기간 문장', has(h, '>견 적 명<', '>Multilayers<', '>납품기한<', '>대금 지불방식<', '>견적 유효기간<', '견적일로부터 7 일간'), true);
  eq('합계 줄: 일금 · 한글(밑줄) · 원정 · ₩ · 금액', /일금<\/td><td class="nob r"><span class="u">사천사백<\/span><\/td><td class="nob">원정<\/td><td class="nob">₩<\/td><td class="nob r">4,400<\/td>/.test(h), true);
  eq('품목표: 머리 6칸 · 최종 합계', has(h, '<th>품명</th>', '<th>규격/사양</th>', '<th>수량</th>', '<th>단가</th>', '<th>공급가액</th>', '<th>세액</th>', '>최종 합계<'), true);
  eq('품목표: 15줄 고정(빈 줄 포함) · 줄바꿈 칸', [tbodyRows(h), h.includes('<td class="t">규격 1\n둘째 줄</td>')], [15, true]);
  eq('품목표: 수량 = 수 + 단위', h.includes('<td class="c">3 회</td>'), true);
  eq('문서 안 스크립트·자동 인쇄 없음', [/<script/i.test(h), /\.print\(\)/.test(h)], [false, false]);
  eq('버튼(창을 연 쪽이 연결)', has(h, 'id="vn-doc-print"', 'id="vn-doc-close"', '인쇄 / PDF 저장', '>닫기<'), true);
  eq('A4 · Arial · 굵은 바깥 선', has(h, '@page{size:A4 portrait;margin:10mm}', 'font-family:Arial', '.box{border:2px solid #000}'), true);
  const many = buildQuoteHtml({ ...TWO, items: Array.from({ length: 16 }, (_, k) => item(k + 1)) }, FAKE);
  eq('품목표: 엑셀처럼 최대 15줄', tbodyRows(many), 15);
}
eq('SUPPLIER_DOC_KO = 엑셀 공급자 칸 글자', SUPPLIER_DOC_KO, {
  name: '반암주식회사', ceo: '한 수 덕', address: '서울특별시 영등포구 도신로4길 21-1, 반암',
  bizType: '제조업,\n과학기술서비스업', bizItem: '기타 반도체 소자 및 장비,\n공학연구개발, 엔지니어링',
});

// ── ② 예상·확정 표시 ──────────────────────────────────────────────────────────────────
{
  const est = buildQuoteHtml({ ...TWO, stamp: '예상 견적 · 확정 전', note: '안내 <b>', fxNote: '참고 $1.00' }, FAKE);
  eq('예상: 견적번호 줄 오른쪽 굵은 글자', est.includes('<div class="r7"><span>견적번호 : INQ-20260101-TEST</span><span class="mark">예상 견적 · 확정 전</span></div>'), true);
  eq('예상: 상자(.stamp) 없음', est.includes('stamp'), false);
  eq('예상: 안내는 품목표 아래 작은 글씨(참고 줄 먼저, 이스케이프)', est.includes('<p class="note">참고 $1.00\n안내 &lt;b&gt;</p>'), true);
  const conf = buildQuoteHtml({ ...TWO, stamp: '', note: '', fxNote: '' }, FAKE);
  eq('확정: 표시·안내 없음(엑셀과 같음)', [conf.includes('<span class="mark"></span>'), conf.includes('class="note"')], [true, false]);
}

// ── ② 영문·달러 ───────────────────────────────────────────────────────────────────────
const ASCII_INFO = { customer: 'Test Univ. Jane Doe', ref: '', title: 'Multilayers', date: '2026-09-29', quoteNo: 'INQ-20260929-TEST',
  manager: '', contact: '+82-2-0000-0000', delivery: '', validDays: '14', payment: '' };
const ASCII_ITEMS = [{ name: 'Sputter Ti/Pt', spec: 'Ti 10 nm\nPt 45 nm', qty: 1, unit: '회', unitPrice: 1000, supply: 1000, vat: 100 },
  { name: 'ALD HfO2', spec: 'HfO2 5 nm', qty: 2, unit: '회', unitPrice: 2000, supply: 4000, vat: 400 }];
const EN = { info: ASCII_INFO, items: ASCII_ITEMS, supply: 5000, vat: 500, total: 5500, totalKorean: '오천오백', logoUrl: LOGO,
  lang: 'en', stamp: 'ESTIMATE — NOT FINAL', note: 'This is an estimate.', fxNote: 'USD equivalent (reference): $4.00' };
{
  const h = buildQuoteHtml(EN, FAKE);
  eq('영문 견적서 한글 0자(ASCII 입력)', hangulOf(h), '');
  eq('영문: lang·title·제목', has(h, '<html lang="en">', '<title>Quotation INQ-20260929-TEST</title>', '>QUOTATION<'), true);
  eq('영문: To·Attn(참조 없으면 생략)·날짜·번호', [h.includes('To: Test Univ. Jane Doe'), h.includes('Attn:'), h.includes('Sep 29, 2026'), h.includes('Quote No. : INQ-20260929-TEST')], [true, false, true, true]);
  eq('영문: 공급자 칸(세로 Supplier · 영문 회사 정보)', has(h, '<span class="vt">Supplier</span>', '>Reg. No.<', '>Fake Co.<', '>CEO<', '>Gil-dong Hong<', '>1 Somewhere, Seoul<', '>Contact<'), true);
  eq('영문: 표시 = 견적번호 줄 오른쪽', h.includes('<span class="mark">ESTIMATE — NOT FINAL</span>'), true);
  eq('영문: 빈 납기·결제조건 → To be confirmed', (h.match(/To be confirmed/g) ?? []).length, 2);
  eq('영문: 유효기간 문장 · 합계 ₩(한글 금액 없음)', has(h, 'Valid for 14 days from the quote date', 'Total amount\n(supply + VAT)', '₩5,500'), true);
  eq('영문: 품목 머리·단위 run(s)', has(h, '<th>Item</th>', '<th>Supply amount</th>', '<th>VAT</th>', '>1 run<', '>2 runs<', '>Total<'), true);
  eq('영문: 버튼', has(h, 'Print / Save as PDF', '>Close<'), true);
  const u = buildQuoteHtml({ ...TWO, currency: 'USD', items: [{ name: 'A', spec: '', qty: 1, unit: '식', unitPrice: 238.18, supply: 238.18, vat: 23.82 }],
    supply: 238.18, vat: 23.82, total: 262 }, FAKE);
  eq('달러 견적: $ 표기 · 한글 금액 줄 없음', [u.includes('$262.00'), u.includes('$238.18'), u.includes('일금'), u.includes('원정')], [true, true, false, false]);
}

// ── ③ 금액만 있는 예전 견적 → 품목 1줄 ───────────────────────────────────────────────────
{
  const q = quoteFromAmount({ lang: 'ko', id: 'INQ-1', date: '2026-10-01', customer: '테스트대학 홍길동', title: '금속 박막',
    spec: 'Sputter · Silicon / 4 inch', amount: 188100, bank: '은행 000-000 (가짜)', memo: '메모 <b>', contact: '02-0000-0000' });
  eq('KRW: 공급가액 = 금액÷1.1 반올림, 세액 = 나머지', [q.supply, q.vat, q.total, q.supply + q.vat], [171000, 17100, 188100, 188100]);
  eq('KRW: 품목 1줄(요청 상품 · 1식)', q.items, [{ name: '금속 박막', spec: 'Sputter · Silicon / 4 inch', qty: 1, unit: '식', unitPrice: 171000, supply: 171000, vat: 17100 }]);
  eq('KRW: 한글 금액 · 대금 지불방식(입금 계좌) · 메모 → 안내 · 표시 없음', [q.totalKorean, q.info.payment, q.note, q.stamp], ['일십팔만팔천일백', '계좌이체 (은행 000-000 (가짜))', '메모 <b>', '']);
  const h = buildQuoteHtml({ ...q, logoUrl: LOGO }, FAKE);
  eq('KRW: 견적서에 그대로', has(h, '<td class="c">1 식</td>', '>171,000<', '>17,100<', '일십팔만팔천일백', '메모 &lt;b&gt;'), true);
  const u = quoteFromAmount({ lang: 'en', id: 'INQ-2', date: '2026-10-01', customer: 'Jane', title: 'Metals', spec: 'Sputter', amount: 262, currency: 'USD', bank: 'Bank 1' });
  eq('USD: 센트 단위로 나눔 · 합 = 금액 · 한글 금액 없음', [u.supply, u.vat, Math.round((u.supply + u.vat) * 100) / 100, u.totalKorean, u.currency], [238.18, 23.82, 262, '', 'USD']);
  eq('USD 영문: 대금 지불방식 · 단위 lot', [u.info.payment, buildQuoteHtml({ ...u, logoUrl: LOGO }, FAKE).includes('>1 lot<')], ['Bank transfer (Bank 1)', true]);
  // 합이 항상 맞는지 — 여러 금액
  let bad = 0;
  for (let a = 1; a < 3000000; a += 7919) {
    const k = quoteFromAmount({ lang: 'ko', amount: a });
    if (k.supply + k.vat !== a || k.vat < 0) bad++;
    const d = quoteFromAmount({ lang: 'en', amount: a / 100, currency: 'USD' });
    if (Math.round((d.supply + d.vat) * 100) !== Math.round(a)) bad++;
  }
  eq('공급가액 + 세액 = 금액(원화·달러 여러 값)', bad, 0);
}

// ── ④ 견적 요청서 ──────────────────────────────────────────────────────────────────────
const DJ = {
  v: 1, seq: [{ step: 1, process: 'Sputter', material: 'Ti', value: '10', unit: 'nm', etc: '' },
    { step: 2, process: 'Annealing', material: 'N2', value: '60', unit: 'min', etc: '400 °C' }],
  measures: ['XPS', 'XRD'], delivery: 'direct', substrateType: 'Silicon', substrateSize: '4inch', substrateGrade: 'Prime',
  sampleCount: '5', preFilm: true, preFilmNote: 'SiO2 300 nm', completionDate: '2026-11-01', notes: '요청 <메모>', ship: null,
};
const SIZE = { '4inch': '4 inch' };
const DELIV_KO = { direct: '방문 전달' };
const REQ_KO = { company: '테스트대학', name: '홍길동', phone: '010-0000-0000', email: 'a@example.com' };
{
  const draft = requestDocFrom({ lang: 'ko', draft: true, date: '2026-10-01', requester: REQ_KO, product: '금속 박막', dj: DJ,
    sizeMap: SIZE, deliveryMap: DELIV_KO, supportEmail: 'hello@example.com' });
  eq('요청서 데이터: 공정 → 표 줄(수치 + 단위)', draft.steps, [
    { process: 'Sputter', material: 'Ti', value: '10 nm', etc: '' }, { process: 'Annealing', material: 'N2', value: '60 min', etc: '400 °C' }]);
  eq('요청서 데이터: 정보 칸(기판 지도 · 박막 있음+메모 · 분석 · 요청 사항)', draft.info, [
    ['기     판', 'Silicon / 4 inch / Prime'], ['박막 증착 여부', '있음 — SiO2 300 nm'], ['분석 요청', 'XPS, XRD'], ['요청 사항', '요청 <메모>']]);
  eq('요청서 데이터: 샘플 수량 · 전달(지도) · 완료 희망', [draft.qty, draft.delivery, draft.due, draft.kind], ['5', '방문 전달', '2026-11-01', 'process']);
  const h = buildRequestHtml({ ...draft, logoUrl: LOGO });
  eq('요청서(접수 전): 제목·귀중·세로 요청자', has(h, '<title>견적 요청서 2026-10-01</title>', '>견적 요청서<', '반암주식회사 귀중', '요<br>청<br>자'), true);
  eq('요청서(접수 전): 접수번호 자리 · 오른쪽 접수 전', h.includes('<span>접수번호 : (아직 보내지 않은 요청서)</span><span class="mark">접수 전</span>'), true);
  eq('요청서(접수 전): 안내에 받는 메일', h.includes('hello@example.com 로 보내 주시거나'), true);
  eq('요청서: 요청자 칸 값', has(h, '>테스트대학<', '>홍길동<', '>010-0000-0000<', '>a@example.com<', '>금속 박막<', '>방문 전달<', '>2026-11-01<'), true);
  eq('요청서: 표 머리 · 단계 번호 가운데 · 최소 10줄', [has(h, '<th>단계</th>', '<th>물질 · 가스</th>', '<th>두께 · 시간</th>', '<td class="c">2</td>', '>60 min<'), tbodyRows(h)], [true, 10]);
  eq('요청서: 이스케이프 · 스크립트 없음', [h.includes('요청 &lt;메모&gt;'), /<script/i.test(h)], [true, false]);
  const many = buildRequestHtml({ ...draft, steps: Array.from({ length: 34 }, () => draft.steps[0]), logoUrl: LOGO });
  eq('요청서: 단계가 많으면 그만큼 늘어난다(2쪽은 표 머리 반복 — thead)', [tbodyRows(many), many.includes('<thead>')], [34, true]);

  const done = requestDocFrom({ lang: 'ko', id: 'INQ-20261001-TEST', date: '2026-10-01', statusText: '접수됨 (검토 대기)', requester: REQ_KO,
    product: '금속 박막', dj: { ...DJ, preFilm: false, ship: { country: '대한민국', name: '수령인', phone: '010', zip: '00000', addr: '주소 1', memo: '문 앞' } },
    sizeMap: SIZE, deliveryMap: DELIV_KO });
  const hd = buildRequestHtml({ ...done, logoUrl: LOGO });
  eq('요청서(접수 후): 번호 · 상태 표시 · 접수 안내', has(hd, '<title>견적 요청서 INQ-20261001-TEST</title>', '<span>접수번호 : INQ-20261001-TEST</span><span class="mark">접수됨 (검토 대기)</span>', '접수된 요청서입니다.'), true);
  eq('요청서(접수 후): 박막 없음 · 배송지 줄', [done.info[1], done.info[4]], [['박막 증착 여부', '없음'], ['배 송 지', '[대한민국] 수령인 · 010\n(00000) 주소 1\n배송 요청: 문 앞']]);
  const old = requestDocFrom({ lang: 'ko', id: 'INQ-OLD', date: '2026-01-01', requester: REQ_KO, product: '금속 박막', dj: { ...DJ, preFilm: undefined } });
  eq('요청서: 박막 항목이 없던 옛 접수 건은 비워 둔다(지어내지 않음)', old.info[1], ['박막 증착 여부', '']);
  const legacy = requestDocFrom({ lang: 'ko', id: 'INQ-LEGACY', date: '2026-01-01', requester: REQ_KO, product: '', dj: null, detailsText: '[공정 시퀀스]\n1. Sputter | Ti' });
  eq('요청서: 구조화 사본 없는 옛 건 → 요청 내용 한 칸', [legacy.info, legacy.steps, legacy.kind], [[['요청 내용', '[공정 시퀀스]\n1. Sputter | Ti']], [], 'process']);
  const wafer = requestDocFrom({ lang: 'ko', id: 'INQ-W', date: '2026-01-01', requester: REQ_KO, product: '4인치 웨이퍼',
    dj: { wafer: { sku: 'w1', qty: 2, dicing: true, dicingFeeKrw: 30000 } }, detailsText: '요청 상품: 4인치 웨이퍼' });
  eq('요청서: 웨이퍼 문의 → 품목 표 · 수량 박스 · 다이싱', [wafer.kind, wafer.qty, wafer.items], ['product', '2박스',
    [{ name: '4인치 웨이퍼', spec: '다이싱: 필요 (+₩30,000/박스 × 2)', qty: '2박스', note: '' }]]);
  const hw = buildRequestHtml({ ...wafer, logoUrl: LOGO });
  eq('요청서: 웨이퍼 표 머리 · 수량 라벨', has(hw, '<th>품명</th>', '<th>규격 · 옵션</th>', '<th>비고</th>', '>수     량<'), true);
}
{
  const en = requestDocFrom({ lang: 'en', draft: true, date: '2026-10-01', requester: { company: 'Test Univ.', name: 'Jane Doe', phone: '+1-000', email: 'j@example.com' },
    product: 'Metals', dj: { ...DJ, notes: 'Handle with care', delivery: 'direct' }, sizeMap: SIZE, deliveryMap: { direct: 'In-person delivery' }, supportEmail: 'hello@example.com' });
  const h = buildRequestHtml({ ...en, logoUrl: LOGO });
  eq('영문 요청서 한글 0자(ASCII 입력)', hangulOf(h), '');
  eq('영문 요청서: 제목 · 세로 Requester · 접수 전 표시', has(h, '>QUOTE REQUEST<', 'To: VanaM Inc.', '<span class="vt">Requester</span>',
    'Reference No. : (not submitted yet)', '<span class="mark">NOT SUBMITTED</span>', 'Oct 1, 2026', 'email it to hello@example.com'), true);
  eq('영문 요청서: 정보 칸 · 표 머리', has(h, '>Substrate<', '>Existing film<', 'Yes — SiO2 300 nm', '>Analysis<', '>Notes<', '<th>Step</th>', '<th>Thickness · Time</th>'), true);
  const w = buildRequestHtml({ ...requestDocFrom({ lang: 'en', id: 'INQ-W', date: '2026-10-01', requester: {}, product: 'Wafer',
    dj: { wafer: { qty: 1, dicing: false } } }), logoUrl: LOGO });
  eq('영문 요청서(웨이퍼): 한글 0자 · 1 box · 다이싱 불필요', [hangulOf(w), w.includes('>1 box<'), w.includes('Dicing: Not required')], ['', true, true]);
}

// ── ⑤ 주문서 ──────────────────────────────────────────────────────────────────────────
const ORDER = { id: 'ORD-20261001-TEST', status: 'paid', amount: 360000, currency: 'KRW', amount_usd: 262, paid_usd: 262, paid_at: '2026-10-01T03:00:00Z',
  pay_method: 'paypal', created_at: '2026-10-01T03:00:00Z', buyer_name: '홍길동', buyer_company: '테스트대학', needs_shipping: 1,
  ship_name: '홍길동', ship_phone: '010-0000-0000', ship_zip: '00000', ship_addr1: '서울시 어딘가 1', ship_addr2: '', ship_city: '', ship_state: '',
  ship_country: 'KR', tax_invoice: 0 };
const ITEMS = [{ sku: 'wafer:si4', name: 'Si Wafer 4"', unit_price: 150000, qty: 2, subtotal: 360000, dicing: 1, dicing_fee: 30000 }];
{
  const d = orderDocFrom({ lang: 'ko', order: ORDER, items: ITEMS, statusText: '결제 완료', noShipText: '배송 없음', email: 'a@example.com' });
  eq('주문서: 웨이퍼 줄 + 다이싱 별도 줄(합 = 소계)', d.items, [
    { name: 'Si Wafer 4"', spec: '', qty: '2박스', unitPrice: 150000, amount: 300000 },
    { name: '다이싱', spec: '박스당', qty: '2박스', unitPrice: 30000, amount: 60000 }]);
  eq('주문서: 합계 · 한글 금액 · 귀하 · 날짜', [d.total, d.totalKorean, d.customer, d.date], [360000, '삼십육만', '테스트대학 홍길동', ymdLocal('2026-10-01T03:00:00Z')]);
  eq('주문서: 결제 칸(PayPal · USD · 결제일) · 배송지 · 세금계산서', d.info, [['주문 상태', '결제 완료'],
    ['결     제', `PayPal (USD) · $262.00 · ${dateKr(ymdLocal('2026-10-01T03:00:00Z'))} 결제`],
    ['배 송 지', '[KR] 홍길동 · 010-0000-0000\n(00000) 서울시 어딘가 1'], ['세금계산서', '요청 안 함']]);
  eq('주문서: PayPal 안내', d.note.startsWith('PayPal 결제는'), true);
  const h = buildOrderHtml({ ...d, logoUrl: LOGO }, FAKE);
  eq('주문서 HTML: 제목 · 귀하+메일 · 번호 · 공급자 연락처', has(h, '<title>주문서 ORD-20261001-TEST</title>', '>주문서<', '테스트대학 홍길동 귀하\na@example.com',
    '<span>주문번호 : ORD-20261001-TEST</span>', '02-0000-0000  ·  fake@example.com', '<span>(인)</span>'), true);
  eq('주문서 HTML: 합계 줄(부가세 포함) · 표 머리 · 합계', has(h, '합계 금액\n(부가세 포함)', '<span class="u">삼십육만</span>', '<th>금액(부가세 포함)</th>', '>합계<', '>360,000<'), true);
  eq('주문서 HTML: 최소 10줄 · 스크립트 없음', [tbodyRows(h), /<script/i.test(h)], [10, false]);
  const bank = orderDocFrom({ lang: 'ko', order: { ...ORDER, pay_method: 'bank', paid_at: null, needs_shipping: 0, tax_invoice: 1 },
    items: [{ sku: 'p1', name: '분석', unit_price: 50000, qty: 1, subtotal: 50000 }], statusText: '결제 대기', noShipText: '실물 배송 없음', email: '' });
  eq('주문서(계좌이체): 결제 칸 · 배송 없음 · 세금계산서 · 안내 없음 · 상품 수량', [bank.info[1][1], bank.info[2][1], bank.info[3][1], bank.note, bank.items[0].qty],
    ['계좌이체', '실물 배송 없음', '요청함', '', '1']);
}
{
  const d = orderDocFrom({ lang: 'en', order: { ...ORDER, buyer_name: 'Jane Doe', buyer_company: 'Test Univ.', ship_name: 'Jane', ship_phone: '+1', ship_addr1: '1 Main St' },
    items: [{ ...ITEMS[0], name: 'Si Wafer 4in' }], statusText: 'Paid', noShipText: 'No delivery', email: 'j@example.com' });
  const h = buildOrderHtml({ ...d, logoUrl: LOGO }, FAKE);
  eq('영문 주문서 한글 0자(ASCII 입력)', hangulOf(h), '');
  eq('영문 주문서: 제목 · To · 결제 · 다이싱 줄 · 합계 ₩', has(h, '<title>Order ORD-20261001-TEST</title>', '>ORDER<', 'To: Test Univ. Jane Doe\nj@example.com',
    'PayPal (USD) · $262.00 · paid on', '>Dicing<', '>per box<', '>2 boxes<', 'Total amount\n(VAT incl.)', '₩360,000', '+82-2-0000-0000  ·  fake@example.com'), true);
}

// ── ⑥ 칸 맞춤(fitCells) — 가짜 DOM: 글자 크기에 비례하는 너비 ───────────────────────────────
{
  const mk = (cls, base, client) => {
    const el = { classList: { contains: (c) => c === cls }, style: {}, clientWidth: client };
    Object.defineProperty(el, 'scrollWidth', { get: () => base * (parseFloat(el.style.fontSize || '10') / 10) });
    return el;
  };
  const fit = mk('fit', 100, 80);       // 10px 에서 100 → 80 이하가 될 때까지(4%씩)
  const tight = mk('fit', 300, 80);     // 12번 줄여도 넘친다 → 그대로 한 줄(잘림)
  const wrap = mk('fitw', 300, 80);     // 넣은 값: 4번 줄여도 넘치면 줄바꿈
  const ok = mk('fitw', 50, 80);        // 안 넘치면 손대지 않는다
  const els = [fit, tight, wrap, ok];
  const doc = { defaultView: { getComputedStyle: (el) => ({ fontSize: el.style.fontSize || '10px' }) }, querySelectorAll: () => els };
  fitCells(doc);
  eq('fitCells: 넘치는 고정 글자는 4%씩 줄여 맞춘다', [fit.style.fontSize, fit.scrollWidth <= 80.5], ['7.83px', true]);
  eq('fitCells: 고정 글자는 최대 12번(줄바꿈 안 함)', [tight.style.fontSize, tight.style.whiteSpace], ['6.13px', undefined]);
  eq('fitCells: 넣은 값은 4번 뒤 줄바꿈', [wrap.style.fontSize, wrap.style.whiteSpace], ['8.49px', 'pre-line']);
  eq('fitCells: 안 넘치면 그대로', [ok.style.fontSize, ok.style.whiteSpace], [undefined, undefined]);
  eq('fitCells: 창이 없으면 아무것도 안 함', fitCells({}), undefined);
}

// ── 도우미 ───────────────────────────────────────────────────────────────────────────
eq('dateKr·dateEn', [dateKr('2026-01-05'), dateEn('2026-12-31'), dateKr('x'), dateEn('x')], ['2026년 1월 5일', 'Dec 31, 2026', 'x', 'x']);
eq('money·usd·telKr', [money(1234), money(1234.5), money(null), usd(4), usd(null), telKr('+82-2-1234-5678')], ['1,234', '1,234.50', '', '$4.00', '', '02-1234-5678']);
eq('telDisplay: 국내 번호 읽기 좋게(한글) · +82 (영문) · 모르는 모양은 그대로', [
  telDisplay('+821012345678'), telDisplay('+82269510922'), telDisplay('+82-2-6951-0922'), telDisplay('+8223456789'), telDisplay('+82312345678'),
  telDisplay('01012345678'), telDisplay('+821012345678', 'en'), telDisplay('+12025550123'), telDisplay('+8215881234'), telDisplay(''), telDisplay(null)],
['010-1234-5678', '02-6951-0922', '02-6951-0922', '02-345-6789', '031-234-5678', '010-1234-5678', '+82 10-1234-5678', '+12025550123', '+8215881234', '', '']);
eq('요청서: 요청자 전화는 읽기 좋게', [requestDocFrom({ lang: 'ko', date: '2026-10-01', requester: { phone: '+821012345678' } }).requester.phone,
  requestDocFrom({ lang: 'en', date: '2026-10-01', requester: { phone: '+821012345678' } }).requester.phone], ['010-1234-5678', '+82 10-1234-5678']);
eq('ymdLocal 형식', [/^\d{4}-\d{2}-\d{2}$/.test(ymdLocal()), ymdLocal('x')], [true, '']);
eq('koreanAmount = 엔진과 같은 함수', [koreanAmount === engineKorean, koreanAmount(188100)], [true, '일십팔만팔천일백']);

if (failed) {
  console.error(`\n서류 HTML 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 서류 HTML(doc-excel: 견적서·요청서·주문서) — ${total}건 통과`);
