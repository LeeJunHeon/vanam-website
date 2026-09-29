// 견적서(엑셀 '견적서' 탭 배치) HTML 조립 — 순수 모듈(.js). 브라우저·서버·node 테스트가 같이 쓴다.
//
// quote-doc.ts 는 company.json 을 넣어 이 함수를 부르는 얇은 래퍼다(buildQuoteDoc·openQuoteDoc).
// 공급자 정보(company)를 인자로 받는 이유: node 테스트가 빌드 없이 가짜 회사 정보로 출력을 고정하기 위해.
//
// 규칙 (quote-sheet.ts 와 같음):
//   - **자동 인쇄하지 않는다.** 창 안의 버튼을 눌러야 인쇄창이 뜬다.
//   - 직인 이미지는 넣지 않는다. 대표자 옆에 "(인)" 글자만 둔다.
//   - A4 세로. 품목표는 엑셀처럼 15줄 고정 — 빈 줄도 칸을 유지한다.

const ROWS = 15;

const esc = (v) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 금액 표기: 정수는 천 단위 쉼표, 소수(부가세 포함 역산 등)는 소수 둘째 자리까지. */
export const money = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return Number.isInteger(n)
    ? n.toLocaleString('ko-KR')
    : n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** +82-2-1234-5678 → 02-1234-5678 (국내 표기) */
export const telKr = (tel) => String(tel ?? '').replace(/^\+82-?/, '0');

/** 2026-09-23 → 2026년 9월 23일 (형식이 다르면 그대로) */
export const dateKr = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  return m ? `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일` : String(s ?? '');
};

const STYLE = `
  @page{size:A4 portrait;margin:12mm}
  *{box-sizing:border-box}
  body{font-family:'Pretendard','Malgun Gothic',-apple-system,Arial,sans-serif;color:#111;margin:0;background:#e9ecef}
  .page{width:210mm;min-height:297mm;margin:16px auto;background:#fff;padding:12mm;box-shadow:0 1px 6px rgba(0,0,0,.15)}
  .top{display:flex;gap:6mm;align-items:stretch}
  .left{flex:1;display:flex;flex-direction:column;justify-content:space-between;min-width:0}
  .logo{height:10mm;width:auto;align-self:flex-start}
  h1{font-size:30px;letter-spacing:.6em;margin:4mm 0 3mm;font-weight:700}
  .to{font-size:15px;font-weight:600;white-space:pre-line;line-height:1.5}
  .meta{font-size:12px;line-height:1.7;margin-top:2mm}
  table{border-collapse:collapse;width:100%}
  td,th{border:1px solid #333;font-size:11.5px;padding:1.6mm 2mm;vertical-align:middle}
  .sup{width:106mm}
  .sup .v{writing-mode:vertical-rl;text-align:center;letter-spacing:.4em;font-weight:700;width:8mm;background:#f1f3f5}
  .sup th{background:#f1f3f5;font-weight:600;white-space:nowrap;width:18mm}
  .sup td{white-space:pre-line}
  .info{margin-top:5mm}
  .info th{background:#f1f3f5;width:36mm;text-align:left;font-weight:600}
  .sum th{background:#f1f3f5;width:36mm;text-align:left;font-weight:700;white-space:pre-line;font-size:11px}
  .sum td{font-size:14px;font-weight:700}
  .sum .won{text-align:right;white-space:nowrap}
  .items{margin-top:5mm}
  .items th{background:#f1f3f5;text-align:center;font-weight:700}
  .items td{height:9mm}
  .items .spec{white-space:pre-line;font-size:10.5px}
  .items .num{text-align:right;white-space:nowrap}
  .items .qty{text-align:center;white-space:nowrap}
  .items tfoot td{font-weight:700;background:#f8f9fa}
  .noprint{max-width:210mm;margin:16px auto 0;display:flex;gap:8px}
  .noprint button{font:inherit;font-size:13px;padding:8px 14px;border:1px solid #bbb;border-radius:8px;background:#fff;cursor:pointer}
  @media print{body{background:#fff}.page{margin:0;box-shadow:none;width:auto;min-height:0;padding:0}.noprint{display:none}}
`;

/**
 * 견적서 HTML. 창을 여는 것은 호출부(quote-doc.ts 의 openQuoteDoc) 몫이다.
 * @param {object} o 견적서 데이터(QuoteDocInput)
 * @param {Record<string, unknown>} company 공급자 정보(src/data/company.json) — node 테스트는 가짜를 넘긴다
 * @returns {string}
 */
export function buildQuoteDocHtml(o, company) {
  if (o?.lang === 'en') return buildQuoteDocHtmlEn(o, company);
  const i = o.info;
  const c = company ?? {};
  const s = (k) => String(c[k] ?? '');
  // 선택 인자(stamp·note·fxNote) — 없으면 빈 문자열이라 출력이 예전과 바이트 단위로 같다(관리자 미리보기 불변)
  const x = extras(o);

  const rows = [];
  for (let n = 0; n < ROWS; n++) {
    const it = o.items[n];
    rows.push(it
      ? `<tr><td>${esc(it.name)}</td><td class="spec">${esc(it.spec)}</td>` +
        `<td class="qty">${esc(`${it.qty ?? ''} ${it.unit ?? ''}`.trim())}</td>` +
        `<td class="num">${money(it.unitPrice)}</td><td class="num">${money(it.supply)}</td><td class="num">${money(it.vat)}</td></tr>`
      : '<tr><td></td><td class="spec"></td><td class="qty"></td><td class="num"></td><td class="num"></td><td class="num"></td></tr>');
  }

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>견적서 ${esc(i.quoteNo)}</title>
<style>${STYLE}${x.style}</style></head><body>
<div class="noprint"><button type="button" id="vn-doc-print">🖨 인쇄 / PDF 저장</button><button type="button" id="vn-doc-close">닫기</button></div>
<div class="page">
  <div class="top">
    <div class="left">
      <img class="logo" src="${esc(o.logoUrl)}" alt="VanaM">
      <h1>견적서</h1>${x.stamp}
      <div class="to">${esc(`${i.customer} 귀하\n참조 : ${i.ref}`)}</div>
      <div class="meta">${esc(dateKr(i.date))}<br>견적번호 : ${esc(i.quoteNo)}</div>
    </div>
    <table class="sup">
      <tr><td class="v" rowspan="5">공급자</td><th>사업자번호</th><td colspan="3">${esc(s('bizNo'))}</td></tr>
      <tr><th>상 호</th><td>${esc(s('nameKo'))}</td><th>대 표 자</th><td>${esc(s('ceoKo'))} (인)</td></tr>
      <tr><th>소 재 지</th><td colspan="3">${esc(s('addressKo'))}</td></tr>
      <tr><th>업 태</th><td>${esc(s('bizTypeKo'))}</td><th>종 목</th><td>${esc(s('bizItemKo'))}</td></tr>
      <tr><th>담 당 자</th><td>${esc(i.manager)}</td><th>연 락 처</th><td>${esc(i.contact)}</td></tr>
    </table>
  </div>

  <table class="info">
    <tr><th>견 적 명</th><td>${esc(i.title)}</td></tr>
    <tr><th>납품기한</th><td>${esc(i.delivery)}</td></tr>
    <tr><th>대금 지불방식</th><td>${esc(i.payment)}</td></tr>
    <tr><th>견적 유효기간</th><td>견적일로부터 ${esc(i.validDays)} 일간</td></tr>
  </table>

  <table class="info sum">
    <tr><th>합계 금액\n(공급가액+세액)</th><td>일금 ${esc(o.totalKorean)} 원정</td><td class="won">₩${money(o.total)}</td></tr>
  </table>${x.fx}

  <table class="items">
    <colgroup><col style="width:24%"><col style="width:30%"><col style="width:9%"><col style="width:13%"><col style="width:13%"><col style="width:11%"></colgroup>
    <thead><tr><th>품명</th><th>규격/사양</th><th>수량</th><th>단가</th><th>공급가액</th><th>세액</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr><td colspan="4" style="text-align:center">최종 합계</td><td class="num">${money(o.supply)}</td><td class="num">${money(o.vat)}</td></tr></tfoot>
  </table>${x.note}
</div>
</body></html>`;
}

// ── 선택 인자: 제목 옆 표시(stamp) · 하단 안내(note) · 합계 아래 참고 줄(fxNote) ──────────────
const EXTRA_STYLE = `
  .stamp{display:inline-block;margin:0 0 3mm;border:2px solid #b45309;color:#b45309;font-weight:700;font-size:12px;padding:1mm 3mm;border-radius:2mm}
  .fx{margin:2mm 0 0;font-size:11px;color:#444;text-align:right}
  .note{margin-top:5mm;font-size:11px;line-height:1.6;color:#333;border-top:1px solid #999;padding-top:3mm}
`;
/** @param {{stamp?: string, note?: string, fxNote?: string}} o */
function extras(o) {
  const has = Boolean(o?.stamp || o?.note || o?.fxNote);
  return {
    style: has ? EXTRA_STYLE : '',
    stamp: o?.stamp ? `\n      <p class="stamp">${esc(o.stamp)}</p>` : '',
    fx: o?.fxNote ? `\n  <p class="fx">${esc(o.fxNote)}</p>` : '',
    note: o?.note ? `\n  <p class="note">${esc(o.note)}</p>` : '',
  };
}

// ── 영문 견적서 (lang: 'en') — 엑셀 견적서와 같은 배치, 라벨만 영문 ──────────────────────────
// ⚠️ 라벨에 한글을 넣지 않는다(scripts/test-quote-doc.mjs 가 ASCII 입력으로 한글 0자를 확인한다).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-09-29 → Sep 29, 2026 (형식이 다르면 그대로) */
export const dateEn = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(s ?? '');
};
/** 품목 단위 — 자동 견적의 '회'는 영문 견적서에서 run(s) */
const unitEn = (qty, unit) => {
  const u = String(unit ?? '');
  if (u === '회') return Number(qty) === 1 ? 'run' : 'runs';
  if (u === '개' || u === '장') return 'pcs';
  return u;
};
const TBC = 'To be confirmed';

function buildQuoteDocHtmlEn(o, company) {
  const i = o.info;
  const c = company ?? {};
  const s = (k) => String(c[k] ?? '');
  const x = extras(o);
  const rows = [];
  for (let n = 0; n < ROWS; n++) {
    const it = o.items[n];
    rows.push(it
      ? `<tr><td>${esc(it.name)}</td><td class="spec">${esc(it.spec)}</td>` +
        `<td class="qty">${esc(`${it.qty ?? ''} ${unitEn(it.qty, it.unit)}`.trim())}</td>` +
        `<td class="num">${money(it.unitPrice)}</td><td class="num">${money(it.supply)}</td><td class="num">${money(it.vat)}</td></tr>`
      : '<tr><td></td><td class="spec"></td><td class="qty"></td><td class="num"></td><td class="num"></td><td class="num"></td></tr>');
  }
  const contact = [i.manager, i.contact].map((v) => String(v ?? '').trim()).filter(Boolean).join(' · ');
  const days = String(i.validDays ?? '').trim();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quotation ${esc(i.quoteNo)}</title>
<style>${STYLE}  .sup .h{background:#f1f3f5;font-weight:700;text-align:center}
${x.style}</style></head><body>
<div class="noprint"><button type="button" id="vn-doc-print">🖨 Print / Save as PDF</button><button type="button" id="vn-doc-close">Close</button></div>
<div class="page">
  <div class="top">
    <div class="left">
      <img class="logo" src="${esc(o.logoUrl)}" alt="VanaM">
      <h1>QUOTATION</h1>${x.stamp}
      <div class="to">${esc(`To: ${i.customer}`)}${String(i.ref ?? '').trim() ? `<br>${esc(`Attn: ${i.ref}`)}` : ''}</div>
      <div class="meta">${esc(dateEn(i.date))}<br>Quote No. : ${esc(i.quoteNo)}</div>
    </div>
    <table class="sup">
      <tr><td class="h" colspan="2">Supplier</td></tr>
      <tr><th>Business Reg. No.</th><td>${esc(s('bizNo'))}</td></tr>
      <tr><th>Company</th><td>${esc(s('nameEn'))}</td></tr>
      <tr><th>Representative</th><td>${esc(s('ceoEn'))}</td></tr>
      <tr><th>Address</th><td>${esc(s('addressEn'))}</td></tr>
      <tr><th>Contact</th><td>${esc(contact)}</td></tr>
    </table>
  </div>

  <table class="info">
    <tr><th>Title</th><td>${esc(i.title)}</td></tr>
    <tr><th>Delivery</th><td>${esc(String(i.delivery ?? '').trim() || TBC)}</td></tr>
    <tr><th>Payment terms</th><td>${esc(String(i.payment ?? '').trim() || TBC)}</td></tr>
    <tr><th>Validity</th><td>${days ? `Valid for ${esc(days)} days from the quote date` : TBC}</td></tr>
  </table>

  <table class="info sum">
    <tr><th>Total amount\n(supply + VAT)</th><td class="won">₩${money(o.total)}</td></tr>
  </table>${x.fx}

  <table class="items">
    <colgroup><col style="width:24%"><col style="width:30%"><col style="width:9%"><col style="width:13%"><col style="width:13%"><col style="width:11%"></colgroup>
    <thead><tr><th>Item</th><th>Specification</th><th>Qty</th><th>Unit price</th><th>Supply amount</th><th>VAT</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr><td colspan="4" style="text-align:center">Total</td><td class="num">${money(o.supply)}</td><td class="num">${money(o.vat)}</td></tr></tfoot>
  </table>${x.note}
</div>
</body></html>`;
}
