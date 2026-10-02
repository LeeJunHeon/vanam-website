// scripts/test-quote-ack.mjs — 견적 요청 접수 확인 메일 테스트(순수 부분)
//
//   ① 메일 원문(mail-mime.js) — base64·76자 줄·한글 머리(encoded-word)·파일 이름(RFC 2231)·주소 검사·
//      본문 둘(text/html)·첨부 PDF 왕복·머리 끼워넣기 차단
//   ② 문구(quote-ack.js ackContent) — 한글/영문 · 예상 견적 있음/없음 · 첨부 종류 · 테스트 빌드 표시 · 이스케이프
//   ③ PDF 용 서류 HTML — 서류 여러 장을 한 HTML 로(쪽 나눔 · 인쇄 버튼 없음) · 칸 맞춤 스크립트
//   ④ 발송 기록(ack_mail JSON) · 관리자 한 줄 · 요청서 인자
// 네트워크·비밀값 없이 돈다. 회사 정보·고객 정보는 가짜.
import { readFileSync } from 'node:fs';
import {
  b64, b64lines, wrap76, encodeWords, rfc2231, isSafeAddress, buildMime, utf8,
} from '../src/lib/mail-mime.js';
import {
  ackContent, estimateOf, attachmentName, kstText, pageOf, mergeDocPages, fitScript,
  ackRecord, parseAck, ackLabel, requestDocArgs, ACK_REASON_KO, hostAllowed, safeShort, isFreshPending, ACK_PENDING_MS, lookupLink,
} from '../src/lib/quote-ack.js';
import { buildQuoteHtml, buildRequestHtml, requestDocFrom, fitCells, STYLE } from '../src/lib/doc-excel.js';
import { defang, safeShort as safeShortText } from '../src/lib/safe-text.js';

let total = 0, failed = 0;
let b64ms = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}
const has = (h, ...ws) => ws.every((w) => h.includes(w));
const fromB64 = (s) => new Uint8Array(Buffer.from(s.replace(/\r\n/g, ''), 'base64'));
const dec = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

// ── ① 메일 원문 ─────────────────────────────────────────────────────────────────
eq('b64: ASCII', b64('abc'), 'YWJj');
eq('b64: 한글은 UTF-8 로', b64('한'), Buffer.from('한', 'utf8').toString('base64'));
{
  const big = new Uint8Array(200_000).map((_, i) => (i * 7 + 13) % 256);
  eq('b64: 큰 바이트(200KB) 왕복', Buffer.from(fromB64(b64(big))).equals(Buffer.from(big)), true);
  const w = wrap76(b64(big));
  eq('wrap76: 모든 줄 ≤ 76자 · 이으면 원래대로', [w.split('\r\n').every((l) => l.length <= 76), w.replace(/\r\n/g, '') === b64(big)], [true, true]);
  // 표 조회 base64 — 크기마다 Node 의 base64 와 같고, 76자 줄
  const sizes = [0, 1, 2, 3, 4, 5, 56, 57, 58, 59, 228, 229, 1000, 200_000];
  eq('b64 · b64lines: 크기마다 표준 base64 와 같음', sizes.map((n) => {
    const u = big.subarray(0, n);
    const want = Buffer.from(u).toString('base64');
    const lines = b64lines(u);
    return b64(u) === want && lines.replace(/\r\n/g, '') === want && lines.split('\r\n').every((l) => l.length <= 76) && (n === 0 || !lines.endsWith('\r\n'));
  }).every(Boolean), true);
  // CPU 감(무료 플랜 요청당 10ms) — 200KB 첨부의 base64 + 줄바꿈. 빌드 서버 속도가 달라 판정하지 않고 숫자만 찍는다.
  const t0 = performance.now();
  for (let k = 0; k < 5; k++) b64lines(big);
  b64ms = (performance.now() - t0) / 5;
}
eq('encodeWords: ASCII 는 그대로', encodeWords('Hello [VanaM] (INQ-1)'), 'Hello [VanaM] (INQ-1)');
{
  const subj = '[반암] 견적 요청이 접수되었습니다 (INQ-20261001-AB2C) — 아주 긴 제목이라 여러 낱말로 나뉘어야 합니다 😀';
  const e = encodeWords(subj);
  const words = e.split('\r\n ');
  const back = words.map((w) => /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(w)?.[1]);
  eq('encodeWords: 여러 낱말 · 낱말마다 75자 이하', [words.length > 1, words.every((w) => w.length <= 75)], [true, true]);
  eq('encodeWords: 낱말마다 온전한 UTF-8(글자 중간에서 안 끊김) · 이으면 원래 제목', back.every(Boolean) && back.map((x) => dec(fromB64(x))).join(''), subj);
  eq('encodeWords: 줄바꿈은 공백으로(머리 끼워넣기 차단)', dec(fromB64(/\?B\?(.+)\?=/.exec(encodeWords('가\r\nBcc: x@evil.com'))[1])), '가 Bcc: x@evil.com');
}
eq('rfc2231: UTF-8 퍼센트 인코딩 · 되돌리면 원래 이름', (() => {
  const v = rfc2231("견적요청서_INQ-1 (1)'.pdf");
  return [v.startsWith("UTF-8''%EA%B2%AC"), /^[A-Za-z0-9%._~'-]+$/.test(v.slice(7)), decodeURIComponent(v.slice(7))];
})(), [true, true, "견적요청서_INQ-1 (1)'.pdf"]);
eq('isSafeAddress: 표', [
  'a@b.co', 'first.last+tag@sub.example.co.kr', 'hello@vanam.co.kr',
  '', 'a@b', 'a b@c.com', 'a@b.com\r\nBcc: x@y.com', '<a@b.com>', '"a"@b.com', 'a@-b.com', 'a@b..com', 'a@b.com.', `${'x'.repeat(250)}@b.com`, null,
].map(isSafeAddress), [true, true, true, false, false, false, false, false, false, false, false, false, false, false]);

/** 원문을 머리/본문으로 나누고, 경계로 덩어리를 자른다(테스트용 최소 해석) */
function parse(mime) {
  const [head, ...rest] = mime.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  const headers = Object.fromEntries(head.replace(/\r\n /g, ' ').split('\r\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
  return { headers, body };
}
function parts(body, boundary) {
  return body.split(`--${boundary}`).slice(1, -1).map((p) => {
    const i = p.indexOf('\r\n\r\n');
    const h = p.slice(0, i).trim();
    return { head: h, body: p.slice(i + 4).replace(/\r\n$/, '') };
  });
}
const html0 = '<p>안녕하세요 &amp; 반갑습니다</p>';
const text0 = '안녕하세요\n두 번째 줄';
{
  const m = buildMime({ from: { name: '반암 VanaM', address: 'hello@vanam.co.kr' }, to: 'customer@example.com',
    subject: '[반암] 견적 요청이 접수되었습니다 (INQ-20261001-AB2C)', text: text0, html: html0, boundary: 'T1' });
  const { headers, body } = parse(m);
  eq('원문: 줄 끝은 전부 CRLF(맨 LF 없음)', /(^|[^\r])\n/.test(m), false);
  eq('원문: 머리 — 보낸 사람(이름 encoded-word)·받는 사람 하나·MIME', [
    /^=\?UTF-8\?B\?[^?]+\?= <hello@vanam\.co\.kr>$/.test(headers.From), headers.To, headers['MIME-Version'], headers['Content-Type'],
  ], [true, '<customer@example.com>', '1.0', 'multipart/alternative; boundary="alt_T1"']);
  eq('원문: Cc·Bcc 머리 없음', [/^Cc:/m.test(m), /^Bcc:/m.test(m)], [false, false]);
  const ps = parts(body, 'alt_T1');
  eq('원문: 본문 두 덩어리(text → html 순서)', ps.map((p) => p.head.split('\r\n')[0]), ['Content-Type: text/plain; charset=UTF-8', 'Content-Type: text/html; charset=UTF-8']);
  eq('원문: 본문 base64 왕복(글 안 줄바꿈은 CRLF)', [dec(fromB64(ps[0].body)), dec(fromB64(ps[1].body))], [text0.replace(/\n/g, '\r\n'), html0]);
}
{
  const pdf = utf8('%PDF-1.4\n가짜 PDF\n%%EOF');
  const m = buildMime({ from: { name: 'VanaM Inc.', address: 'hello@vanam.co.kr' }, to: 'hello@vanam.co.kr',
    subject: 'Hi', text: 'a', html: '<b>a</b>', boundary: 'T2',
    attachments: [{ filename: '견적요청서_INQ-20261001-AB2C.pdf', contentType: 'application/pdf', bytes: pdf }] });
  const { headers, body } = parse(m);
  eq('첨부: 겉은 multipart/mixed · 보낸 사람 ASCII 이름은 따옴표', [headers['Content-Type'], headers.From],
    ['multipart/mixed; boundary="mix_T2"', '"VanaM Inc." <hello@vanam.co.kr>']);
  const ps = parts(body, 'mix_T2');
  const h1 = ps[1].head.replace(/\r\n /g, ' ');
  eq('첨부: 덩어리 둘(본문 묶음 · PDF) · 매개변수는 접어 씀', [ps.length, ps[0].head, h1.startsWith('Content-Type: application/pdf; name="=?UTF-8?B?'), ps[1].head.split('\r\n').length > 3],
    [2, 'Content-Type: multipart/alternative; boundary="alt_T2"', true, true]);
  eq('첨부: 파일 이름 RFC 2231 도 함께', h1.includes("filename*=UTF-8''%EA%B2%AC"), true);
  eq('첨부: PDF 바이트 왕복', Buffer.from(fromB64(ps[1].body)).equals(Buffer.from(pdf)), true);
  eq('첨부: 빈 바이트 첨부는 건너뜀 → alternative 만', parse(buildMime({ from: { address: 'hello@vanam.co.kr' }, to: 'a@b.co', subject: 's', text: 't', html: 'h', boundary: 'T3',
    attachments: [{ filename: 'x.pdf', contentType: 'application/pdf', bytes: new Uint8Array(0) }] })).headers['Content-Type'], 'multipart/alternative; boundary="alt_T3"');
}
const throwsMsg = (f) => { try { f(); return '예외 없음'; } catch (e) { return e.message; } };
eq('원문: 받는 주소가 이상하면 만들지 않음', throwsMsg(() => buildMime({ from: { address: 'hello@vanam.co.kr' }, to: 'a@b.com\r\nBcc: x@y.com', subject: 's', text: 't', html: 'h' })), 'bad_recipient');
eq('원문: 보내는 주소가 이상하면 만들지 않음', throwsMsg(() => buildMime({ from: { address: 'nope' }, to: 'a@b.co', subject: 's', text: 't', html: 'h' })), 'bad_sender');
eq('원문: 머리 줄은 76자 이하(제목·보낸 사람 — 한글 긴 제목도) · Auto-Submitted', (() => {
  const m = buildMime({ from: { name: '반암 VanaM', address: 'hello@vanam.co.kr' }, to: 'customer@example.com',
    subject: '[테스트] [반암] 견적 요청이 접수되었습니다 (INQ-20261001-AB2C)', text: 't', html: 'h', boundary: 'T5' });
  const head = m.split('\r\n\r\n')[0].split('\r\n');
  return [head.filter((l) => /^(Subject|From):|^ =\?/.test(l)).every((l) => l.length <= 76), head.includes('Auto-Submitted: auto-generated')];
})(), [true, true]);
eq('isSafeAddress: @ 앞이 64자 넘으면 받지 않음', [isSafeAddress(`${'a'.repeat(64)}@b.co`), isSafeAddress(`${'a'.repeat(65)}@b.co`)], [true, false]);
eq('원문: 제목에 줄바꿈 + Bcc 를 넣어도 머리가 하나 더 생기지 않음', (() => {
  const m = buildMime({ from: { address: 'hello@vanam.co.kr' }, to: 'a@b.co', subject: 'x\r\nBcc: evil@y.com', text: 't', html: 'h', boundary: 'T4' });
  return [/^Bcc:/m.test(m), parse(m).headers.Subject];
})(), [false, 'x Bcc: evil@y.com']);

// ── ② 문구 ──────────────────────────────────────────────────────────────────────
const site = JSON.parse(readFileSync('src/data/site.json', 'utf8'));
const T = { ko: site.ko.quote.view, en: site.en.quote.view };
eq('site.json 견적 상자 문구에 메일이 쓰는 키가 다 있음', ['ko', 'en'].map((l) => ['estimate', 'totalMain', 'totalMeta', 'valid', 'notice'].every((k) => typeof T[l][k] === 'string' && T[l][k])), [true, true]);
eq('kstText', [kstText('2026-10-01T07:50:12.000Z'), kstText('2026-09-30T15:30:00Z'), kstText('nope'), kstText(null)], ['2026-10-01 16:50', '2026-10-01 00:30', '', '']);
eq('attachmentName', [attachmentName('ko', 'INQ-20261001-AB2C', false), attachmentName('ko', 'INQ-20261001-AB2C', true),
  attachmentName('en', 'INQ-20261001-AB2C', false), attachmentName('en', 'INQ-20261001-AB2C', true), attachmentName('ko', 'INQ/../x', false)],
['견적요청서_INQ-20261001-AB2C.pdf', '예상견적서_견적요청서_INQ-20261001-AB2C.pdf', 'VanaM_Quote_Request_INQ-20261001-AB2C.pdf',
  'VanaM_Estimate_and_Request_INQ-20261001-AB2C.pdf', '견적요청서_INQx.pdf']);
const VIEW_EST = { state: 'estimate', totalKrwText: '₩239,800', totalUsdText: '$173.14', validDays: 14, validUntil: '2026-10-15', doc: {} };
eq('estimateOf: 예상 견적만', [estimateOf(VIEW_EST), estimateOf({ ...VIEW_EST, state: 'reviewing' }), estimateOf({ ...VIEW_EST, state: 'confirmed' }),
  estimateOf(null), estimateOf({ ...VIEW_EST, totalUsdText: null })],
[{ krw: '₩239,800', usd: '$173.14', validDays: 14, validUntil: '2026-10-15' }, null, null, null, null]);

const BASE = {
  id: 'INQ-20261001-AB2C', name: '홍길동<b>', company: '가짜대학교', product: '다층 박막', receivedAt: '2026-10-01T07:50:12.000Z',
  lookupUrl: 'https://vanam.co.kr/ko/order/lookup?id=INQ-20261001-AB2C', tel: '02-0000-0000', email: 'hello@vanam.co.kr', site: 'https://vanam.co.kr',
};
{
  const c = ackContent({ ...BASE, lang: 'ko', live: true, estimate: estimateOf(VIEW_EST), T: T.ko, attachment: 'quote' });
  eq('한글·운영: 제목(테스트 표시 없음)', c.subject, '[반암] 견적 요청이 접수되었습니다 (INQ-20261001-AB2C)');
  eq('한글·운영: 본문 — 인사·접수·2일 이내 회신·접수 내용', has(c.text, '가짜대학교 홍길동<b> 님, 안녕하세요. 반암(VanaM)입니다.',
    '견적 요청이 정상적으로 접수되었습니다. 담당자가 요청 내용을 확인한 뒤 영업일 기준 2일 이내에 회신드리겠습니다.',
    '접수번호: INQ-20261001-AB2C', '요청 상품: 다층 박막', '접수 일시: 2026-10-01 16:50 (한국 시간)'), true);
  eq('한글·운영: 예상 견적 — 금액·환산·유효기간·확정 아님 안내(고객 화면 문구 그대로)', has(c.text, '예상 견적', '₩239,800 (부가세 포함 · 약 $173.14)',
    '유효기간: 견적일로부터 14일 (2026-10-15까지)', T.ko.notice), true);
  eq('한글·운영: 첨부 줄 · 조회 링크 · 답장 안내 · 회사 줄', has(c.text, '첨부: 예상 견적서와 견적 요청서(PDF 1개)', BASE.lookupUrl,
    '이 메일에 바로 답장하셔도 담당자에게 전달됩니다.', '반암주식회사 · hello@vanam.co.kr · 02-0000-0000 · vanam.co.kr'), true);
  eq('한글·운영: 테스트 표시 없음', [c.text.includes('테스트'), c.html.includes('테스트')], [false, false]);
  eq('HTML: 고객 글자는 이스케이프 · 스크립트 없음 · 링크는 조회 주소 하나', [c.html.includes('홍길동&lt;b&gt;'), c.html.includes('홍길동<b>'),
    /<script/i.test(c.html), [...c.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])], [true, false, false, [BASE.lookupUrl]]);
  eq('HTML: 예상 견적 상자(금액·날짜는 한 덩어리) · 버튼 문구', has(c.html, '>₩239,800<', '부가세 포함 · 약 <span style="white-space:nowrap">$173.14</span>',
    '(<span style="white-space:nowrap">2026-10-15</span>까지)', '>진행 상태 조회<'), true);
  eq('한글: 조회 안내 — HTML 은 버튼 안내 · 글 본문은 "버튼 이름: 주소" 한 줄(사이트와 같은 "진행 상태")', [
    c.html.includes('아래 버튼을 누르면 진행 상태를 바로 확인하실 수 있습니다.'), c.text.includes(`\n진행 상태 조회: ${BASE.lookupUrl}\n`),
    c.text.includes('아래 버튼'), c.text.includes('진행 상황')], [true, true, false, false]);
}
{
  const c = ackContent({ ...BASE, lang: 'ko', live: false, estimate: null, T: T.ko, attachment: 'request' });
  eq('한글·테스트: 제목 앞 [테스트]', c.subject, '[테스트] [반암] 견적 요청이 접수되었습니다 (INQ-20261001-AB2C)');
  eq('한글·테스트: 본문 맨 위·HTML 에 테스트 빌드 안내', [c.text.startsWith('※ 테스트 빌드에서 보낸 메일입니다.'), c.html.includes('테스트 빌드에서 보낸 메일입니다.')], [true, true]);
  eq('한글: 예상 견적 없으면 금액 줄 없음 · 요청서 첨부 줄(견적서 양식이지만 금액 없음을 밝힘)', [c.text.includes('₩'),
    c.text.includes('첨부: 견적 요청서(PDF) — 접수하신 내용을 반암 견적서 양식에 금액 없이 정리했습니다.')], [false, true]);
  const none = ackContent({ ...BASE, lang: 'ko', live: true, estimate: null, T: T.ko, attachment: null });
  eq('한글: PDF 를 못 붙였으면 조회 화면에서 인쇄 안내', none.text.includes('견적 요청서는 아래 조회 화면에서 인쇄하거나 PDF로 저장하실 수 있습니다.'), true);
  const noCo = ackContent({ ...BASE, company: '', lang: 'ko', live: true, estimate: null, T: T.ko, attachment: null });
  eq('한글: 소속 없으면 이름만', noCo.text.startsWith('홍길동<b> 님, 안녕하세요.'), true);
}
{
  const c = ackContent({ ...BASE, lang: 'en', live: true, estimate: estimateOf(VIEW_EST), T: T.en, attachment: 'quote', tel: '+82-2-0000-0000',
    lookupUrl: 'https://vanam.co.kr/order/lookup?id=INQ-20261001-AB2C' });
  eq('영문: 제목·인사·2 business days', [c.subject, has(c.text, 'Dear 홍길동<b>,', 'reply within 2 business days', 'Received: 2026-10-01 16:50 KST')],
    ['[VanaM] We received your quote request (INQ-20261001-AB2C)', true]);
  eq('영문: 예상 견적은 달러 먼저(고객 화면과 같음)', has(c.text, 'Approx. $173.14 (₩239,800 incl. VAT)', T.en.notice), true);
  eq('영문: 첨부 줄 · 회사 줄', has(c.text, 'Attached: the estimated quotation and your request sheet (one PDF).', 'VanaM Inc. · hello@vanam.co.kr · +82-2-0000-0000 · vanam.co.kr'), true);
  const t = ackContent({ ...BASE, lang: 'en', live: false, estimate: null, T: T.en, attachment: null });
  eq('영문·테스트: 제목 앞 [TEST]', t.subject.startsWith('[TEST] [VanaM]'), true);
  const r = ackContent({ ...BASE, lang: 'en', live: true, estimate: null, T: T.en, attachment: 'request' });
  eq('영문: 요청서 첨부 줄(금액 없음) · 버튼 안내 · 글 본문 "Check status: 주소"', [
    r.text.includes('Attached: your request sheet (PDF), laid out in our quotation format without prices.'),
    r.html.includes('Use the button below to check the status of your request at any time.'), r.text.includes(`\nCheck status: ${BASE.lookupUrl}\n`)], [true, true, true]);
}
{
  // 조회 링크 — 이메일은 # 뒤(서버로 안 감) · 조회 화면이 쓰는 방식(URLSearchParams)으로 읽으면 원래 주소 그대로
  const S = 'https://vanam.co.kr';
  const links = [
    lookupLink({ live: true, site: S, origin: 'http://127.0.0.1:8787', lang: 'ko', id: 'INQ-20261001-AB2C', email: ' first.last+tag@example.co.kr ' }),
    lookupLink({ live: false, site: S, origin: 'http://localhost:8787', lang: 'en', id: 'INQ-20261001-AB2C', email: 'hello@vanam.co.kr' }),
    lookupLink({ live: false, site: S, origin: 'javascript:alert(1)//x', lang: 'ko', id: 'INQ-1', email: '' }),
    lookupLink({ live: false, site: S, origin: undefined, lang: 'ko', id: 'INQ 1&x', email: null }),
  ];
  eq('조회 링크: 운영은 고정 주소 · 테스트 빌드는 접속 주소(모양이 이상하면 고정 주소) · 영문은 /ko 없음 · 이메일 없으면 # 없음', links, [
    'https://vanam.co.kr/ko/order/lookup?id=INQ-20261001-AB2C#e=first.last%2Btag%40example.co.kr',
    'http://localhost:8787/order/lookup?id=INQ-20261001-AB2C#e=hello%40vanam.co.kr',
    'https://vanam.co.kr/ko/order/lookup?id=INQ-1',
    'https://vanam.co.kr/ko/order/lookup?id=INQ%201%26x',
  ]);
  const u = new URL(links[0]);
  eq('조회 링크 왕복: ?id= 는 접수번호 · # 뒤 e 는 받는 주소(+ 도 그대로) · 서버로 가는 부분(경로+검색)에 주소 없음', [
    u.searchParams.get('id'), new URLSearchParams(u.hash.slice(1)).get('e'), (u.pathname + u.search).includes('example')],
  ['INQ-20261001-AB2C', 'first.last+tag@example.co.kr', false]);
}

// ── ③ PDF 용 서류 HTML ───────────────────────────────────────────────────────────
const FAKE = { bizNo: '000-00-00000', nameEn: 'Fake Co.', ceoEn: 'Gil-dong Hong', addressEn: '1 Somewhere, Seoul', tel: '+82-2-0000-0000', email: 'fake@example.com' };
const LOGO = 'data:image/png;base64,AAAA';
const ROW = {
  id: 'INQ-20261001-AB2C', type: 'quote', name: '홍길동', email: 'demo@example.com', phone: '+82-10-0000-0000', company: '가짜대학교',
  product_name: '다층 박막', material: 'Ti', details: '[공정 순서]\n1. Sputter · Ti · 10 nm',
  details_json: JSON.stringify({ seq: [{ process: 'Sputter', material: 'Ti', value: '10', unit: 'nm', etc: '' }, { process: 'Sputter', material: 'Pt', value: '50', unit: 'nm', etc: '' }],
    measures: [], delivery: 'direct', substrateType: 'Silicon', substrateSize: '4inch', substrateGrade: 'Prime', sampleCount: '5', preFilm: false, notes: '데모', completionDate: '' }),
  locale: 'ko', created_at: '2026-10-01T07:50:12.000Z',
};
const MAPS = { sizeMap: { '4inch': '4 inch' }, deliveryMap: { direct: '직접 전달' } };
{
  const args = requestDocArgs(ROW, 'ko', '2026-10-01', MAPS);
  eq('요청서 인자: 접수번호·접수 후·요청자·상품·구조화 사본', [args.id, args.draft, args.requester, args.product, Array.isArray(args.dj?.seq), args.sizeMap === MAPS.sizeMap],
    ['INQ-20261001-AB2C', false, { company: '가짜대학교', name: '홍길동', phone: '+82-10-0000-0000', email: 'demo@example.com' }, '다층 박막', true, true]);
  eq('요청서 인자: 구조화 사본이 깨졌으면 문장으로 · 상품명 없으면 소재', (() => {
    const a = requestDocArgs({ ...ROW, details_json: '{깨짐', product_name: null }, 'en', '2026-10-01', MAPS);
    return [a.dj, a.detailsText, a.product, a.lang];
  })(), [null, ROW.details, 'Ti', 'en']);
  const req = buildRequestHtml({ ...requestDocFrom(args), logoUrl: LOGO });
  const quote = buildQuoteHtml({ info: { customer: '가짜대학교 홍길동', ref: '', title: '다층 박막', date: '2026-10-01', quoteNo: ROW.id, manager: '', contact: '02-0000-0000', delivery: '계약 후 협의', validDays: '14', payment: '' },
    items: [{ name: 'Sputter Ti/Pt', spec: 'Ti 10 nm\nPt 50 nm', qty: 1, unit: '회', unitPrice: 218000, supply: 218000, vat: 21800 }],
    supply: 218000, vat: 21800, total: 239800, totalKorean: '이십삼만구천팔백', logoUrl: LOGO, stamp: T.ko.docStamp, note: T.ko.docNoteEstimate }, FAKE);
  const p = pageOf(req);
  eq('pageOf: 종이 부분만(인쇄 버튼 줄 없음)', [p.startsWith('<div class="page">'), p.includes('vn-doc-print'), p.includes('<style>'), p.includes('견적 요청서')], [true, false, false, true]);
  eq('pageOf: 모양이 다르면 던짐(빈 PDF 방지)', throwsMsg(() => pageOf('<html><body>x</body></html>')), 'doc_shape');
  const m = mergeDocPages([quote, req], STYLE, { lang: 'ko', title: '견적 요청서 <INQ>' });
  eq('합친 HTML: 종이 2장 · 스타일 하나 · 쪽 나눔 · 버튼 없음 · 제목 이스케이프', [(m.match(/<div class="page">/g) ?? []).length, (m.match(/<style>/g) ?? []).length,
    m.includes('.page+.page{break-before:page}'), m.includes('vn-doc-print'), m.includes('<title>견적 요청서 &lt;INQ&gt;</title>')], [2, 1, true, false, true]);
  eq('합친 HTML: 견적서가 앞(예상 견적 표시) · 요청서가 뒤', [m.indexOf(T.ko.docStamp) > 0, m.indexOf(T.ko.docStamp) < m.indexOf('반암주식회사 귀중')], [true, true]);
  eq('합친 HTML: 서류 스크립트 없음', /<script/i.test(m), false);
}
{
  const s = fitScript(fitCells);
  eq('칸 맞춤 스크립트: 도우미 + fitCells 본문 + document 로 실행', [s.startsWith('var __name=function(f){return f};('), s.includes('querySelectorAll'), s.endsWith(')(document);')], [true, true, true]);
  // 가짜 DOM 에서 실제로 돌려본다: 넘치는 .fit 칸 글자를 줄인다
  const el = { classList: { contains: (c) => c === 'fitw' ? false : true }, scrollWidth: 120, clientWidth: 100, style: {} };
  Object.defineProperty(el, 'scrollWidth', { get() { return parseFloat(el.style.fontSize || '10') * 12; } });
  const doc = { defaultView: { getComputedStyle: () => ({ fontSize: '10px' }) }, querySelectorAll: () => [el] };
  new Function('document', s)(doc);
  eq('칸 맞춤 스크립트: 넘치는 칸 글자를 줄인다', parseFloat(el.style.fontSize) < 10, true);
}

// ── 운영 주소 · 고객 글 다듬기 ─────────────────────────────────────────────────────
eq('hostAllowed: 운영 빌드는 vanam.co.kr(·www) https 만 · 테스트 빌드는 아무 주소', [
  hostAllowed(true, 'https://vanam.co.kr'), hostAllowed(true, 'https://www.vanam.co.kr'), hostAllowed(true, 'http://127.0.0.1:8787'),
  hostAllowed(true, 'http://vanam.co.kr'), hostAllowed(true, 'https://vanam.co.kr.evil.com'), hostAllowed(true, undefined), hostAllowed(false, 'http://127.0.0.1:8787'),
], [true, true, false, false, false, false, true]);
eq('safeShort: 주소 모양은 링크가 안 되게 · 길면 자름 · 보통 이름은 그대로', [
  safeShort('http://evil.example/login', 60), safeShort('www.evil.com 홍길동', 60), safeShort('evil.com', 60), safeShort('가짜대학교 홍길동', 60),
  safeShort('Samsung Electronics Co., Ltd.', 60), safeShort('가'.repeat(50), 10), safeShort('  여러   칸\n줄  ', 60),
], ['http[:]//evil[.]example/login', 'www[.]evil[.]com 홍길동', 'evil[.]com', '가짜대학교 홍길동', 'Samsung Electronics Co., Ltd.', `${'가'.repeat(9)}…`, '여러 칸 줄']);
eq('defang(조회 화면 요청 내용): 줄바꿈·길이는 그대로 · 주소 모양만 · 약어·소수는 그대로 · 메일과 조회 화면이 같은 safeShort', [
  defang('1. Sputter | Ti | 10nm\n참고: https://evil.example/pay www.evil.com\nCo., Ltd. e.g. 1.5 nm'), defang(null), safeShort === safeShortText,
], ['1. Sputter | Ti | 10nm\n참고: https[:]//evil[.]example/pay www[.]evil[.]com\nCo., Ltd. e.g. 1.5 nm', '', true]);
{
  const c = ackContent({ ...BASE, name: 'https://phish.example/x', company: 'www.evil.com', product: 'p'.repeat(200),
    lang: 'ko', live: true, estimate: null, T: T.ko, attachment: null });
  eq('메일 본문: 고객 글의 주소는 링크가 안 됨(텍스트·HTML) · 상품은 80자로', [c.text.includes('https://phish'), c.html.includes('phish.example'), c.text.includes('https[:]//phish[.]example/x'),
    c.text.includes(`요청 상품: ${'p'.repeat(79)}…`)], [false, false, true, true]);
}

// ── ④ 발송 기록 · 관리자 한 줄 ───────────────────────────────────────────────────
{
  const a1 = ackRecord(null, { status: 'sent', reason: null, pdf: 'quote', by: 'auto', at: '2026-10-01T07:50:20.000Z' });
  const a2 = ackRecord(a1, { status: 'failed', reason: 'http_error', pdf: 'request', code: 403, by: 'admin', at: '2026-10-01T08:00:00.000Z' });
  eq('기록: 첫 번째', JSON.parse(a1), { status: 'sent', reason: null, pdf: 'quote', code: null, by: 'auto', at: '2026-10-01T07:50:20.000Z', n: 1,
    sentAt: '2026-10-01T07:50:20.000Z', sentN: 1 });
  eq('기록: 나중 시도가 실패해도 보낸 시각·횟수는 남음', [JSON.parse(a2).sentAt, JSON.parse(a2).sentN, JSON.parse(a2).status], ['2026-10-01T07:50:20.000Z', 1, 'failed']);
  const p1 = ackRecord(a1, { status: 'pending', by: 'admin', at: '2026-10-01T08:00:00.000Z' });
  eq('기록: 보내는 중은 횟수에 안 셈', [JSON.parse(p1).n, JSON.parse(p1).status, JSON.parse(p1).sentAt], [1, 'pending', '2026-10-01T07:50:20.000Z']);
  const T0 = Date.parse('2026-10-01T08:00:00.000Z');
  eq('보내는 중: 2분 안이면 살아 있음 · 지나면 중단', [isFreshPending(p1, T0 + 1000), isFreshPending(p1, T0 + ACK_PENDING_MS + 1), isFreshPending(a1, T0)], [true, false, false]);
  eq('관리자 줄: 보내는 중 / 중단됨(앞서 보낸 시각 함께)', [ackLabel(p1, T0 + 1000), ackLabel(p1, T0 + ACK_PENDING_MS + 1)],
    [{ tone: 'muted', text: '확인 메일: 보내는 중…' }, { tone: 'bad', text: '확인 메일: 중단됨 — 처리 시간 안에 끝나지 못했습니다. 다시 보내 주세요 (앞서 2026-10-01 16:50 에 보냄)' }]);
  eq('기록: 다시 보내면 횟수 +1 · 상태 코드', [JSON.parse(a2).n, JSON.parse(a2).code], [2, 403]);
  eq('기록 읽기: 깨진 값은 null', [parseAck('{깨짐'), parseAck(''), parseAck(null), parseAck('{"x":1}'), parseAck(a1)?.status], [null, null, null, null, 'sent']);
  eq('관리자 줄: 보냄(예상 견적서·요청서)', ackLabel(a1), { tone: 'ok', text: '확인 메일: 보냄 · 2026-10-01 16:50 · 예상 견적서·요청서 PDF 첨부' });
  eq('관리자 줄: 다시 보냄 표시', ackLabel(ackRecord(a1, { status: 'sent', pdf: 'request', by: 'admin', at: '2026-10-01T08:10:00.000Z' })),
    { tone: 'ok', text: '확인 메일: 보냄 · 2026-10-01 17:10 · 요청서 PDF 첨부 · 다시 보냄' });
  eq('관리자 줄: 실패(상태 코드) · 앞서 보낸 사실', ackLabel(a2), { tone: 'bad', text: '확인 메일: 실패 — Gmail 이 발송을 거절했습니다 (HTTP 403) · 2026-10-01 17:00 (앞서 2026-10-01 16:50 에 보냄)' });
  eq('관리자 줄: 권한 실패 안내', ackLabel(ackRecord(null, { status: 'failed', reason: 'auth_failed', by: 'auto', at: '2026-10-01T07:50:20.000Z' })).text,
    '확인 메일: 실패 — Gmail 권한 확인 필요 — hello@ 비밀번호를 바꿨다면 권한을 다시 승인하세요 · 2026-10-01 16:50');
  eq('관리자 줄: 안 보냄(테스트 빌드)', ackLabel(ackRecord(null, { status: 'skipped', reason: 'blocked_build', by: 'auto', at: '2026-10-01T07:50:20.000Z' })),
    { tone: 'muted', text: '확인 메일: 안 보냄 — 테스트 빌드라 회사 주소(@vanam.co.kr)로만 보냅니다' });
  eq('관리자 줄: PDF 없이 보냄', ackLabel(ackRecord(null, { status: 'sent', pdf: 'none:rate_limited', by: 'auto', at: '2026-10-01T07:50:20.000Z' })).text,
    '확인 메일: 보냄 · 2026-10-01 16:50 · PDF 못 만듦 — 조회 링크만');
  eq('관리자 줄: 기록 없음(이 기능 전 접수) → null', ackLabel(null), null);
  eq('사유 한글: 발송 통로의 모든 사유 + 실행부 사유', ['blocked_build', 'blocked_host', 'bad_recipient', 'no_credentials', 'unverified', 'recipient_cap', 'daily_cap',
    'auth_failed', 'http_error', 'fetch_error', 'in_progress', 'no_inquiry', 'not_quote', 'error']
    .every((k) => typeof ACK_REASON_KO[k] === 'string' && ACK_REASON_KO[k]), true);
}

if (failed) {
  console.error(`\n접수 확인 메일 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 접수 확인 메일(quote-ack·mail-mime) — ${total}건 통과 · 원문 왕복 · 한글/영문 · 예상 견적 · 테스트 빌드 표시 · 첨부 200KB base64 ${b64ms.toFixed(1)}ms`);
