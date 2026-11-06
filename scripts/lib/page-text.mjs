// 페이지 본문 지문(해시) — 사이트맵 lastmod 의 "본문이 실제로 바뀌었는가" 판정에 쓰는 유일한 모듈.
//   scripts/sitemap-lastmod.mjs (apply·stamp) 와 scripts/check-sitemap-lastmod.mjs (게이트) 가 이 파일만 쓴다.
//
// 지문 = SHA-256( 정규화( <main> 의 화면 글자 ) )
//   - 대상: 그 HTML 의 <main> … </main> 안쪽 텍스트. header·nav·footer·배너·팝업·SNS 버튼은 <main> 밖이라 자동으로 빠진다.
//   - 항상 제외: script · style · noscript · template (ld+json 은 script 라 여기에 포함)
//   - 설정으로 제외: scripts/sitemap-lastmod.config.json 의 exclude (CSS 선택자 목록)
//   - 설정으로 치환: textFromAttr — 그 요소의 글자 대신 속성값을 쓴다
//       (예: 달러 환산 표시 <span data-krw="150000">$108.70</span> → "150000". 원화 가격은 내용, 환율 환산은 내용 아님)
//   - 정규화: NFKC → 공백 접기 → 앞뒤 공백 제거
// 태그 하나는 공백 하나로 친다. 속성(alt·href·class 등)은 글자가 아니므로 지문에 들어가지 않는다.
//
// 선택자는 "한 요소에 대한 조건"만 지원한다: tag, .class, #id, [attr], [attr="값"] 과 그 조합(span.cart-count 등).
// 자손 결합자(공백, >)는 지원하지 않는다 — 걸린 요소의 하위 전체가 함께 제외된다.
import crypto from 'node:crypto';
import fs from 'node:fs';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ALWAYS_SKIP = new Set(['script', 'style', 'noscript', 'template']);

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', times: '×', ndash: '–', mdash: '—',
  hellip: '…', sup2: '²', sup3: '³', micro: 'µ', deg: '°', plusmn: '±', copy: '©', reg: '®', trade: '™',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', rarr: '→', larr: '←', bull: '•',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', minus: '−', Omega: 'Ω', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'ω', Delta: 'Δ', shy: '­', zwj: '‍', zwnj: '‌',
};
export const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENT[e] ?? ENT[e.toLowerCase()] ?? m;
  });

export const normalizeText = (s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

// ── 선택자 ──
export function compileSelector(sel) {
  const src = sel.trim();
  const re = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+|\[[\w:-]+(?:=(?:"[^"]*"|'[^']*'|[^\]\s]+))?\])*)$/;
  const m = re.exec(src);
  if (!m || !src) throw new Error(`page-text: 지원하지 않는 선택자 "${sel}" (tag, .class, #id, [attr], [attr="값"] 조합만 가능)`);
  const tag = m[1] && m[1] !== '*' ? m[1].toLowerCase() : null;
  const conds = [];
  for (const p of m[2].matchAll(/\.([\w-]+)|#([\w-]+)|\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\]/g)) {
    if (p[1]) conds.push((a) => (a.class ?? '').split(/\s+/).includes(p[1]));
    else if (p[2]) conds.push((a) => a.id === p[2]);
    else {
      const name = p[3].toLowerCase(); const val = p[4] ?? p[5] ?? p[6];
      conds.push(val === undefined ? (a) => name in a : (a) => a[name] === val);
    }
  }
  return (t, attrs) => (!tag || tag === t) && conds.every((c) => c(attrs));
}

// ── 태그 스캔(따옴표 안의 '>' 를 건너뛴다) ──
function readTag(html, i) {
  // html[i] === '<' 이고 뒤가 이름 또는 '/이름' 일 때만 호출
  let j = i + 1; const closing = html[j] === '/'; if (closing) j++;
  const s = j; while (j < html.length && /[^\s/>]/.test(html[j])) j++;
  const name = html.slice(s, j).toLowerCase();
  const attrs = {}; let selfClose = false;
  while (j < html.length) {
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] === '>') { j++; break; }
    if (html[j] === '/') { selfClose = html[j + 1] === '>'; j++; continue; }
    const as = j; while (j < html.length && /[^\s=>/]/.test(html[j])) j++;
    if (j === as) { j++; continue; }
    const an = html.slice(as, j).toLowerCase();
    while (j < html.length && /\s/.test(html[j])) j++;
    let av = '';
    if (html[j] === '=') {
      j++; while (j < html.length && /\s/.test(html[j])) j++;
      const q = html[j];
      if (q === '"' || q === "'") { const e = html.indexOf(q, j + 1); av = html.slice(j + 1, e < 0 ? html.length : e); j = e < 0 ? html.length : e + 1; }
      else { const vs = j; while (j < html.length && /[^\s>]/.test(html[j])) j++; av = html.slice(vs, j); }
    }
    if (!(an in attrs)) attrs[an] = decodeEntities(av);
  }
  return { name, closing, attrs, selfClose, end: j };
}

/** <main> 안쪽 HTML. <main> 이 없으면 null. */
export function mainInner(html) {
  const o = /<main\b/i.exec(html);
  if (!o) return null;
  const start = readTag(html, o.index).end;
  const end = html.toLowerCase().lastIndexOf('</main');
  return end < start ? null : html.slice(start, end);
}

/**
 * 본문 글자(정규화 전). opts.exclude: 선택자 문자열 배열, opts.textFromAttr: [{ selector, attr }]
 */
export function extractText(inner, opts = {}) {
  const exclude = (opts.exclude ?? []).map(compileSelector);
  const fromAttr = (opts.textFromAttr ?? []).map((r) => ({ match: compileSelector(r.selector), attr: r.attr.toLowerCase() }));
  const out = []; const stack = []; // { name, skip }
  const skipping = () => stack.length > 0 && stack[stack.length - 1].skip;
  let i = 0; const n = inner.length;
  while (i < n) {
    const lt = inner.indexOf('<', i);
    if (lt < 0) { if (!skipping()) out.push(inner.slice(i)); break; }
    if (lt > i && !skipping()) out.push(inner.slice(i, lt));
    if (inner.startsWith('<!--', lt)) { const e = inner.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; out.push(' '); continue; }
    if (inner[lt + 1] === '!' || inner[lt + 1] === '?') { const e = inner.indexOf('>', lt); i = e < 0 ? n : e + 1; out.push(' '); continue; }
    if (!/[a-zA-Z/]/.test(inner[lt + 1] ?? '') || (inner[lt + 1] === '/' && !/[a-zA-Z]/.test(inner[lt + 2] ?? ''))) {
      if (!skipping()) out.push('<'); i = lt + 1; continue; // 글자로 쓰인 '<'
    }
    const t = readTag(inner, lt); i = t.end; out.push(' ');
    if (t.closing) {
      let k = stack.length - 1; while (k >= 0 && stack[k].name !== t.name) k--;
      if (k >= 0) stack.length = k; // 짝이 없는 닫는 태그는 무시
      continue;
    }
    const parentSkip = skipping();
    let skip = parentSkip || ALWAYS_SKIP.has(t.name) || exclude.some((m) => m(t.name, t.attrs));
    if (!skip) {
      const r = fromAttr.find((x) => x.match(t.name, t.attrs));
      if (r) { out.push(' ' + (t.attrs[r.attr] ?? '') + ' '); skip = true; } // 글자 대신 속성값
    }
    if (RAW.has(t.name) && !t.selfClose) {
      const e = inner.toLowerCase().indexOf('</' + t.name, i);
      if (!skip && e > i) out.push(inner.slice(i, e));
      if (e < 0) { i = n; } else { const g = inner.indexOf('>', e); i = g < 0 ? n : g + 1; }
      out.push(' ');
      continue;
    }
    if (VOID.has(t.name) || t.selfClose) continue;
    stack.push({ name: t.name, skip });
  }
  return decodeEntities(out.join(''));
}

/** HTML 문자열 → { text, hash }. <main> 이 없으면 null. */
export function fingerprintHtml(html, opts = {}) {
  const inner = mainInner(html);
  if (inner == null) return null;
  const text = normalizeText(extractText(inner, opts));
  return { text, hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
}

export const fingerprintFile = (file, opts = {}) => fingerprintHtml(fs.readFileSync(file, 'utf8'), opts);
