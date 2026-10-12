// 메일 원문(MIME) 조립 — 순수 모듈(.js). 워커(mail-send.ts)와 node 테스트가 같이 쓴다.
//
// Gmail API 의 업로드 방식(message/rfc822)으로 보내는 원문을 만든다. 외부 패키지 없이 필요한 만큼만:
//   - 본문: text/plain + text/html (multipart/alternative), 둘 다 UTF-8 · base64
//   - 첨부: application/pdf 등 (multipart/mixed), base64 · 76자 줄바꿈
//   - 머리(제목·보낸 사람 이름·첨부 파일 이름)의 한글: RFC 2047 encoded-word(=?UTF-8?B?…?=), 파일 이름은 RFC 2231 도 함께
//   - Auto-Submitted: auto-generated (RFC 3834) — 받는 쪽 부재중 자동응답이 hello@ 로 되돌아오지 않게
// 규칙:
//   - 받는 주소는 단순한 주소 모양만 받는다(isSafeAddress). 줄바꿈·꺾쇠·공백이 섞인 값은 머리에 넣지 않는다(머리 끼워넣기 방지).
//   - 고객이 쓴 글(이름 등)은 머리에 넣지 않는다 — 본문에서만(이스케이프는 본문 조립 쪽 몫).
//   - 워커 무료 플랜은 요청당 CPU 10ms 다 — 첨부 base64 는 표 조회로 바이트를 바로 채운다(문자열을 이어 붙이지 않는다).

const CRLF = '\r\n';

/** 문자열 → UTF-8 바이트 @param {string} s */
export const utf8 = (s) => new TextEncoder().encode(String(s ?? ''));

const B64 = Uint8Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', (c) => c.charCodeAt(0));
const ascii = (u8) => new TextDecoder().decode(u8);

/** base64 글자들을 ASCII 바이트로(표 조회) — 줄바꿈 없음 @param {Uint8Array} bytes */
function b64bytes(bytes) {
  const n = bytes.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let i = 0;
  let o = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64[v >> 18];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = B64[(v >> 6) & 63];
    out[o++] = B64[v & 63];
  }
  if (i < n) {
    const two = i + 1 < n;
    const v = (bytes[i] << 16) | ((two ? bytes[i + 1] : 0) << 8);
    out[o++] = B64[v >> 18];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = two ? B64[(v >> 6) & 63] : 61; // '='
    out[o++] = 61;
  }
  return out;
}

/** 런타임에 기본 base64(Uint8Array.prototype.toBase64)가 있으면 그것을 쓴다 */
const nativeB64 = (bytes) => (typeof (/** @type {any} */ (bytes)).toBase64 === 'function' ? /** @type {any} */ (bytes).toBase64() : null);

/**
 * 표준 base64(줄바꿈 없음) — 머리 글자·data: 주소용.
 * @param {Uint8Array | string} input 문자열이면 UTF-8 로 바꿔서
 */
export function b64(input) {
  const bytes = typeof input === 'string' ? utf8(input) : input;
  return nativeB64(bytes) ?? ascii(b64bytes(bytes));
}

/** base64 를 76자마다 줄바꿈(CRLF) — MIME 본문 규칙 @param {string} s */
export function wrap76(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join(CRLF);
}

/**
 * MIME 본문용 base64 — 76자마다 CRLF. 큰 첨부(수백 KB)도 바이트 배열을 한 번에 채워 글자로 바꾼다.
 * @param {Uint8Array | string} input
 */
export function b64lines(input) {
  const bytes = typeof input === 'string' ? utf8(input) : input;
  const native = nativeB64(bytes);
  if (native !== null) return wrap76(native);
  const raw = b64bytes(bytes);
  const lines = Math.ceil(raw.length / 76);
  if (lines <= 1) return ascii(raw);
  const out = new Uint8Array(raw.length + (lines - 1) * 2);
  let o = 0;
  for (let i = 0; i < raw.length; i += 76) {
    if (i) { out[o++] = 13; out[o++] = 10; }
    const part = raw.subarray(i, i + 76);
    out.set(part, o);
    o += part.length;
  }
  return ascii(out);
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/**
 * 머리 값의 한글 → RFC 2047 encoded-word. 한 낱말은 75자 이하(원문 45바이트까지)로 끊고,
 * 여러 낱말은 접어 쓴다(CRLF + 공백). 글자(코드 포인트) 중간에서 자르지 않는다. ASCII 만이면 그대로.
 * @param {string} s
 * @param {number} [firstMax] 첫 낱말의 원문 바이트 상한 — 머리 이름과 같은 줄에 올 때 그 줄이 76자를 넘지 않게
 */
export function encodeWords(s, firstMax = 45) {
  const text = String(s ?? '').replace(/[\r\n]+/g, ' ');
  if (ASCII_PRINTABLE.test(text)) return text;
  const words = [];
  let chunk = [];
  let size = 0;
  for (const ch of text) {
    const b = utf8(ch);
    const max = words.length ? 45 : firstMax;
    if (size + b.length > max && chunk.length) {
      words.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(b);
    size += b.length;
  }
  if (chunk.length) words.push(chunk);
  return words
    .map((parts) => {
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      return `=?UTF-8?B?${b64(all)}?=`;
    })
    .join(`${CRLF} `);
}

/** RFC 2231 파일 이름 값(filename*=…) — UTF-8 퍼센트 인코딩 @param {string} name */
export function rfc2231(name) {
  const pct = encodeURIComponent(String(name ?? '')).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `UTF-8''${pct}`;
}

/**
 * 머리에 넣어도 되는 단순한 주소인가 — 줄바꿈·공백·꺾쇠·따옴표가 없는 user@host.tld 모양만(앞부분 64자 이하).
 * (국제화 주소 등 드문 모양은 받지 않는다 — 그 고객에게는 확인 메일이 안 나갈 뿐 접수는 그대로다)
 * @param {unknown} addr
 */
export function isSafeAddress(addr) {
  const a = typeof addr === 'string' ? addr : '';
  return a.length > 0 && a.length <= 254 && a.indexOf('@') > 0 && a.indexOf('@') <= 64
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(a);
}

/** 보낸 사람 머리 값: 이름 <주소> (이름은 encoded-word 또는 따옴표) */
function mailbox(name, address) {
  const n = String(name ?? '').trim();
  if (!n) return `<${address}>`;
  // 'From: ' 6자 + 첫 낱말(원문 27바이트 → 48자) + ' <주소>' — 짧은 주소면 76자 줄 제한 안
  const shown = ASCII_PRINTABLE.test(n) ? `"${n.replace(/["\\]/g, '')}"` : encodeWords(n, 27);
  return `${shown} <${address}>`;
}

/** 본문 한 덩어리(text/plain · text/html) — 글 안의 줄바꿈도 CRLF 로 맞춘다(메일 글 규칙) */
function textPart(type, body) {
  return [
    `Content-Type: ${type}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(String(body ?? '').replace(/\r?\n/g, CRLF)),
  ].join(CRLF);
}

/** 첨부 한 덩어리(매개변수는 줄을 접어 쓴다) @param {{filename:string, contentType:string, bytes:Uint8Array}} a */
function attachmentPart(a) {
  const name = String(a.filename ?? 'attachment');
  const word = encodeWords(name).replace(/\r\n /g, ''); // 파일 이름 안에서는 접지 않는다(따옴표 안)
  return [
    `Content-Type: ${a.contentType};`,
    ` name="${word}"`,
    'Content-Disposition: attachment;',
    ` filename="${word}";`,
    ` filename*=${rfc2231(name)}`,
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(a.bytes),
  ].join(CRLF);
}

/**
 * 메일 원문(RFC 5322 · MIME). 줄 끝은 CRLF.
 * @param {{
 *   from: {name?: string, address: string}, to: string, subject: string,
 *   text: string, html: string,
 *   attachments?: {filename: string, contentType: string, bytes: Uint8Array}[],
 *   boundary?: string,
 * }} m  boundary 는 테스트용(기본은 매번 새로)
 * @returns {string}
 * @throws 받는/보내는 주소가 단순한 모양이 아닐 때(bad_recipient · bad_sender)
 */
export function buildMime(m) {
  if (!isSafeAddress(m.to)) throw new Error('bad_recipient');
  if (!isSafeAddress(m.from?.address)) throw new Error('bad_sender');
  const seed = m.boundary ?? (globalThis.crypto?.randomUUID?.() ?? String(Date.now())).replace(/-/g, '');
  const alt = `alt_${seed}`;
  const mix = `mix_${seed}`;
  const head = [
    `From: ${mailbox(m.from.name, m.from.address)}`,
    `To: <${m.to}>`,
    // 'Subject: ' 9자 + 첫 낱말(원문 39바이트 → 64자) = 73자 — 76자 줄 제한 안
    `Subject: ${encodeWords(m.subject, 39)}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];
  const altBody = [
    `--${alt}`, textPart('text/plain', m.text),
    `--${alt}`, textPart('text/html', m.html),
    `--${alt}--`,
  ].join(CRLF);
  const atts = (m.attachments ?? []).filter((a) => a && a.bytes && a.bytes.length);
  if (!atts.length) {
    return [...head, `Content-Type: multipart/alternative; boundary="${alt}"`, '', altBody, ''].join(CRLF);
  }
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${mix}"`,
    '',
    `--${mix}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    altBody,
    ...atts.flatMap((a) => [`--${mix}`, attachmentPart(a)]),
    `--${mix}--`,
    '',
  ].join(CRLF);
}
