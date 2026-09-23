// 관리자 견적 계산기(/admin/quote)의 견적서 미리보기 — 엑셀 '견적서' 탭 배치를 그대로 옮겼다.
//
// quote-sheet.ts(고객용 견적 요청서·견적서)와는 다른 문서다. 그쪽은 고객 화면 공용 틀이고,
// 이쪽은 사내에서 엑셀로 뽑던 견적서를 대신한다. 서로 건드리지 않는다.
//
// 규칙 (quote-sheet.ts 와 같음):
//   - **자동 인쇄하지 않는다.** 창 안의 버튼을 눌러야 인쇄창이 뜬다.
//   - 직인 이미지는 넣지 않는다. 대표자 옆에 "(인)" 글자만 둔다.
//   - A4 세로. 품목표는 엑셀처럼 15줄 고정 — 빈 줄도 칸을 유지한다.
import company from '../data/company.json';

export type QuoteDocInfo = {
  customer: string;   // 고객(귀하)
  ref: string;        // 참조
  title: string;      // 견적명
  date: string;       // 견적일 YYYY-MM-DD
  quoteNo: string;    // 견적번호
  manager: string;    // 담당자
  contact: string;    // 연락처
  delivery: string;   // 납품기한
  validDays: string;  // 견적 유효 일수
  payment: string;    // 대금 지불방식
};

export type QuoteDocItem = {
  name: string;
  spec: string;
  qty: unknown;
  unit: unknown;
  unitPrice: number | null;
  supply: number | null;
  vat: number | null;
};

export type QuoteDocInput = {
  info: QuoteDocInfo;
  /** 품목 줄(입력 순서 그대로). 15줄보다 적으면 빈 줄로 채운다. */
  items: (QuoteDocItem | null)[];
  supply: number;
  vat: number;
  total: number;
  totalKorean: string;
  /** 로고 절대 주소 — 새 창(about:blank)에서도 깨지지 않게 호출부가 넘긴다 */
  logoUrl: string;
};

const ROWS = 15;

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 금액 표기: 정수는 천 단위 쉼표, 소수(부가세 포함 역산 등)는 소수 둘째 자리까지. */
export const money = (n: number | null | undefined) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return Number.isInteger(n)
    ? n.toLocaleString('ko-KR')
    : n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** +82-2-1234-5678 → 02-1234-5678 (국내 표기) */
export const telKr = (tel: string) => String(tel ?? '').replace(/^\+82-?/, '0');

/** 2026-09-23 → 2026년 9월 23일 (형식이 다르면 그대로) */
const dateKr = (s: string) => {
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

/** 견적서 HTML 을 만든다. 창을 여는 것은 호출부(openQuoteDoc) 몫이다. */
export function buildQuoteDoc(o: QuoteDocInput): string {
  const i = o.info;
  const c = company as Record<string, unknown>;
  const s = (k: string) => String(c[k] ?? '');

  const rows: string[] = [];
  for (let n = 0; n < ROWS; n++) {
    const it = o.items[n];
    rows.push(it
      ? `<tr><td>${esc(it.name)}</td><td class="spec">${esc(it.spec)}</td>` +
        `<td class="qty">${esc(`${it.qty ?? ''} ${it.unit ?? ''}`.trim())}</td>` +
        `<td class="num">${money(it.unitPrice)}</td><td class="num">${money(it.supply)}</td><td class="num">${money(it.vat)}</td></tr>`
      : '<tr><td></td><td class="spec"></td><td class="qty"></td><td class="num"></td><td class="num"></td><td class="num"></td></tr>');
  }

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>견적서 ${esc(i.quoteNo)}</title>
<style>${STYLE}</style></head><body>
<div class="noprint"><button type="button" id="vn-doc-print">🖨 인쇄 / PDF 저장</button><button type="button" id="vn-doc-close">닫기</button></div>
<div class="page">
  <div class="top">
    <div class="left">
      <img class="logo" src="${esc(o.logoUrl)}" alt="VanaM">
      <h1>견적서</h1>
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
  </table>

  <table class="items">
    <colgroup><col style="width:24%"><col style="width:30%"><col style="width:9%"><col style="width:13%"><col style="width:13%"><col style="width:11%"></colgroup>
    <thead><tr><th>품명</th><th>규격/사양</th><th>수량</th><th>단가</th><th>공급가액</th><th>세액</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr><td colspan="4" style="text-align:center">최종 합계</td><td class="num">${money(o.supply)}</td><td class="num">${money(o.vat)}</td></tr></tfoot>
  </table>
</div>
</body></html>`;
}

/** 새 창에 띄운다. 팝업이 막히면 false — 호출부가 안내한다. */
export function openQuoteDoc(html: string): boolean {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  // 자동 인쇄하지 않는다 — 내용을 먼저 보고 창 안의 버튼으로 인쇄·PDF 저장한다.
  w.document.getElementById('vn-doc-print')?.addEventListener('click', () => w.print());
  w.document.getElementById('vn-doc-close')?.addEventListener('click', () => w.close());
  return true;
}
