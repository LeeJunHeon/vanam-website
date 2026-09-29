// scripts/test-quote-doc.mjs — 견적서 HTML(src/lib/quote-doc-core.js) 테스트
//
//   ① 한국어·새 인자 없음 → 순수 모듈로 옮기기 전 출력과 바이트 단위로 같다(sha256 고정값, 관리자 미리보기 불변)
//   ② stamp·note·fxNote 가 있을 때만 붙는다
//   ③ 영문(lang 'en') — ASCII 입력이면 한글 0자, 라벨·날짜 형식
// 회사 정보는 가짜(실제 사업자 정보를 테스트에 쓰지 않는다).
import { createHash } from 'node:crypto';
import { buildQuoteDocHtml, dateEn, money, telKr } from '../src/lib/quote-doc-core.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

const FAKE = { bizNo: '000-00-00000', nameKo: '가짜상사', nameEn: 'Fake Co.', ceoKo: '홍길동', ceoEn: 'Gil-dong Hong',
  addressKo: '서울시 어딘가 1', addressEn: '1 Somewhere, Seoul', bizTypeKo: '제조업', bizItemKo: '시험', tel: '+82-2-0000-0000' };
const info = { customer: '테스트대학 홍길동', ref: '참조 <x>', title: 'Multilayers', date: '2026-01-10', quoteNo: 'INQ-20260101-TEST',
  manager: '담당', contact: '02-0000-0000', delivery: '계약 후 협의', validDays: '7', payment: '계좌이체' };
const item = (n) => ({ name: `품목 ${n}`, spec: `규격 ${n}\n둘째 줄`, qty: n, unit: '회', unitPrice: 1000 * n + 0.5 * (n % 2), supply: 1000 * n, vat: 100 * n });
const TWO = { info, items: [item(1), null, item(3)], supply: 4000, vat: 400, total: 4400, totalKorean: '사천사백', logoUrl: 'http://x/logo.png' };
const FULL = { info, items: Array.from({ length: 15 }, (_, k) => item(k + 1)), supply: 120000, vat: 12000, total: 132000, totalKorean: '일십삼만이천', logoUrl: 'http://x/logo.png' };

// ① 옮기기 전(quote-doc.ts 인라인 시절) 출력의 고정값 — 같은 가짜 입력으로 뜬 sha256·길이
const FIXED = {
  two: { len: 5738, sha: 'f8bdf3967b8724f4398f4591776429557c3172debc5388a5e9379bbf690e64fd' },
  full: { len: 6184, sha: '4fe04380bea9057777a0e9edda42466c294078c57d0f22125b9c156c0b36e7e6' },
};
for (const [k, o] of Object.entries({ two: TWO, full: FULL })) {
  const h = buildQuoteDocHtml(o, FAKE);
  eq(`ko 바이트 동일(${k})`, { len: h.length, sha: sha(h) }, FIXED[k]);
  const h2 = buildQuoteDocHtml({ ...o, lang: 'ko', stamp: '', note: '', fxNote: '' }, FAKE);
  eq(`ko + 빈 선택 인자도 바이트 동일(${k})`, sha(h2), FIXED[k].sha);
}

// ② 선택 인자
{
  const h = buildQuoteDocHtml({ ...TWO, stamp: '예상 견적 · 확정 전', note: '안내 <b>', fxNote: '참고 $1.00' }, FAKE);
  eq('stamp 는 제목 바로 뒤', h.includes('<h1>견적서</h1>\n      <p class="stamp">예상 견적 · 확정 전</p>'), true);
  eq('note 이스케이프', h.includes('<p class="note">안내 &lt;b&gt;</p>'), true);
  eq('fxNote 는 합계 표 뒤', /<\/table>\n  <p class="fx">참고 \$1\.00<\/p>/.test(h), true);
  eq('선택 인자 있을 때만 추가 CSS', [h.includes('.stamp{'), buildQuoteDocHtml(TWO, FAKE).includes('.stamp{')], [true, false]);
  eq('자동 인쇄 없음', /\.print\(\)|window\.print/.test(h), false);
}

// ③ 영문
const ASCII_INFO = { customer: 'Test Univ. Jane Doe', ref: '', title: 'Multilayers', date: '2026-09-29', quoteNo: 'INQ-20260929-TEST',
  manager: '', contact: '+82-2-0000-0000', delivery: '', validDays: '14', payment: '' };
const ASCII_ITEMS = [{ name: 'Sputter Ti/Pt', spec: 'Ti 10 nm\nPt 45 nm', qty: 1, unit: '회', unitPrice: 1000, supply: 1000, vat: 100 },
  { name: 'ALD HfO2', spec: 'HfO2 5 nm', qty: 2, unit: '회', unitPrice: 2000, supply: 4000, vat: 400 }];
const EN = { info: ASCII_INFO, items: ASCII_ITEMS, supply: 5000, vat: 500, total: 5500, totalKorean: '오천오백', logoUrl: 'http://x/logo.png',
  lang: 'en', stamp: 'ESTIMATE — NOT FINAL', note: 'This is an estimate.', fxNote: 'USD equivalent (reference): $4.00' };
const FAKE_EN = { ...FAKE, nameKo: 'Fake Co.', ceoKo: 'Hong', addressKo: 'Seoul', bizTypeKo: 'Mfg', bizItemKo: 'Test' };
{
  const h = buildQuoteDocHtml(EN, FAKE_EN);
  const hangul = h.match(/[가-힣ㄱ-ㆎ]/g) ?? [];
  eq('영문 견적서 한글 0자(ASCII 입력)', hangul.join(''), '');
  eq('영문: html lang·title·제목', [h.includes('<html lang="en">'), h.includes('<title>Quotation INQ-20260929-TEST</title>'), h.includes('<h1>QUOTATION</h1>')], [true, true, true]);
  eq('영문: To·Attn(참조 없으면 생략)·날짜·번호', [h.includes('To: Test Univ. Jane Doe'), h.includes('Attn:'), h.includes('Sep 29, 2026'), h.includes('Quote No. : INQ-20260929-TEST')], [true, false, true, true]);
  eq('영문: 공급자 표', ['>Supplier<', 'Business Reg. No.', '>Company<', 'Fake Co.', 'Representative', 'Gil-dong Hong', '1 Somewhere, Seoul', '>Contact<']
    .every((w) => h.includes(w)), true);
  eq('영문: 업태·종목·(인) 없음', [h.includes('Mfg'), h.includes('(인)')], [false, false]);
  eq('영문: 빈 납기·결제조건 → To be confirmed', (h.match(/To be confirmed/g) ?? []).length, 2);
  eq('영문: 유효기간 문장', h.includes('Valid for 14 days from the quote date'), true);
  eq('영문: 합계 줄은 ₩ 금액(한글 금액 없음)', [h.includes('Total amount\n(supply + VAT)'), h.includes('₩5,500'), h.includes('오천오백')], [true, true, false]);
  eq('영문: 품목 머리·합계', ['<th>Item</th>', '<th>Specification</th>', '<th>Qty</th>', '<th>Unit price</th>', '<th>Supply amount</th>', '<th>VAT</th>', '>Total<']
    .every((w) => h.includes(w)), true);
  eq('영문: 단위 회 → run(s)', [h.includes('>1 run<'), h.includes('>2 runs<')], [true, true]);
  eq('영문: 버튼', [h.includes('Print / Save as PDF'), h.includes('>Close<')], [true, true]);
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(h)?.[1] ?? '';
  eq('영문: 품목 15줄 고정(표 본문)', (tbody.match(/<tr>/g) ?? []).length, 15);
  const h2 = buildQuoteDocHtml({ ...EN, info: { ...ASCII_INFO, ref: 'Lab A', validDays: '' } }, FAKE_EN);
  eq('영문: 참조 있으면 Attn · 유효 일수 없으면 To be confirmed', [h2.includes('Attn: Lab A'), (h2.match(/To be confirmed/g) ?? []).length], [true, 3]);
}
eq('dateEn', [dateEn('2026-01-05'), dateEn('2026-12-31'), dateEn('x')], ['Jan 5, 2026', 'Dec 31, 2026', 'x']);
eq('money·telKr', [money(1234), money(1234.5), money(null), telKr('+82-2-1234-5678')], ['1,234', '1,234.50', '', '02-1234-5678']);

if (failed) {
  console.error(`\n견적서 HTML 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 견적서 HTML(quote-doc-core) — ${total}건 통과`);
