// 서류 공통 틀 — 엑셀 「견적서」 탭(견적 DB V3, B2:P30)을 그대로 옮긴 A4 배치. 순수 모듈(.js).
//
// 2026-10-01 사용자 지시: "앞으로 모든 견적서나 이런 서류들은 그 엑셀 양식을 따라가면 됨".
// → 견적서 · 견적 요청서 · 주문서가 이 틀 하나를 쓴다(예전 quote-doc-core.js · quote-sheet.ts · 완료 화면 자체 양식을 대신한다).
//   칸 너비·줄 높이·글자 크기·굵은 바깥 선·회색 칸 위치가 엑셀과 같다.
//
// 크기: 엑셀 열 너비(B..P, 합 106.79)와 행 높이(pt)를 그대로 쓰고 A4 세로(여백 10mm, 본문 190mm)에 맞게 S배 했다.
//       엑셀 한 장 너비 ≈ 197.4mm(열 너비 × 7px @96dpi) → S = 190 / 197.4.
// 선: 엑셀은 칸 묶음(공급자 칸 · 정보/합계 칸 · 품목표)마다 바깥 선이 굵고 안쪽은 가늘다.
//     border-collapse 표는 표 테두리와 바깥 칸 선이 겹치면 굵은 쪽이 이긴다 → 표 테두리 = 굵은 선, 칸 = 가는 선.
// 글꼴: 엑셀(구글 시트)과 같은 Arial — 한글은 시스템 한글 글꼴(맑은 고딕 등)로 넘어간다.
//       메일 첨부 PDF 를 만드는 클라우드플레어 브라우저(리눅스)에는 맑은 고딕이 없다 → 'Noto Sans CJK KR'(설치돼 있음)을 이어 둔다
//       (없으면 중국어용 글꼴로 넘어가 한글 모양이 어색했다 — 10-02 실제 메일 확인).
//
// 엑셀과 일부러 다르게 둔 것:
//   - 칸 높이는 '최소' 높이다. 긴 글(요청 사항 등)은 칸이 늘어나고, 줄이 많으면 2쪽으로 넘어가며 표 머리가 다시 나온다.
//   - 아래 표(품목·공정 순서)는 넣은 줄만큼만 그린다. 엑셀처럼 빈 줄(15줄)로 채우지 않는다(10-01 사용자 요청).
//   - 예상 견적은 견적번호 줄 오른쪽에 굵은 글자 + 맨 아래 작은 안내(stamp·note). 확정 견적은 둘 다 없다(엑셀과 같음).
//   - 직인 그림은 넣지 않는다 — 누구나 내려받는 웹 문서라 대표자 옆 "(인)" 글자만 둔다.
//
// 규칙: 자동 인쇄하지 않는다(창 안 버튼) · 넣는 값은 전부 이스케이프 · 이 파일은 화면(DOM)을 만지지 않는다
//       (칸 맞춤 fitCells 만 예외 — 창을 연 쪽이 새 창 문서를 넘겨 부른다. 문서 안에 스크립트를 넣지 않는다).
import { koreanAmount } from './quote-engine.js';

export { koreanAmount };

export const S = 190 / 197.4;
const W = { B: 14.5, C: 5, D: 13.13, E: 13, F: 4.13, G: 7.38, H: 2.88, I: 5, J: 2.88, K: 5, L: 2.88, M: 5, N: 2.88, O: 13.13, P: 10 };
const ALL = Object.values(W).reduce((a, b) => a + b, 0);
/** 열 묶음 너비 — 묶음 표 안에서의 % (기준 열들의 합 대비) */
const pct = (cols, base) => `${(cols.reduce((a, c) => a + W[c], 0) / base * 100).toFixed(3)}%`;
const sum = (cols) => cols.reduce((a, c) => a + W[c], 0);
/** 엑셀 행 높이(pt) → mm (S배) */
const mm = (pt) => `${(pt * 0.352778 * S).toFixed(2)}mm`;
/** 엑셀 글자 크기(pt) → pt (S배) */
const fz = (pt) => `${(pt * S).toFixed(2)}pt`;

export const esc = (v) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (v) => String(v ?? '').trim();

/** 금액: 정수는 천 단위 쉼표, 소수는 둘째 자리까지 */
export const money = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return Number.isInteger(n)
    ? n.toLocaleString('ko-KR')
    : n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
/** 달러: $1,234.50 */
export const usd = (n) =>
  (typeof n === 'number' && Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');
/** +82-2-1234-5678 → 02-1234-5678 */
export const telKr = (tel) => String(tel ?? '').replace(/^\+82-?/, '0');
/**
 * 고객이 넣은 전화번호를 서류에 읽기 좋게 — 폼은 국제표준(E.164, +821012345678)으로 저장한다.
 *   한글 서류: 010-1234-5678 · 02-6951-0922 / 영문 서류: +82 10-1234-5678
 *   한국 번호가 아니거나 모양을 모르는 번호는 받은 그대로 둔다.
 */
export const telDisplay = (v, lang = 'ko') => {
  const raw = String(v ?? '').trim();
  const d = raw.replace(/[\s().-]/g, '');
  const n = /^\+82\d{8,11}$/.test(d) ? `0${d.slice(3).replace(/^0/, '')}` : /^0\d{8,10}$/.test(d) ? d : '';
  let f = '';
  if (n.startsWith('02') && (n.length === 9 || n.length === 10)) f = `02-${n.slice(2, n.length - 4)}-${n.slice(-4)}`;
  else if (!n.startsWith('02') && n.length === 11) f = `${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7)}`;
  else if (!n.startsWith('02') && n.length === 10) f = `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`;
  if (!f) return raw;
  return lang === 'en' ? `+82 ${f.slice(1)}` : f;
};
/** 2026-09-23 → 2026년 9월 23일 (엑셀 표시 형식 yyyy년 m월 d일) */
export const dateKr = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  return m ? `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일` : String(s ?? '');
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-09-29 → Sep 29, 2026 */
export const dateEn = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(s ?? '');
};
const pad2 = (n) => String(n).padStart(2, '0');
/**
 * 시각 → 보는 사람 기기 시간대의 날짜 YYYY-MM-DD (인자가 없으면 오늘).
 * toISOString().slice(0, 10) 은 UTC 라 한국 오전 9시 전에는 하루 전 날짜가 된다.
 */
export const ymdLocal = (iso) => {
  const d = iso === undefined ? new Date() : new Date(String(iso ?? ''));
  return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : '';
};

// ── 공급자 칸 글자 ──────────────────────────────────────────────────────────────
// 엑셀 「견적서」 탭의 공급자 칸 글자 그대로(줄바꿈 위치 포함). 사업자번호만 company.json 에서 읽는다.
// 상호는 사이트 하단 회사 정보(company.json nameKo)와 같은 '반암 주식회사'(띄어 씀 — 10-02 결정, 엑셀의 붙여 쓴 글자 대신).
// ⚠️ 주소는 엑셀 글자 그대로라 사이트 하단(끝에 '(대림동)')과 조금 다르다 — 서류는 엑셀을 따른다(10-01 결정).
//    회사 정보가 바뀌면 여기도 같이 고친다.
export const SUPPLIER_DOC_KO = Object.freeze({
  name: '반암 주식회사', ceo: '한 수 덕', address: '서울특별시 영등포구 도신로4길 21-1, 반암',
  bizType: '제조업,\n과학기술서비스업', bizItem: '기타 반도체 소자 및 장비,\n공학연구개발, 엔지니어링',
});

// ── CSS ───────────────────────────────────────────────────────────────────────────
const LINE = '#000';
const FILL = '#f2f2f2';
export const STYLE = `
  @page{size:A4 portrait;margin:10mm}
  *{box-sizing:border-box}
  html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{margin:0;background:#e9ecef;color:#000;font-family:Arial,'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR','Noto Sans CJK KR',sans-serif;font-size:${fz(10)};word-break:keep-all;overflow-wrap:anywhere}
  .page{width:210mm;min-height:297mm;margin:16px auto;background:#fff;padding:10mm;box-shadow:0 1px 6px rgba(0,0,0,.15)}
  .noprint{max-width:210mm;margin:16px auto 0;display:flex;gap:8px}
  .noprint button{font:13px/1.2 -apple-system,'Malgun Gothic',sans-serif;padding:8px 14px;border:1px solid #bbb;border-radius:8px;background:#fff;cursor:pointer}
  table{border-collapse:collapse;width:100%;table-layout:fixed}
  td,th{padding:0 0.6mm;vertical-align:middle;font-weight:400;text-align:left;line-height:1.25;overflow:hidden;word-break:keep-all;overflow-wrap:anywhere}
  .head{display:flex}
  .left{width:${(sum(['B', 'C', 'D', 'E']) / ALL * 100).toFixed(3)}%}
  .left td{border:0;padding:0}
  .logo img{display:block;width:${(30.7 * S).toFixed(1)}mm;height:auto}
  .logo{vertical-align:top}
  .title{text-align:center;font-weight:700;font-size:${fz(16)}}
  .to{font-size:${fz(12)};white-space:pre-line}
  .date{font-size:${fz(11)}}
  .box{border:2px solid ${LINE}}
  .box td,.box th{border:1px solid ${LINE}}
  .sup{width:${(sum(['F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P']) / ALL * 100).toFixed(3)}%}
  .sup .v{text-align:center;font-weight:700;padding:0}
  .sup .vt{display:inline-block;writing-mode:vertical-rl;transform:rotate(180deg);letter-spacing:.08em}
  .sup th{text-align:center;letter-spacing:-0.02em}
  .sup td{letter-spacing:-0.02em}
  .fit,.fitw{white-space:pre}
  .c{text-align:center}
  .r{text-align:right}
  .s9{font-size:${fz(9)}}
  .s10{font-size:${fz(10)}}
  .fill{background:${FILL}}
  .pre{white-space:pre-line}
  .ceo{display:flex;justify-content:space-between;gap:2mm}
  .r7{display:flex;justify-content:space-between;align-items:center;gap:4mm;min-height:${mm(13.5)};font-size:${fz(9)}}
  .r7 .mark{font-weight:700;text-align:right}
  .info th,.info td{font-size:${fz(9)}}
  .info .nob{border-left:0;border-right:0}
  .info .u{text-decoration:underline}
  .gap{height:${mm(15.75)}}
  .items th{text-align:center;font-weight:700;background:${FILL};font-size:${fz(10)}}
  .items td{font-size:${fz(10)}}
  .items tr{break-inside:avoid}
  .items .t{font-size:${fz(9)};white-space:pre-line}
  .items .num{text-align:right;white-space:nowrap}
  .items .tot td{font-size:${fz(9)}}
  .items .tot .lab{text-align:center;font-weight:700;background:${FILL};font-size:${fz(10)}}
  .note{margin:3mm 0 0;font-size:${fz(8.5)};line-height:1.5;white-space:pre-line}
  @media print{body{background:#fff}.page{margin:0;box-shadow:none;width:auto;min-height:0;padding:0}.noprint{display:none}}
`;

/**
 * 칸에 맞춤 — 엑셀의 '셀에 맞춤'처럼, 넘치는 칸은 글자를 조금씩(4%씩) 줄인다.
 * 글꼴이 기기마다 달라도 '과학기술서비/스업' 처럼 낱말 중간에서 끊기지 않게 하려는 것.
 *   .fit  (라벨·공급자 고정 글자): 한 줄 유지, 최대 12번 줄인다.
 *   .fitw (고객·담당자가 넣은 값): 4번까지 줄여도 넘치면 낱말 단위로 줄을 바꾼다(칸이 늘어난다 — 글자를 자르지 않는다).
 * 창을 연 쪽이 새 창의 document 를 넘겨 부른다(quote-doc.ts openDoc). 인쇄를 부르지 않는다.
 * @param {Document} doc
 */
export function fitCells(doc) {
  const view = doc?.defaultView;
  if (!view) return;
  doc.querySelectorAll('.fit, .fitw').forEach((e) => {
    const el = /** @type {HTMLElement} */ (e);
    const wrap = el.classList.contains('fitw');
    const over = () => el.scrollWidth > el.clientWidth + 0.5;
    let size = parseFloat(view.getComputedStyle(el).fontSize);
    for (let n = 0; n < (wrap ? 4 : 12) && over(); n++) {
      size *= 0.96;
      el.style.fontSize = `${size.toFixed(2)}px`;
    }
    if (wrap && over()) el.style.whiteSpace = 'pre-line';
  });
}

// ── 조각 ──────────────────────────────────────────────────────────────────────────
/** 머리 왼쪽(B..E): 로고 · 제목 · 귀하/참조 · 날짜 — 행 높이는 엑셀 2~6행(30·30·30·36·30pt) */
function headLeft({ logoUrl, title, to, date }) {
  return `<table class="left">
      <tr style="height:${mm(60)}"><td class="logo"><img src="${esc(logoUrl)}" alt="VanaM"></td></tr>
      <tr style="height:${mm(30)}"><td class="title">${esc(title)}</td></tr>
      <tr style="height:${mm(36)}"><td class="to">${esc(to)}</td></tr>
      <tr style="height:${mm(30)}"><td class="date">${esc(date)}</td></tr>
    </table>`;
}

const SUP_BASE = sum(['F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P']);
const SUP_COLS = `<colgroup><col style="width:${pct(['F'], SUP_BASE)}"><col style="width:${pct(['G', 'H'], SUP_BASE)}">` +
  `<col style="width:${pct(['I', 'J', 'K'], SUP_BASE)}"><col style="width:${pct(['L', 'M', 'N'], SUP_BASE)}">` +
  `<col style="width:${pct(['O', 'P'], SUP_BASE)}"></colgroup>`;
const SUP_H = [30, 30, 30, 36, 30];
/**
 * 머리 오른쪽(F..P) 5줄 칸. 줄마다 [칸] (값이 I..P 전체) 또는 [칸, 칸] (I..K · O..P) — 엑셀 2~6행과 같은 병합.
 * 칸: { l: 라벨, v: 값, c?: 가운데, s9?: 9pt, ceo?: 대표자("(인)" 붙임), fixed?: 고정 글자(공급자) — 아니면 넣은 값(.fitw) }
 * @param {string} vlabel 세로 라벨(공급자·요청자 / Supplier·Requester)
 * @param {{l:string,v:string,c?:boolean,s9?:boolean,ceo?:boolean,fixed?:boolean}[][]} rows
 */
function sideBox(vlabel, rows) {
  const vl = /^[\x20-\x7e]+$/.test(vlabel) ? `<span class="vt">${esc(vlabel)}</span>` : vlabel.split('').map(esc).join('<br>');
  const tr = rows.map((cells, i) => {
    const h = `height:${mm(SUP_H[i])}`;
    const first = i === 0 ? `<td class="v s10" rowspan="5">${vl}</td>` : '';
    const td = (c, span) => {
      const cls = [c.c ? 'c' : '', c.s9 ? 's9' : 's10', c.fixed ? 'fit' : 'fitw'].filter(Boolean).join(' ');
      const val = c.ceo ? `<span class="ceo"><span>${esc(c.v)}</span><span>(인)</span></span>` : esc(c.v);
      return `<td class="${cls}"${span ? ` colspan="${span}"` : ''}>${val}</td>`;
    };
    return cells.length === 1
      ? `<tr style="${h}">${first}<th class="s10 fit">${esc(cells[0].l)}</th>${td(cells[0], 3)}</tr>`
      : `<tr style="${h}">${first}<th class="s10 fit">${esc(cells[0].l)}</th>${td(cells[0])}<th class="s10 fit">${esc(cells[1].l)}</th>${td(cells[1])}</tr>`;
  }).join('\n      ');
  return `<table class="box sup">${SUP_COLS}
      ${tr}
    </table>`;
}

/** 공급자 칸(한글) — 엑셀 글자 그대로. 5번째 줄만 문서마다 다르다(견적서: 담당자·연락처 / 주문서: 연락처). */
function supplierKoRows(company, last) {
  const s = SUPPLIER_DOC_KO;
  return [
    [{ l: '사업자번호', v: str(company?.bizNo), c: true, fixed: true }],
    [{ l: '상     호', v: s.name, fixed: true }, { l: '대 표 자', v: s.ceo, ceo: true, fixed: true }],
    [{ l: '소 재 지', v: s.address, fixed: true }],
    [{ l: '업     태', v: s.bizType, s9: true, fixed: true }, { l: '종     목', v: s.bizItem, s9: true, fixed: true }],
    last,
  ];
}
/** 공급자 칸(영문) — company.json 의 영문 값 */
function supplierEnRows(company, contact) {
  const g = (k) => str(company?.[k]);
  return [
    [{ l: 'Reg. No.', v: g('bizNo'), c: true, fixed: true }],
    [{ l: 'Company', v: g('nameEn'), fixed: true }],
    [{ l: 'CEO', v: g('ceoEn'), fixed: true }],
    [{ l: 'Address', v: g('addressEn'), s9: true, fixed: true }],
    [{ l: 'Contact', v: contact }],
  ];
}

const INFO_COLS = `<colgroup><col style="width:${pct(['B'], ALL)}"><col style="width:${pct(['C'], ALL)}">` +
  `<col style="width:${pct(['D', 'E', 'F', 'G', 'H'], ALL)}"><col style="width:${pct(['I'], ALL)}"><col style="width:${pct(['J'], ALL)}">` +
  `<col style="width:${pct(['K', 'L', 'M', 'N', 'O'], ALL)}"><col style="width:${pct(['P'], ALL)}"></colgroup>`;
/**
 * 정보 칸(엑셀 8~11행, 18.75pt) + 선택: 합계 금액 줄(12행, 30pt)
 * total.words 가 있으면 엑셀처럼 '일금 … 원정 ₩ 금액'(원화), 없으면 금액만(달러·영문).
 * @param {[string, string][]} rows @param {{label:string, words?:string, amount:string}|null} total
 */
function infoBox(rows, total) {
  const r = rows.map(([l, v]) => `<tr style="height:${mm(18.75)}"><th>${esc(l)}</th><td class="pre" colspan="6">${esc(v)}</td></tr>`);
  if (total) {
    r.push(total.words !== undefined
      ? `<tr style="height:${mm(30)}"><th class="fill c pre">${esc(total.label)}</th><td class="nob">일금</td>` +
        `<td class="nob r"><span class="u">${esc(total.words)}</span></td><td class="nob">원정</td><td class="nob">₩</td>` +
        `<td class="nob r">${esc(total.amount)}</td><td class="nob"></td></tr>`
      : `<tr style="height:${mm(30)}"><th class="fill c pre">${esc(total.label)}</th><td class="nob" colspan="4"></td>` +
        `<td class="nob r">${esc(total.amount)}</td><td class="nob"></td></tr>`);
  }
  return `<table class="box info">${INFO_COLS}
    ${r.join('\n    ')}
  </table>`;
}

/**
 * 표(엑셀 14~30행 모양): 머리 · 본문 · 합계. 본문은 **넣은 줄만큼만** 그린다 — 빈 줄로 채우지 않는다(10-01 사용자 요청).
 * 줄 높이는 엑셀 기본 22.5pt 를 최소로 하고, 두 줄 이상인 칸은 그만큼 늘어난다.
 * 줄이 많으면 2쪽으로 넘어가며 머리(thead)가 다시 나온다(줄 하나가 두 쪽에 걸쳐 잘리지 않게 한다). 줄이 없으면 표를 그리지 않는다.
 * 합계 줄은 본문 마지막 줄로 둔다 — tfoot 은 브라우저가 인쇄할 때 쪽마다 되풀이해, 1쪽 아래에 '합계'가 끼어 보인다.
 * @param {{cols:string[][], head:string[], rows:{v:string, k?:string}[][], foot?:{label:string, span:number, cells:string[]}}} t
 */
function table(t) {
  if (!t.rows.length) return '';
  const colg = `<colgroup>${t.cols.map((cs) => `<col style="width:${pct(cs, ALL)}">`).join('')}</colgroup>`;
  const h = `height:${mm(22.5)}`;
  const body = t.rows.map((row) => `<tr style="${h}">${row.map((c) => `<td${c.k ? ` class="${c.k}"` : ''}>${esc(c.v)}</td>`).join('')}</tr>`);
  const foot = t.foot
    ? `<tr class="tot" style="${h}"><td class="lab" colspan="${t.foot.span}">${esc(t.foot.label)}</td>` +
      `${t.foot.cells.map((v) => `<td class="num">${esc(v)}</td>`).join('')}</tr>`
    : '';
  return `<table class="box items">${colg}
    <thead><tr style="${h}">${t.head.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead>
    <tbody>${body.join('')}${foot}</tbody>
  </table>`;
}

const UI = {
  ko: { print: '인쇄 / PDF 저장', close: '닫기' },
  en: { print: 'Print / Save as PDF', close: 'Close' },
};

/** 문서 한 장 — 버튼(#vn-doc-print · #vn-doc-close)은 창을 연 쪽이 연결한다(문서 안에 스크립트 없음) */
function page({ lang, docTitle, head, r7left, r7mark, info, tableHtml, note }) {
  const u = UI[lang === 'en' ? 'en' : 'ko'];
  return `<!doctype html><html lang="${lang === 'en' ? 'en' : 'ko'}"><head><meta charset="utf-8"><title>${esc(docTitle)}</title>
<style>${STYLE}</style></head><body>
<div class="noprint"><button type="button" id="vn-doc-print">🖨 ${esc(u.print)}</button><button type="button" id="vn-doc-close">${esc(u.close)}</button></div>
<div class="page">
  <div class="head">
    ${head}
  </div>
  <div class="r7"><span>${esc(r7left)}</span><span class="mark">${esc(r7mark ?? '')}</span></div>
  ${info}${tableHtml ? `\n  <div class="gap"></div>\n  ${tableHtml}` : ''}${note ? `\n  <p class="note">${esc(note)}</p>` : ''}
</div>
</body></html>`;
}

// ── 견적서 ─────────────────────────────────────────────────────────────────────────
const QCOLS = [['B', 'C', 'D'], ['E', 'F', 'G'], ['H', 'I'], ['J', 'K', 'L'], ['M', 'N', 'O'], ['P']];
/** 영문 견적서 단위 — 담당자 화면 단위 목록(quote-editor.js UNITS)의 한글 단위를 영문으로. 영문 단위(EA·BOX·pt)는 그대로. */
const unitEn = (qty, unit) => {
  const u = String(unit ?? '');
  if (u === '회') return Number(qty) === 1 ? 'run' : 'runs';
  if (u === '개' || u === '장') return 'pcs';
  if (u === '식') return 'lot';
  if (u === '시간') return Number(qty) === 1 ? 'hr' : 'hrs';
  return u;
};
/** 수량 칸 — 한글은 수와 단위를 붙여 쓴다(1회 · 2시간 · 3EA), 영문은 띄운다(1 run · 2 hrs) */
const qtyCell = (qty, unit, en) => {
  const q = String(qty ?? '');
  const u = en ? unitEn(qty, unit) : String(unit ?? '');
  return (en ? `${q} ${u}` : `${q}${u}`).trim();
};
/**
 * 서류의 받는 사람(귀하 · To) — 한글은 '소속 이름', 영문은 'Name, Company'(영문 서류의 보통 순서).
 * 견적서 머리(quote-revision defaultDocInfo) · 금액만 있는 견적(조회 화면) · 주문서가 같이 쓴다.
 * @param {unknown} company @param {unknown} name @param {'ko'|'en'|string} lang
 */
export function customerLine(company, name, lang) {
  const c = String(company ?? '').trim();
  const n = String(name ?? '').trim();
  return lang === 'en' ? [n, c].filter(Boolean).join(', ') : [c, n].filter(Boolean).join(' ');
}
const TBC = 'To be confirmed';

/**
 * 견적서 HTML — 엑셀 「견적서」 탭과 같은 배치.
 * o: { info, items, supply, vat, total, totalKorean, logoUrl, lang?, stamp?, note?, fxNote?, currency? }
 *   info  = { customer, ref, title, date, quoteNo, manager, contact, delivery, validDays, payment }
 *   items = 품목 줄(입력 순서). 넣은 품목만 줄로 그린다(null 은 건너뜀).
 *   stamp → 견적번호 줄 오른쪽 굵은 글자(예: 예상 견적 · 확정 전) — 상자를 그리지 않는다(머리 칸 너비를 건드리지 않게)
 *   note·fxNote → 품목표 아래 작은 글씨(같은 쪽 안)
 *   currency 'USD' → 금액 칸에 $ (한글 금액 없음)
 * @param {any} o @param {Record<string, unknown>} company
 */
export function buildQuoteHtml(o, company) {
  const en = o?.lang === 'en';
  const i = o?.info ?? {};
  const isUsd = String(o?.currency ?? '').toUpperCase() === 'USD';
  const amt = (n) => (isUsd ? usd(n) : money(n));
  // 품목은 넣은 줄만(빈 줄 null 은 건너뛴다). 품목 수 상한(15)은 계산 엔진이 이미 지킨다.
  const rows = (o?.items ?? []).filter(Boolean).map((it) => [{ v: it.name, k: 't' }, { v: it.spec, k: 't' },
    { v: qtyCell(it.qty, it.unit, en), k: 'c' },
    { v: amt(it.unitPrice), k: 'num' }, { v: amt(it.supply), k: 'num' }, { v: amt(it.vat), k: 'num' }]);
  const days = str(i.validDays);
  const note = [o?.fxNote, o?.note].map(str).filter(Boolean).join('\n');
  if (!en) {
    return page({
      lang: 'ko', docTitle: `견적서 ${str(i.quoteNo)}`.trim(),
      head: headLeft({ logoUrl: o?.logoUrl, title: '견적서', to: `${str(i.customer)} 귀하\n참조 : ${str(i.ref)}`, date: dateKr(i.date) }) +
        '\n    ' + sideBox('공급자', supplierKoRows(company, [{ l: '담 당 자', v: str(i.manager) }, { l: '연 락 처', v: str(i.contact) }])),
      r7left: `견적번호 : ${str(i.quoteNo)}`, r7mark: str(o?.stamp),
      info: infoBox([['견 적 명', str(i.title)], ['납품기한', str(i.delivery)], ['대금 지불방식', str(i.payment)],
        ['견적 유효기간', days ? `견적일로부터 ${days}일간` : '']],
      isUsd ? { label: '합계 금액\n(공급가액+세액)', amount: amt(o?.total) }
        : { label: '합계 금액\n(공급가액+세액)', words: str(o?.totalKorean), amount: money(o?.total) }),
      tableHtml: table({ cols: QCOLS, head: ['품명', '규격/사양', '수량', '단가', '공급가액', '세액'], rows,
        foot: { label: '최종 합계', span: 4, cells: [amt(o?.supply), amt(o?.vat)] } }),
      note,
    });
  }
  const contact = [i.manager, i.contact].map(str).filter(Boolean).join(' · ');
  return page({
    lang: 'en', docTitle: `Quotation ${str(i.quoteNo)}`.trim(),
    head: headLeft({ logoUrl: o?.logoUrl, title: 'QUOTATION',
      to: `To: ${str(i.customer)}${str(i.ref) ? `\nAttn: ${str(i.ref)}` : ''}`, date: dateEn(i.date) }) +
      '\n    ' + sideBox('Supplier', supplierEnRows(company, contact)),
    r7left: `Quote No. : ${str(i.quoteNo)}`, r7mark: str(o?.stamp),
    info: infoBox([['Title', str(i.title)], ['Delivery', str(i.delivery) || TBC],
      ['Payment terms', str(i.payment) || TBC], ['Validity', days ? `Valid for ${days} days from the quote date` : TBC]],
    { label: 'Total amount\n(supply + VAT)', amount: isUsd ? amt(o?.total) : `₩${money(o?.total)}` }),
    tableHtml: table({ cols: QCOLS, head: ['Item', 'Specification', 'Qty', 'Unit price', 'Supply amount', 'VAT'], rows,
      foot: { label: 'Total', span: 4, cells: [amt(o?.supply), amt(o?.vat)] } }),
    note,
  });
}

/**
 * 금액만 있는 견적(편집기 개정 없이 담당자가 금액만 넣은 예전 방식) → 견적서 데이터(품목 1줄 · 1식).
 * 금액은 부가세 포함으로 받는다(조회 화면 표기 '(부가세 포함)'과 같다).
 * 공급가액 = 금액 ÷ 1.1 반올림(달러는 센트), 세액 = 금액 − 공급가액 → 두 칸의 합이 항상 금액과 같다.
 * @param {{lang:'ko'|'en', id:string, date:string, customer:string, title:string, spec:string, amount:number,
 *   currency?:string, bank?:string, memo?:string, contact?:string}} a
 */
export function quoteFromAmount(a) {
  const en = a.lang === 'en';
  const isUsd = String(a.currency ?? '').toUpperCase() === 'USD';
  const cents = (x) => Math.round(x * 100) / 100;
  const total = isUsd ? cents(Number(a.amount) || 0) : Math.round(Number(a.amount) || 0);
  const supply = isUsd ? cents(total / 1.1) : Math.round(total / 1.1);
  const vat = isUsd ? cents(total - supply) : total - supply;
  const bank = str(a.bank);
  return {
    lang: en ? 'en' : 'ko',
    currency: isUsd ? 'USD' : 'KRW',
    info: {
      customer: str(a.customer), ref: '', title: str(a.title), date: str(a.date), quoteNo: str(a.id),
      manager: '', contact: str(a.contact), delivery: '', validDays: '',
      payment: bank ? (en ? `Bank transfer (${bank})` : `계좌이체 (${bank})`) : '',
    },
    items: [{ name: str(a.title), spec: str(a.spec), qty: 1, unit: '식', unitPrice: supply, supply, vat }],
    supply, vat, total,
    totalKorean: isUsd ? '' : koreanAmount(total),
    stamp: '', note: str(a.memo), fxNote: '',
  };
}

// ── 견적 요청서 ─────────────────────────────────────────────────────────────────────
const RCOLS = [['B'], ['C', 'D', 'E'], ['F', 'G', 'H', 'I'], ['J', 'K', 'L', 'M', 'N'], ['O', 'P']];
const PCOLS = [['B', 'C', 'D'], ['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'], ['M', 'N', 'O'], ['P']];
const REQ = {
  ko: {
    title: '견적 요청서', to: '반암 주식회사 귀중', vlabel: '요청자',
    company: '소     속', name: '성     명', phone: '연 락 처', email: '이 메 일',
    product: '요청 상품', samples: '샘플 수량', qty: '수     량', delivery: '기판 전달', due: '완료 희망',
    no: '접수번호', notSent: '(아직 보내지 않은 요청서)', markDraft: '접수 전',
    substrate: '기 판', preFilm: '박막 증착 여부', analysis: '분석 요청', notes: '요청 사항', ship: '배 송 지', body: '요청 내용',
    yes: '있음', none: '없음', staffNote: '담당자 안내', bank: '입금 계좌', substrateShort: '기판',
    stepHead: ['단계', '공정', '물질 · 가스', '두께 · 시간', '기타 조건'],
    itemHead: ['품명', '규격 · 옵션', '수량', '비고'],
    dicing: '다이싱', dicingYes: (fee, q) => `필요 (+₩${fee.toLocaleString('ko-KR')}/박스 × ${q})`, dicingNo: '불필요',
    boxes: (q) => `${q}박스`,
    shipMemo: '배송 요청',
    noteDraft: (email) => `이 요청서는 아직 접수되지 않았습니다. 내용을 확인하신 뒤 ${email} 로 보내 주시거나, 웹사이트에서 ‘견적 요청하기’를 누르시면 바로 접수됩니다.`,
    noteReceived: '접수된 요청서입니다. 접수번호와 이메일로 진행 상태를 확인하실 수 있습니다.',
  },
  en: {
    title: 'QUOTE REQUEST', to: 'To: VanaM Inc.', vlabel: 'Requester',
    company: 'Company', name: 'Name', phone: 'Phone', email: 'Email',
    product: 'Item', samples: 'Samples', qty: 'Quantity', delivery: 'Delivery', due: 'Target date',
    no: 'Reference No.', notSent: '(not submitted yet)', markDraft: 'NOT SUBMITTED',
    substrate: 'Substrate', preFilm: 'Existing film', analysis: 'Analysis', notes: 'Notes', ship: 'Ship to', body: 'Request',
    yes: 'Yes', none: 'No', staffNote: 'Note from us', bank: 'Bank account', substrateShort: 'Substrate',
    stepHead: ['Step', 'Process', 'Material · Gas', 'Thickness · Time', 'Other conditions'],
    itemHead: ['Item', 'Specification · Option', 'Qty', 'Remarks'],
    dicing: 'Dicing', dicingYes: (fee, q) => `Required (+₩${fee.toLocaleString('en-US')}/box × ${q})`, dicingNo: 'Not required',
    boxes: (q) => `${q} ${q === 1 ? 'box' : 'boxes'}`,
    shipMemo: 'Delivery notes',
    noteDraft: (email) => `This request has NOT been submitted yet. Please review it and email it to ${email}, or press “Request a quote” on the website to submit it directly.`,
    noteReceived: 'This request has been received. You can check its status with the reference number and your email.',
  },
};

/** 공정 단계의 수치 + 단위('10' 'nm' → '10 nm', 수치가 없으면 '') */
const stepValue = (s) => [str(s?.value), str(s?.value) ? str(s?.unit) : ''].filter(Boolean).join(' ');

/**
 * 견적 요청서 데이터 — 견적 폼(접수 전)·완료 화면·조회 화면이 **같은 함수**로 만든다(세 곳의 요청서가 어긋나지 않게).
 * dj = 접수 때 함께 저장하는 구조화 사본(details_json / 폼의 detailsJson): 라벨이 붙기 전의 값.
 *   공정 견적: { seq, measures, delivery(코드), substrateType, substrateSize(코드), substrateGrade, sampleCount, preFilm, preFilmNote, completionDate, notes, ship }
 *   웨이퍼 문의: { wafer: { sku, qty, dicing, dicingFeeKrw } }
 *   구조화 사본이 없는 옛 접수 건은 저장된 문장(detailsText)을 '요청 내용' 한 칸에 그대로 싣는다.
 * 코드값(전달 방식·기판 크기)은 호출부가 넘긴 지도(보는 언어 라벨)로 바꾼다. 자유 입력은 번역하지 않는다.
 * @param {{lang:'ko'|'en', id?:string, draft?:boolean, date:string, statusText?:string,
 *   requester?:{company?:string,name?:string,phone?:string,email?:string}, product?:string,
 *   dj?:any, detailsText?:string, sizeMap?:Record<string,string>, deliveryMap?:Record<string,string>, supportEmail?:string,
 *   staffNote?:string, bank?:string}} a
 *   staffNote·bank = 담당자가 금액 없이 남긴 안내·입금 계좌(조회 화면) — 있으면 정보 칸 맨 아래 줄로 싣는다.
 */
export function requestDocFrom(a) {
  const doc = requestDocCore(a);
  const L = REQ[doc.lang];
  const extra = [[L.staffNote, str(a.staffNote)], [L.bank, str(a.bank)]].filter(([, v]) => v);
  return extra.length ? { ...doc, info: [...doc.info, ...extra] } : doc;
}

/** @param {any} a requestDocFrom 과 같은 인자 */
function requestDocCore(a) {
  const lang = a.lang === 'en' ? 'en' : 'ko';
  const L = REQ[lang];
  const dj = a.dj && typeof a.dj === 'object' ? a.dj : null;
  const r = a.requester ?? {};
  const base = {
    lang, id: str(a.id), draft: Boolean(a.draft), date: str(a.date), statusText: str(a.statusText),
    requester: { company: str(r.company), name: str(r.name), phone: telDisplay(r.phone, lang), email: str(r.email) },
    product: str(a.product),
    note: a.draft ? L.noteDraft(str(a.supportEmail) || 'hello@vanam.co.kr') : L.noteReceived,
  };
  if (dj?.wafer && typeof dj.wafer === 'object') {
    const w = dj.wafer;
    const q = Number(w.qty) || 1;
    const fee = Number(w.dicingFeeKrw) || 0;
    return {
      ...base, kind: 'product', qty: L.boxes(q), delivery: '', due: '',
      info: [[L.body, str(a.detailsText)]],
      items: [{ name: base.product, spec: `${L.dicing}: ${w.dicing ? L.dicingYes(fee, q) : L.dicingNo}`, qty: L.boxes(q), note: '' }],
      steps: [],
    };
  }
  if (dj && Array.isArray(dj.seq)) {
    const sizeMap = a.sizeMap ?? {};
    const deliveryMap = a.deliveryMap ?? {};
    const size = sizeMap[str(dj.substrateSize)] ?? str(dj.substrateSize);
    const substrate = [str(dj.substrateType), size, str(dj.substrateGrade)].filter(Boolean).join(' / ');
    // 박막 증착 여부(0910c) — 이 항목이 생기기 전 접수 건에는 값이 없다. 없으면 지어내지 않고 비운다.
    const preFilm = typeof dj.preFilm === 'boolean'
      ? (dj.preFilm ? [L.yes, str(dj.preFilmNote)].filter(Boolean).join(' — ') : L.none)
      : '';
    const info = [
      [L.substrate, substrate],
      [L.preFilm, preFilm],
      [L.analysis, (Array.isArray(dj.measures) ? dj.measures : []).map(str).filter(Boolean).join(', ')],
      [L.notes, str(dj.notes)],
    ];
    if (dj.ship && typeof dj.ship === 'object') {
      const s = dj.ship;
      info.push([L.ship, [
        [str(s.country) ? `[${str(s.country)}]` : '', [str(s.name), telDisplay(s.phone, lang)].filter(Boolean).join(' · ')].filter(Boolean).join(' '),
        [str(s.zip) ? `(${str(s.zip)})` : '', str(s.addr)].filter(Boolean).join(' '),
        str(s.memo) ? `${L.shipMemo}: ${str(s.memo)}` : '',
      ].filter(Boolean).join('\n')]);
    }
    return {
      ...base, kind: 'process',
      qty: str(dj.sampleCount), delivery: deliveryMap[str(dj.delivery)] ?? str(dj.delivery), due: str(dj.completionDate),
      info,
      steps: dj.seq.map((s) => ({ process: str(s?.process), material: str(s?.material), value: stepValue(s), etc: str(s?.etc) })),
      items: [],
    };
  }
  return { ...base, kind: 'process', qty: '', delivery: '', due: '', info: [[L.body, str(a.detailsText)]], steps: [], items: [] };
}

/**
 * 금액만 있는 예전 견적(품목 1줄)의 규격 칸 — 요청 내용을 줄로 적는다(예전 단순 견적서가 요청 본문을 같이 싣던 것을 대신).
 *   공정 견적: 단계마다 '공정 물질 두께' 한 줄 + 마지막 줄 '기판: …'
 *   웨이퍼 문의: 'N박스 · 다이싱: …'
 *   구조화 사본이 없는 옛 건: fallback(공정 · 기판) 그대로
 * @param {{lang:'ko'|'en', dj?:any, sizeMap?:Record<string,string>, fallback?:string}} a
 */
export function specFromDetails(a) {
  const L = REQ[a.lang === 'en' ? 'en' : 'ko'];
  const dj = a.dj && typeof a.dj === 'object' ? a.dj : null;
  if (dj?.wafer && typeof dj.wafer === 'object') {
    const q = Number(dj.wafer.qty) || 1;
    const fee = Number(dj.wafer.dicingFeeKrw) || 0;
    return `${L.boxes(q)} · ${L.dicing}: ${dj.wafer.dicing ? L.dicingYes(fee, q) : L.dicingNo}`;
  }
  if (dj && Array.isArray(dj.seq) && dj.seq.length) {
    const size = (a.sizeMap ?? {})[str(dj.substrateSize)] ?? str(dj.substrateSize);
    const substrate = [str(dj.substrateType), size, str(dj.substrateGrade)].filter(Boolean).join(' / ');
    const steps = dj.seq.map((s) => [str(s?.process), str(s?.material), stepValue(s)].filter(Boolean).join(' '));
    return [...steps, substrate ? `${L.substrateShort}: ${substrate}` : ''].filter(Boolean).join('\n');
  }
  return str(a.fallback);
}

/**
 * 견적 요청서 HTML — 견적서와 같은 틀. 오른쪽 칸 = 요청자, 표 = 공정 순서(웨이퍼 문의는 품목).
 * o = requestDocFrom(...) 결과 + logoUrl
 * @param {any} o
 */
export function buildRequestHtml(o) {
  const en = o?.lang === 'en';
  const L = REQ[en ? 'en' : 'ko'];
  const r = o?.requester ?? {};
  const product = o?.kind === 'product';
  const draft = Boolean(o?.draft);
  const tableHtml = product
    ? table({ cols: PCOLS, head: L.itemHead,
      rows: (o?.items ?? []).map((it) => [{ v: str(it.name), k: 't' }, { v: str(it.spec), k: 't' }, { v: str(it.qty), k: 'c' }, { v: str(it.note), k: 't' }]) })
    : table({ cols: RCOLS, head: L.stepHead,
      rows: (o?.steps ?? []).map((s, k) => [{ v: String(k + 1), k: 'c' }, { v: str(s.process), k: 't' },
        { v: str(s.material), k: 't' }, { v: str(s.value), k: 't' }, { v: str(s.etc), k: 't' }]) });
  return page({
    lang: en ? 'en' : 'ko',
    docTitle: `${en ? 'Quote request' : '견적 요청서'} ${str(o?.id) || str(o?.date)}`.trim(),
    head: headLeft({ logoUrl: o?.logoUrl, title: L.title, to: L.to, date: en ? dateEn(o?.date) : dateKr(o?.date) }) +
      '\n    ' + sideBox(L.vlabel, [
      [{ l: L.company, v: str(r.company) }],
      [{ l: L.name, v: str(r.name) }, { l: L.phone, v: str(r.phone) }],
      [{ l: L.email, v: str(r.email) }],
      [{ l: L.product, v: str(o?.product) }, { l: product ? L.qty : L.samples, v: str(o?.qty) }],
      [{ l: L.delivery, v: str(o?.delivery) }, { l: L.due, v: str(o?.due) }],
    ]),
    r7left: `${L.no} : ${draft ? L.notSent : str(o?.id)}`,
    r7mark: draft ? L.markDraft : str(o?.statusText),
    info: infoBox((o?.info ?? []).map(([l, v]) => [str(l), str(v)]), null),
    tableHtml,
    note: str(o?.note),
  });
}

// ── 주문서 ─────────────────────────────────────────────────────────────────────────
const OCOLS = [['B', 'C', 'D'], ['E', 'F', 'G'], ['H', 'I'], ['J', 'K', 'L'], ['M', 'N', 'O', 'P']];
const ORD = {
  ko: {
    title: '주문서', no: '주문번호', status: '주문 상태', pay: '결 제', ship: '배 송 지', tax: '세금계산서',
    taxYes: '요청함', taxNo: '요청 안 함', bank: '계좌이체', paypal: 'PayPal (USD)',
    paidBank: (d) => `${d} 입금 확인`, paidPaypal: (d) => `${d} 결제`,
    total: '합계 금액\n(부가세 포함)', head: ['품명', '규격 · 옵션', '수량', '단가', '금액(부가세 포함)'], foot: '합계',
    dicing: '다이싱', perBox: '박스당', noDicing: '다이싱 불필요', boxes: (q) => `${q}박스`,
    notePaypal: 'PayPal 결제는 주문 시점 환율로 정해진 USD 금액으로 이뤄지며, 표의 금액은 원화(부가세 포함) 기준입니다.',
  },
  en: {
    title: 'ORDER', no: 'Order No.', status: 'Status', pay: 'Payment', ship: 'Ship to', tax: 'Tax invoice',
    taxYes: 'Requested', taxNo: 'Not requested', bank: 'Bank transfer', paypal: 'PayPal (USD)',
    paidBank: (d) => `paid on ${d}`, paidPaypal: (d) => `paid on ${d}`,
    total: 'Total amount\n(VAT incl.)', head: ['Item', 'Specification · Option', 'Qty', 'Unit price', 'Amount (VAT incl.)'], foot: 'Total',
    dicing: 'Dicing', perBox: 'per box', noDicing: 'No dicing', boxes: (q) => `${q} ${q === 1 ? 'box' : 'boxes'}`,
    notePaypal: 'PayPal payments are made in USD at the exchange rate fixed when the order was placed. Amounts in this sheet are in KRW, VAT included.',
  },
};

/**
 * 주문서 데이터 — 조회 API 의 주문(o)·항목(items)에서. 금액은 원화(부가세 포함), PayPal 이면 USD 금액을 결제 칸에.
 * 웨이퍼 다이싱은 별도 줄(다이싱 · 박스당 · 수량 · 단가 · 금액)로 — 줄 금액의 합이 항상 항목 소계(subtotal)와 같다.
 * @param {{lang:'ko'|'en', order:any, items:any[], statusText:string, noShipText:string, email:string}} a
 */
export function orderDocFrom(a) {
  const lang = a.lang === 'en' ? 'en' : 'ko';
  const L = ORD[lang];
  const o = a.order ?? {};
  const rows = [];
  for (const i of a.items ?? []) {
    const wafer = String(i?.sku ?? '').startsWith('wafer:');
    const qty = Number(i?.qty) || 0;
    const unit = Number(i?.unit_price) || 0;
    const fee = wafer && Number(i?.dicing) === 1 ? Number(i?.dicing_fee) || 0 : 0;
    const subtotal = Number.isFinite(Number(i?.subtotal)) ? Number(i.subtotal) : (unit + fee) * qty;
    const qtyText = wafer ? L.boxes(qty) : String(qty);
    rows.push({ name: str(i?.name), spec: wafer && fee === 0 ? L.noDicing : '', qty: qtyText, unitPrice: unit, amount: subtotal - fee * qty });
    if (fee > 0) rows.push({ name: L.dicing, spec: L.perBox, qty: qtyText, unitPrice: fee, amount: fee * qty });
  }
  const paidDate = o.paid_at ? (lang === 'en' ? dateEn(ymdLocal(o.paid_at)) : dateKr(ymdLocal(o.paid_at))) : '';
  const usdAmount = Number(o.paid_usd) > 0 ? Number(o.paid_usd) : Number(o.amount_usd) > 0 ? Number(o.amount_usd) : null;
  const pay = String(o.pay_method ?? '') === 'bank'
    ? [L.bank, paidDate ? L.paidBank(paidDate) : ''].filter(Boolean).join(' · ')
    : [L.paypal, usdAmount !== null ? usd(usdAmount) : '', paidDate ? L.paidPaypal(paidDate) : ''].filter(Boolean).join(' · ');
  const addr = [o.ship_addr1, o.ship_addr2, o.ship_city, o.ship_state].map(str).filter(Boolean).join(', ');
  const shipTo = o.needs_shipping
    ? [
      [str(o.ship_country) ? `[${str(o.ship_country)}]` : '', [str(o.ship_name), telDisplay(o.ship_phone, lang)].filter(Boolean).join(' · ')].filter(Boolean).join(' '),
      [str(o.ship_zip) ? `(${str(o.ship_zip)})` : '', addr].filter(Boolean).join(' '),
    ].filter(Boolean).join('\n')
    : str(a.noShipText);
  const who = customerLine(o.buyer_company, o.buyer_name, lang);
  return {
    lang, id: str(o.id), date: ymdLocal(o.created_at), customer: who, email: str(a.email),
    info: [[L.status, str(a.statusText)], [L.pay, pay], [L.ship, shipTo], [L.tax, o.tax_invoice ? L.taxYes : L.taxNo]],
    items: rows,
    total: Number(o.amount) || 0,
    totalKorean: koreanAmount(Number(o.amount) || 0),
    note: String(o.pay_method ?? '') === 'bank' ? '' : L.notePaypal,
  };
}

/**
 * 주문서 HTML — 견적서와 같은 틀. 금액은 원화(부가세 포함).
 * o = orderDocFrom(...) 결과 + logoUrl
 * @param {any} o @param {Record<string, unknown>} company
 */
export function buildOrderHtml(o, company) {
  const en = o?.lang === 'en';
  const L = ORD[en ? 'en' : 'ko'];
  const rows = (o?.items ?? []).map((it) => [{ v: str(it.name), k: 't' }, { v: str(it.spec), k: 't' },
    { v: str(it.qty), k: 'c' }, { v: money(it.unitPrice), k: 'num' }, { v: money(it.amount), k: 'num' }]);
  const tel = en ? str(company?.tel) : telKr(company?.tel);
  const contact = [tel, str(company?.email)].filter(Boolean).join('  ·  ');
  const who = str(o?.customer);
  const to = [who ? (en ? `To: ${who}` : `${who} 귀하`) : '', str(o?.email)].filter(Boolean).join('\n');
  return page({
    lang: en ? 'en' : 'ko', docTitle: `${en ? 'Order' : '주문서'} ${str(o?.id)}`.trim(),
    head: headLeft({ logoUrl: o?.logoUrl, title: L.title, to, date: en ? dateEn(o?.date) : dateKr(o?.date) }) +
      '\n    ' + sideBox(en ? 'Supplier' : '공급자', en
        ? supplierEnRows(company, contact)
        : supplierKoRows(company, [{ l: '연 락 처', v: contact }])),
    r7left: `${L.no} : ${str(o?.id)}`, r7mark: '',
    info: infoBox((o?.info ?? []).map(([l, v]) => [str(l), str(v)]),
      en ? { label: L.total, amount: `₩${money(o?.total)}` } : { label: L.total, words: str(o?.totalKorean), amount: money(o?.total) }),
    tableHtml: table({ cols: OCOLS, head: L.head, rows, foot: { label: L.foot, span: 4, cells: [money(o?.total)] } }),
    note: str(o?.note),
  });
}
