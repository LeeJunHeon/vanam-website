// 견적서·요청서 인쇄물 — 단일 템플릿.
//
// 왜 필요한가:
//   같은 성격의 문서를 세 곳에서 각각 만들고 있었다.
//     ① 견적 폼의 '견적서 다운로드'(접수 전)
//     ② 조회 화면의 '견적서 인쇄'(금액 확정 후)
//   생김새가 서로 달라서 고객이 같은 회사에서 받은 서류로 보이지 않았다.
//   → 틀은 여기 하나로 두고, 내용(제목·표 항목·금액·꼬리말)만 호출부가 채운다.
//
// 규칙:
//   - **자동 인쇄하지 않는다.** 창 안의 버튼을 눌러야 인쇄창이 뜬다.
//     (내용을 먼저 확인할 수 있어야 하고, 갑자기 뜨는 인쇄창은 사고로 느껴진다)
//   - 금액이 없으면 `amount` 에 "산정 중" 같은 문구를 그대로 넘긴다 — 칸 자체는 항상 같은 자리에 있다.

export type Supplier = {
  name?: string;
  ceo?: string;
  bizNo?: string;
  address?: string;
  tel?: string;
  email?: string;
};

export type SheetOptions = {
  /** 문서 제목 — '견적 요청서' / '견적서' */
  title: string;
  /** 발행일 라벨과 값 */
  issuedLabel: string;
  issued: string;
  /** 공급자 블록 */
  supplierLabel: string;
  supplier: Supplier;
  /** 표에 들어갈 라벨/값 쌍 (빈 값은 호출부에서 걸러 넘긴다) */
  rows: [string, string][];
  /** 요청 내용 본문 (여러 줄) */
  details?: string;
  /** 금액 칸 — 라벨/부가세 표기/값. 값이 없으면 '산정 중' 문구를 넘긴다 */
  amountLabel: string;
  vatLabel?: string;
  amount: string;
  /** 입금 계좌 (선택) */
  bankLabel?: string;
  bank?: string;
  /** 견적 메모 (선택) */
  memo?: string;
  /** 꼬리말 안내 */
  footNote?: string;
  /** 창 안 인쇄 버튼 문구 */
  printLabel: string;
};

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const STYLE = `
  body{font-family:'Pretendard',-apple-system,Arial,sans-serif;color:#17202a;margin:40px auto;max-width:760px;line-height:1.6}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#667;font-size:12px;margin:0 0 22px}
  .sup{border:1px solid #c9d2da;background:#f6f9fb;padding:12px 14px;font-size:12px;line-height:1.9;margin-bottom:20px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border:1px solid #c9d2da;padding:9px 11px;text-align:left;vertical-align:top}
  th{background:#eef4f8;width:150px;font-weight:600}
  td{white-space:pre-line}
  pre{white-space:pre-wrap;font-family:inherit;font-size:13px;border:1px solid #c9d2da;padding:12px;margin-top:14px;background:#fafbfc}
  .amt{margin-top:18px;border:2px solid #17202a;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;font-size:15px;gap:16px}
  .amt b{font-size:20px;white-space:nowrap}
  .bank{margin-top:12px;border:1px solid #c9d2da;background:#f6f9fb;padding:10px 14px;font-size:13px}
  .note{margin-top:24px;font-size:12px;color:#445;border-top:1px solid #dde;padding-top:12px;line-height:1.9}
  .noprint{margin:0 0 22px}
  .noprint button{font:inherit;font-size:13px;padding:8px 14px;border:1px solid #bbb;border-radius:8px;background:#f6f6f6;cursor:pointer}
  @media print{.noprint{display:none}}
`;

/** 인쇄용 문서 HTML 을 만든다. 창을 여는 것은 호출부 몫이다. */
export function buildQuoteSheet(o: SheetOptions): string {
  const s = o.supplier ?? {};
  const supLine1 = [s.name, s.ceo].filter(Boolean).map(esc).join(' · ');
  const supLine4 = [s.tel, s.email].filter(Boolean).map(esc).join(' · ');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.title)} ${esc(o.issued)}</title>
<style>${STYLE}</style></head><body>
  <div class="noprint"><button type="button" id="vn-sheet-print">🖨 ${esc(o.printLabel)}</button></div>
  <h1>VANAM — ${esc(o.title)}</h1>
  <p class="sub">${esc(o.issuedLabel)} ${esc(o.issued)}</p>
  <div class="sup">
    <b>${esc(o.supplierLabel)}</b><br>
    ${supLine1}<br>
    ${esc(s.bizNo ?? '')}<br>
    ${esc(s.address ?? '')}<br>
    ${supLine4}
  </div>
  <table>${o.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
  ${o.details ? `<pre>${esc(o.details)}</pre>` : ''}
  <div class="amt"><span>${esc(o.amountLabel)}${o.vatLabel ? ` ${esc(o.vatLabel)}` : ''}</span><b>${esc(o.amount)}</b></div>
  ${o.bank ? `<div class="bank"><b>${esc(o.bankLabel ?? '')}</b><br>${esc(o.bank)}</div>` : ''}
  ${o.memo ? `<pre>${esc(o.memo)}</pre>` : ''}
  ${o.footNote ? `<p class="note">${esc(o.footNote)}<br>${esc(s.email ?? '')} · vanam.co.kr</p>` : ''}
</body></html>`;
}

/** 새 창에 띄운다. 팝업이 막히면 조용히 아무 일도 하지 않는다(버튼으로 재시도 가능). */
export function openQuoteSheet(html: string): void {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(html);
  w.document.close();
  // 자동 인쇄하지 않는다 — 내용을 먼저 보고 창 안의 버튼으로 인쇄·PDF 저장한다.
  w.document.getElementById('vn-sheet-print')?.addEventListener('click', () => w.print());
}
