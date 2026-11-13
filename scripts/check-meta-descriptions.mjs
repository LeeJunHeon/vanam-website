// scripts/check-meta-descriptions.mjs — 검색 설명(meta description) 게이트
//
// 왜 있는가: Bing 웹마스터는 160자를 넘는 meta description 을 "설명이 너무 깁니다"로 표시한다(269개 중 59개가 걸렸었다).
//   설명은 화면에 보이지 않아서 소재를 추가하거나 문구를 고쳐 길이가 다시 넘어도 아무도 모른다. 빌드 결과에서 직접 잰다.
//   또 소재 상세는 검색 설명을 본문과 따로 둘 수 있게 됐다(metaDescription 필드) — 화면에 없는 숫자가
//   검색 결과에만 실리는 일을 막는다.
//
// 검사(빌드 결과 dist/client):
//   ① 모든 index.html — <meta name="description"> 이 있으면 HTML 엔티티를 푼 글자 수(코드포인트)가 160 이하.
//   ② 소재 상세(/materials/mNN/, /ko/materials/mNN/) — 검색 설명의 숫자 토큰(소수점 포함, 위첨자·아래첨자 숫자 제외)이
//      그 페이지 <main> 의 화면 글자에 모두 있다(토큰 단위 대조 — "2.5" 는 "2.53" 과 다르다).
//
// 길이 규칙을 만드는 쪽: src/lib/meta-descriptions.ts (META_DESC_LIMIT · clipMetaDescription · {oxides:N}).
// 문의 페이지 한글 80자 이상 등 다른 설명 규칙은 check-seo-markup.mjs 에 그대로 있다.
//
// 사용: node scripts/check-meta-descriptions.mjs [--dist <dir>] [--list]
//   --list  모든 설명의 글자 수를 길이순으로 출력(보고용)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEntities, mainInner, extractText } from './lib/page-text.mjs';

const LIMIT = 160;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argDist = process.argv.indexOf('--dist');
const DIST = argDist >= 0 ? path.resolve(process.argv[argDist + 1]) : path.join(ROOT, 'dist/client');
const LIST = process.argv.includes('--list');

if (!fs.existsSync(DIST)) { console.error(`✗ check-meta-descriptions: ${DIST} 가 없다 — 먼저 npm run build`); process.exit(1); }

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : e.name === 'index.html' ? [p] : [];
});

/** <meta name="description" content="…"> 의 값(엔티티를 푼 것). 태그가 없으면 null. 속성 순서·따옴표 종류에 기대지 않는다. */
function metaDescriptionOf(html) {
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd < 0 ? html : html.slice(0, headEnd);
  for (const m of head.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const tag = m[0];
    const attr = (name) => {
      const a = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
      return a ? (a[1] ?? a[2] ?? a[3]) : null;
    };
    if ((attr('name') ?? '').toLowerCase() === 'description') return decodeEntities(attr('content') ?? '');
  }
  return null;
}

/** 숫자 토큰 — ASCII 숫자만(소수점 포함). 위첨자(⁴)·아래첨자(₂)는 \d 에 안 걸리므로 자연히 빠진다. */
const numberTokens = (s) => new Set(s.match(/\d+(?:\.\d+)?/g) ?? []);

const files = walk(DIST).sort();
if (!files.length) { console.error(`✗ check-meta-descriptions: ${DIST} 에 index.html 이 없다`); process.exit(1); }

let bad = 0;
const fail = (p, msg, text) => { bad++; console.error(`✗ ${p} — ${msg}\n    ${text}`); };

const rows = [];
let withDesc = 0, matChecked = 0, longest = 0;
for (const file of files) {
  const rel = path.relative(DIST, file).split(path.sep).join('/');
  const url = '/' + rel.replace(/index\.html$/, '');
  const html = fs.readFileSync(file, 'utf8');
  const desc = metaDescriptionOf(html);
  if (desc == null) continue;
  withDesc++;
  const len = [...desc].length;
  longest = Math.max(longest, len);
  rows.push({ url, len, desc });
  if (len > LIMIT) fail(url, `meta description ${len}자 (한도 ${LIMIT}자)`, desc);

  if (/^\/(ko\/)?materials\/m\d+\/$/.test(url)) {
    matChecked++;
    const inner = mainInner(html);
    if (inner == null) { fail(url, '<main> 이 없다 — 숫자 대조를 할 수 없다', desc); continue; }
    const shown = numberTokens(extractText(inner));
    const missing = [...numberTokens(desc)].filter((n) => !shown.has(n));
    if (missing.length) fail(url, `검색 설명의 숫자가 화면(<main>)에 없다: ${missing.join(', ')}`, desc);
  }
}

if (LIST) for (const r of rows.sort((a, b) => b.len - a.len)) console.log(`${String(r.len).padStart(4)}  ${r.url}`);

if (!matChecked) { bad++; console.error('✗ 소재 상세 페이지를 하나도 찾지 못했다 — 경로 규칙(/materials/mNN/)이 바뀌었는지 확인'); }
if (bad) { console.error(`\n✗ check-meta-descriptions 실패 — ${bad}건`); process.exit(1); }
console.log(`check-meta-descriptions OK — index.html ${files.length}개 중 설명 ${withDesc}개 모두 ${LIMIT}자 이하(최장 ${longest}자) · 소재 상세 ${matChecked}개 숫자 화면 일치`);
