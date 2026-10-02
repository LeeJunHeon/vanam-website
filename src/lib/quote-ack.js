// 견적 요청 접수 확인 메일 — 순수 모듈(.js). 워커(quote-ack-run.ts)와 node 테스트가 같이 쓴다.
//
// 공정 견적 요청(type 'quote')이 접수되면 고객에게 hello@vanam.co.kr 로 확인 메일을 보낸다(10-01 사용자 요청).
//   내용: 정상 접수 · 담당자 확인 후 영업일 기준 2일 이내 회신 · 접수번호 · 조회 링크(누르면 이메일까지 채워 바로 조회 — lookupLink)
//   첨부: 견적 요청서(사이트의 엑셀 틀 그대로, 금액 칸 없음) PDF 하나.
//         자동 견적이 '예상 견적'으로 나온 건이면 예상 견적서를 앞쪽에 붙인 PDF 하나(고객 완료·조회 화면과 같은 내용).
//   일반 문의(type 'general')에는 보내지 않는다.
// 여기서는 화면·네트워크를 만지지 않는다 — 문구·HTML 조립·판정만. 넣는 값은 전부 이스케이프한다.
import { safeShort } from './safe-text.js';

const esc = (v) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (v) => (v == null ? '' : String(v).trim());
/** {자리} 채우기(문구는 site.json quote.view 와 같은 형식) */
const fill = (tpl, vars) => String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
/** HTML 용 채우기 — 문구·값 모두 이스케이프하고, 값은 한 덩어리로(날짜 '2026-10-15' 가 줄 끝에서 하이픈으로 갈라지지 않게) */
const fillHtml = (tpl, vars) => esc(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? `<span style="white-space:nowrap">${esc(vars[k])}</span>` : m));

/** 회사 메일 도메인 — 테스트 빌드는 이 도메인 주소로만 보낸다 */
export const ACK_DOMAIN = 'vanam.co.kr';

/**
 * 이 빌드에서 이 주소로 보내도 되는가. (발송 통로 mail-send.ts 가 보내기 직전에 한 번 더 부른다)
 *   운영 빌드: 단순한 주소 모양이면 보낸다.
 *   테스트 빌드(맥미니·로컬·기타): @vanam.co.kr 주소만 — 고객 주소는 막는다.
 * @param {boolean} live @param {unknown} to @param {(a: unknown) => boolean} isSafeAddress mail-mime.js 의 것
 * @returns {{ok: true} | {ok: false, reason: 'bad_recipient' | 'blocked_build'}}
 */
export function mailAllowed(live, to, isSafeAddress) {
  if (!isSafeAddress(to)) return { ok: false, reason: 'bad_recipient' };
  if (live) return { ok: true };
  const domain = String(to).split('@').pop()?.toLowerCase() ?? '';
  return domain === ACK_DOMAIN ? { ok: true } : { ok: false, reason: 'blocked_build' };
}

/**
 * 운영 빌드는 운영 주소(https://vanam.co.kr · www)로 들어온 요청에서만 보낸다.
 * 운영 빌드 결과물(dist)을 맥미니 등에서 직접 띄웠을 때 로컬 DB 의 고객에게 메일이 나가는 길을 막는다.
 * 테스트 빌드는 주소와 무관(받는 주소를 회사 주소로 이미 막는다).
 * @param {boolean} live @param {unknown} origin 요청이 들어온 주소(프로토콜+호스트)
 */
export function hostAllowed(live, origin) {
  return !live || /^https:\/\/(?:www\.)?vanam\.co\.kr$/.test(String(origin ?? ''));
}

/**
 * 메일의 [진행 상태 조회] 링크.
 *   주소: 운영 빌드는 고정 주소(site) · 테스트 빌드는 요청이 들어온 주소(맥미니 로컬에서 바로 열리게 — 프로토콜+호스트 모양일 때만).
 *   접수번호는 ?id= 로(조회 화면이 칸을 채운다) · 이메일은 # 뒤에(#e=) — # 뒤는 브라우저가 서버로 보내지 않아
 *   서버 로그·리퍼러에 남지 않는다. 조회 화면(OrderLookup.astro)이 읽어 이메일 칸을 채우고 바로 조회한 뒤 주소창에서 지운다.
 *   ⚠️ 이 링크는 '접수번호 + 이메일'을 다 담은 열쇠다 — 링크를 전달받은 사람도 같은 조회를 할 수 있고,
 *   브라우저 방문 기록에는 처음 주소가 남을 수 있다(손으로 두 값을 넣어 조회하는 것과 같은 수준).
 * @param {{ live: boolean, site: string, origin?: unknown, lang: 'ko'|'en', id: unknown, email?: unknown }} a
 */
export function lookupLink(a) {
  const origin = String(a.origin ?? '');
  const base = a.live ? a.site : (/^https?:\/\/[^/]+$/.test(origin) ? origin : a.site);
  const email = str(a.email);
  return `${base}${a.lang === 'ko' ? '/ko' : ''}/order/lookup?id=${encodeURIComponent(str(a.id))}` +
    (email ? `#e=${encodeURIComponent(email)}` : '');
}

// 고객이 넣은 짧은 글(이름·소속·상품)을 메일에 실을 때 — 길이를 줄이고 주소 모양은 링크가 되지 않게 바꾼다.
// 회사 메일(hello@)로 나가는 글이라, 남의 주소로 접수해 피싱 링크를 실어 보내는 것을 막는다.
// (조회 화면도 같은 규칙을 쓴다 — 그래서 safe-text.js 로 따로 뗐다)
export { safeShort };

/** ISO 시각 → 한국 시간 'YYYY-MM-DD HH:mm' (형식이 이상하면 빈 문자열) */
export function kstText(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '';
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** 첨부 파일 이름 @param {'ko'|'en'} lang @param {string} id @param {boolean} withQuote */
export function attachmentName(lang, id, withQuote) {
  const no = str(id).replace(/[^A-Z0-9-]/gi, '');
  if (lang === 'en') return withQuote ? `VanaM_Estimate_and_Request_${no}.pdf` : `VanaM_Quote_Request_${no}.pdf`;
  return withQuote ? `예상견적서_견적요청서_${no}.pdf` : `견적요청서_${no}.pdf`;
}

/**
 * 고객 견적 요약(customerQuoteView) → 메일에 실을 예상 견적. '예상 견적' 상태일 때만(담당자 확인·확정·없음은 null).
 * @param {any} view
 */
export function estimateOf(view) {
  // 금액 두 가지(원화·달러 환산)가 다 있을 때만 — 고객 화면의 견적 상자와 같은 조건(customerQuoteView 는 늘 둘 다 준다)
  if (!view || view.state !== 'estimate' || !str(view.totalKrwText) || !str(view.totalUsdText)) return null;
  return {
    krw: str(view.totalKrwText), usd: str(view.totalUsdText),
    validDays: view.validDays ?? null, validUntil: str(view.validUntil),
  };
}

const TEXT = {
  ko: {
    subject: (id) => `[반암] 견적 요청이 접수되었습니다 (${id})`,
    testSubject: '[테스트] ',
    title: '견적 요청이 접수되었습니다',
    hello: (who) => `${who} 님, 안녕하세요. 반암(VanaM)입니다.`,
    lead: '견적 요청이 정상적으로 접수되었습니다. 담당자가 요청 내용을 확인한 뒤 영업일 기준 2일 이내에 회신드리겠습니다.',
    no: '접수번호', item: '요청 상품', at: '접수 일시', atSuffix: ' (한국 시간)',
    attachQuote: '첨부: 예상 견적서와 견적 요청서(PDF 1개)',
    attachRequest: '첨부: 견적 요청서(PDF) — 접수하신 내용을 반암 견적서 양식에 금액 없이 정리했습니다.',
    attachNone: '견적 요청서는 아래 조회 화면에서 인쇄하거나 PDF로 저장하실 수 있습니다.',
    // 버튼 이름은 사이트(완료 화면 버튼·조회 화면 '진행 상태')와 같게
    lookup: '아래 버튼을 누르면 진행 상태를 바로 확인하실 수 있습니다.',
    button: '진행 상태 조회',
    reply: '이 메일에 바로 답장하셔도 담당자에게 전달됩니다.',
    company: '반암주식회사',
    test: '테스트 빌드에서 보낸 메일입니다. 운영 사이트가 아니며 회사 주소(@vanam.co.kr)로만 발송됩니다.',
  },
  en: {
    subject: (id) => `[VanaM] We received your quote request (${id})`,
    testSubject: '[TEST] ',
    title: 'We received your quote request',
    hello: (who) => `Dear ${who},`,
    lead: 'Thank you for your quote request. We have received it, and our team will review it and reply within 2 business days.',
    no: 'Reference No.', item: 'Item', at: 'Received', atSuffix: ' KST',
    // 문서 이름은 견적 폼 버튼('Download request sheet')과 같게 — request sheet
    attachQuote: 'Attached: the estimated quotation and your request sheet (one PDF).',
    attachRequest: 'Attached: your request sheet (PDF), laid out in our quotation format without prices.',
    attachNone: 'You can print your request sheet or save it as a PDF from the status page below.',
    lookup: 'Use the button below to check the status of your request at any time.',
    button: 'Check status',
    reply: 'You can reply directly to this email to reach our team.',
    company: 'VanaM Inc.',
    test: 'Sent from a test build — not the live site. Only company addresses (@vanam.co.kr) receive it.',
  },
};

// 사이트 라이트 테마와 같은 색(global.css): 먹색 · 시안(글자용 #0c7192 · 버튼 채움 #1ebbf0)
const C = { ink: '#0a0e13', sub: '#5a6169', line: '#e2e6ea', soft: '#f6f8fa', accent: '#0c7192', brand: '#1ebbf0', onbrand: '#06222c', page: '#eef1f4' };
const FONT = "-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',Arial,sans-serif";

/**
 * 확인 메일 제목·본문(텍스트·HTML).
 * @param {{
 *   lang: 'ko'|'en', live: boolean,
 *   id: string, name: string, company?: string, product?: string, receivedAt?: string,
 *   estimate: ReturnType<typeof estimateOf>, T: Record<string, string>,
 *   attachment: 'quote' | 'request' | null,
 *   lookupUrl: string, tel: string, email: string, site: string,
 * }} a  T = site.json quote.view(고객 화면과 같은 문구) · attachment = 실제로 붙인 PDF 종류(못 붙였으면 null)
 * @returns {{subject: string, text: string, html: string}}
 */
export function ackContent(a) {
  const en = a.lang === 'en';
  const L = TEXT[en ? 'en' : 'ko'];
  const T = a.T ?? {};
  // 고객이 넣은 글은 짧게 · 주소 모양은 링크가 안 되게(safeShort)
  const name = safeShort(a.name, 40);
  const who = en ? (name || 'Customer') : [safeShort(a.company, 60), name].filter(Boolean).join(' ') || '고객';
  const at = kstText(a.receivedAt);
  const rows = [[L.no, str(a.id)], [L.item, safeShort(a.product, 80)], [L.at, at ? `${at}${L.atSuffix}` : '']].filter(([, v]) => v);
  const est = a.estimate;
  const estVars = est ? { krw: est.krw, usd: est.usd } : null;
  const estLines = est
    ? [
      str(T.estimate),
      `${fill(T.totalMain, estVars)} (${fill(T.totalMeta, estVars)})`,
      est.validDays && est.validUntil ? fill(T.valid, { days: est.validDays, date: est.validUntil }) : '',
      str(T.notice),
    ].filter(Boolean)
    : [];
  const attachLine = a.attachment === 'quote' ? L.attachQuote : a.attachment === 'request' ? L.attachRequest : L.attachNone;
  const subject = `${a.live ? '' : L.testSubject}${L.subject(str(a.id))}`;
  const site = str(a.site).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const footer = [L.company, str(a.email), str(a.tel), site].filter(Boolean).join(' · ');

  const text = [
    a.live ? '' : `※ ${L.test}\n`,
    L.hello(who),
    '',
    L.lead,
    '',
    ...rows.map(([l, v]) => `${l}: ${v}`),
    ...(estLines.length ? ['', ...estLines] : []),
    '',
    attachLine,
    '',
    // 글 본문에는 버튼이 없다 — 버튼 이름 + 주소 한 줄
    `${L.button}: ${str(a.lookupUrl)}`,
    '',
    L.reply,
    '',
    '--',
    footer,
  ].filter((x, i) => !(i === 0 && x === '')).join('\n');

  const p = (s, style = '') => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:${C.ink};${style}">${s}</p>`;
  const infoRows = rows.map(([l, v]) => `<tr><td style="width:104px;padding:6px 16px 6px 0;font-size:13px;color:${C.sub};white-space:nowrap;vertical-align:top">${esc(l)}</td>` +
    `<td style="padding:6px 0;font-size:14px;color:${C.ink}">${esc(v)}</td></tr>`).join('');
  const estHtml = est
    ? `<div style="margin:20px 0;border:1px solid ${C.line};border-radius:12px;background:${C.soft};padding:18px 20px">` +
      `<div style="font-size:12px;font-weight:600;letter-spacing:.08em;color:${C.accent}">${esc(T.estimate)}</div>` +
      `<div style="margin-top:6px"><span style="font-size:24px;font-weight:700;color:${C.ink}">${fillHtml(T.totalMain, estVars)}</span>` +
      `<span style="margin-left:8px;font-size:13px;color:${C.sub}">${fillHtml(T.totalMeta, estVars)}</span></div>` +
      (est.validDays && est.validUntil ? `<div style="margin-top:4px;font-size:13px;color:${C.sub}">${fillHtml(T.valid, { days: est.validDays, date: est.validUntil })}</div>` : '') +
      `<div style="margin-top:12px;border-top:1px solid ${C.line};padding-top:12px;font-size:13px;line-height:1.65;color:${C.sub}">${esc(T.notice)}</div>` +
      `</div>`
    : '';
  const banner = a.live ? ''
    : `<div style="margin:0 0 20px;border-radius:8px;background:#fff4e0;padding:10px 14px;font-size:13px;line-height:1.6;color:#7a4a00">${esc(L.test)}</div>`;
  const html = `<!doctype html><html lang="${en ? 'en' : 'ko'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${C.page};font-family:${FONT};word-break:keep-all">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${C.page}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid ${C.line};border-radius:14px">` +
    `<tr><td style="padding:28px 28px 8px">` +
    `<div style="font-size:15px;font-weight:700;letter-spacing:.02em;color:${C.ink}">VanaM<span style="margin-left:6px;font-weight:400;color:${C.sub}">${en ? '' : '반암'}</span></div>` +
    `</td></tr><tr><td style="padding:12px 28px 28px">` +
    banner +
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.4;color:${C.ink}">${esc(L.title)}</h1>` +
    p(esc(L.hello(who))) +
    p(esc(L.lead)) +
    `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:6px 0 4px;border-top:1px solid ${C.line};border-bottom:1px solid ${C.line};width:100%">${infoRows}</table>` +
    estHtml +
    p(esc(attachLine), `margin-top:18px;font-size:14px;color:${C.sub}`) +
    p(esc(L.lookup), 'font-size:14px') +
    `<p style="margin:0 0 20px"><a href="${esc(a.lookupUrl)}" style="display:inline-block;border-radius:8px;background:${C.brand};padding:11px 20px;font-size:14px;font-weight:600;color:${C.onbrand};text-decoration:none">${esc(L.button)}</a></p>` +
    p(esc(L.reply), `font-size:14px;color:${C.sub}`) +
    `</td></tr><tr><td style="border-top:1px solid ${C.line};padding:16px 28px 22px;font-size:12px;line-height:1.6;color:${C.sub}">${esc(footer)}</td></tr>` +
    `</table></td></tr></table></body></html>`;

  return { subject, text, html };
}

// ── PDF 로 만들 서류 HTML ─────────────────────────────────────────────────────────

/**
 * doc-excel.js 가 만든 서류 한 장(완성된 HTML)에서 종이 부분(<div class="page">…</div>)만 꺼낸다.
 * doc-excel 의 page() 모양에 기댄다 — 모양이 바뀌면 여기서 바로 던진다(조용히 빈 PDF 를 만들지 않게).
 * @param {string} html
 */
export function pageOf(html) {
  const s = String(html ?? '');
  const start = s.indexOf('<div class="page">');
  const end = s.lastIndexOf('</body>');
  if (start < 0 || end < start) throw new Error('doc_shape');
  return s.slice(start, end).trim();
}

/**
 * 서류 여러 장 → PDF 용 HTML 하나(장마다 새 쪽). 인쇄 버튼 줄은 넣지 않는다.
 * @param {string[]} htmls doc-excel 서류 HTML(같은 STYLE) @param {string} style doc-excel 의 STYLE
 * @param {{lang: 'ko'|'en', title: string}} o
 */
export function mergeDocPages(htmls, style, o) {
  const pages = htmls.map(pageOf);
  return `<!doctype html><html lang="${o.lang === 'en' ? 'en' : 'ko'}"><head><meta charset="utf-8"><title>${esc(o.title)}</title>` +
    `<style>${style}\n.page+.page{break-before:page}</style></head><body>\n${pages.join('\n')}\n</body></html>`;
}

/**
 * PDF 를 만드는 브라우저 안에서 칸 맞춤(doc-excel 의 fitCells)을 돌리는 스크립트.
 * 서류 HTML 에는 스크립트를 넣지 않는다(doc-excel 규칙) — PDF 만드는 쪽이 따로 넣는다.
 * __name 은 번들러가 함수 이름을 남길 때 쓰는 도우미라, 브라우저에 없으면 그대로 돌려주게 둔다.
 * @param {Function} fitCells
 */
export function fitScript(fitCells) {
  return `var __name=function(f){return f};(${fitCells.toString()})(document);`;
}

// ── 발송 기록(inquiries.ack_mail, JSON) ──────────────────────────────────────────

/** 기록 읽기 — 깨졌거나 없으면 null @param {unknown} raw */
export function parseAck(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && typeof o.status === 'string' ? o : null;
  } catch {
    return null;
  }
}

/**
 * 새 기록(JSON 문자열).
 *   n = 끝난 시도 횟수(다시 보내기 포함 · '보내는 중'은 세지 않음) · code = 실패한 HTTP 상태(있으면)
 *   sentAt·sentN = 마지막으로 보낸 시각·보낸 횟수 — 나중 시도가 실패해도 '이미 보냈다'는 사실을 잃지 않는다
 * @param {unknown} prevRaw 이전 기록
 * @param {{status:'sent'|'failed'|'skipped'|'pending', reason?:string|null, pdf?:string|null, code?:number|null, by:'auto'|'admin', at:string}} r
 */
export function ackRecord(prevRaw, r) {
  const prev = parseAck(prevRaw);
  const sent = r.status === 'sent';
  return JSON.stringify({
    status: r.status, reason: r.reason ?? null, pdf: r.pdf ?? null, code: Number.isInteger(r.code) ? r.code : null,
    by: r.by, at: r.at,
    n: (Number(prev?.n) || 0) + (r.status === 'pending' ? 0 : 1),
    sentAt: sent ? r.at : (typeof prev?.sentAt === 'string' ? prev.sentAt : null),
    sentN: (Number(prev?.sentN) || 0) + (sent ? 1 : 0),
  });
}

/** '보내는 중' 기록이 아직 살아 있는가 — 2분이 지나면 중단된 것으로 본다(워커 백그라운드 작업은 30초 안에 끝나야 한다) */
export const ACK_PENDING_MS = 2 * 60 * 1000;
/** @param {unknown} raw @param {number} [now] */
export function isFreshPending(raw, now = Date.now()) {
  const a = parseAck(raw);
  const t = Date.parse(String(a?.at ?? ''));
  return a?.status === 'pending' && Number.isFinite(t) && now - t < ACK_PENDING_MS;
}

/** 실패·건너뜀 사유 → 관리자·알림용 한글 */
export const ACK_REASON_KO = Object.freeze({
  blocked_build: '테스트 빌드라 회사 주소(@vanam.co.kr)로만 보냅니다',
  blocked_host: '운영 주소(vanam.co.kr)가 아닌 곳에서 실행된 운영 빌드라 보내지 않았습니다',
  bad_recipient: '받는 주소 모양이 이상해 보내지 않았습니다',
  no_credentials: '메일 설정(Gmail 비밀값)이 없습니다',
  unverified: '보안 확인(Turnstile)을 하지 못한 접수라 자동으로 보내지 않았습니다 — 필요하면 보내기를 누르세요',
  recipient_cap: '같은 주소로 하루 3통을 넘어 자동 발송을 멈췄습니다',
  daily_cap: '오늘 자동 발송 상한(50통)에 닿아 멈췄습니다',
  auth_failed: 'Gmail 권한 확인 필요 — hello@ 비밀번호를 바꿨다면 권한을 다시 승인하세요',
  http_error: 'Gmail 이 발송을 거절했습니다',
  fetch_error: 'Gmail 연결 오류',
  in_progress: '이미 보내는 중입니다',
  no_inquiry: '접수 건을 찾지 못했습니다',
  not_quote: '공정 견적 요청이 아닙니다',
  error: '처리 중 오류',
});

/** PDF 결과 → 관리자용 한글(보냄 줄 뒤에 붙는다) @param {unknown} pdf */
function pdfKo(pdf) {
  const p = str(pdf);
  if (p === 'quote') return '예상 견적서·요청서 PDF 첨부';
  if (p === 'request') return '요청서 PDF 첨부';
  if (p === 'none:no_credentials') return 'PDF 없음(설정 없음)';
  if (p.startsWith('none:')) return 'PDF 못 만듦 — 조회 링크만';
  return '';
}

/**
 * 관리자 견적 카드 한 줄. 기록이 없으면 null(이 기능 전에 접수된 건).
 * @param {unknown} raw inquiries.ack_mail @param {number} [now] '보내는 중'이 오래됐는지 볼 기준 시각
 * @returns {{tone: 'ok'|'bad'|'muted', text: string} | null}
 */
export function ackLabel(raw, now = Date.now()) {
  const a = parseAck(raw);
  if (!a) return null;
  const when = kstText(a.at);
  // 나중 시도가 실패·중단돼도 앞서 보낸 사실은 같이 적는다
  const before = a.status !== 'sent' && typeof a.sentAt === 'string' && kstText(a.sentAt) ? ` (앞서 ${kstText(a.sentAt)} 에 보냄)` : '';
  if (a.status === 'sent') {
    return { tone: 'ok', text: ['확인 메일: 보냄', when, pdfKo(a.pdf)].filter(Boolean).join(' · ') + (a.by === 'admin' ? ' · 다시 보냄' : '') };
  }
  if (a.status === 'pending') {
    return isFreshPending(raw, now)
      ? { tone: 'muted', text: '확인 메일: 보내는 중…' }
      : { tone: 'bad', text: `확인 메일: 중단됨 — 처리 시간 안에 끝나지 못했습니다. 다시 보내 주세요${before}` };
  }
  const why = (ACK_REASON_KO[a.reason] ?? (str(a.reason) || ACK_REASON_KO.error)) + (Number.isInteger(a.code) ? ` (HTTP ${a.code})` : '');
  if (a.status === 'failed') return { tone: 'bad', text: `확인 메일: 실패 — ${why}${when ? ` · ${when}` : ''}${before}` };
  return { tone: 'muted', text: `확인 메일: 안 보냄 — ${why}${before}` };
}

/**
 * 견적 요청서 데이터 인자(requestDocFrom 에 넘긴다) — 완료 화면과 같은 요청서(접수번호 있음 · 상태 글자 없음).
 * @param {any} q inquiries 행 @param {'ko'|'en'} lang @param {string} date 'YYYY-MM-DD'(한국 날짜)
 * @param {{sizeMap: Record<string,string>, deliveryMap: Record<string,string>}} maps 보는 언어의 코드값 라벨
 */
export function requestDocArgs(q, lang, date, maps) {
  let dj = null;
  try { dj = q?.details_json ? JSON.parse(String(q.details_json)) : null; } catch { dj = null; }
  return {
    lang, id: str(q?.id), draft: false, date,
    requester: { company: str(q?.company), name: str(q?.name), phone: str(q?.phone), email: str(q?.email) },
    product: str(q?.product_name) || str(q?.material),
    dj, detailsText: str(q?.details),
    sizeMap: maps.sizeMap, deliveryMap: maps.deliveryMap,
  };
}
