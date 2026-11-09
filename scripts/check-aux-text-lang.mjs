// scripts/check-aux-text-lang.mjs — 화면에 안 보이는 보조 문구의 언어 게이트 (GEO 정리 1차)
//
// 왜 있는가: aria-label · title 속성과 sr-only 글자는 화면 낭독기와 크롤러만 읽는다. 눈에 안 보이니
//   영문 페이지에 한글 "(새 창에서 열림)" 이 90여 개 들어가 있어도 아무도 모른다(실제로 /news/ 가 그랬다).
//
// 검사(빌드 결과 dist/client 의 모든 HTML):
//   · 영문 페이지(경로가 /ko/ 로 시작하지 않음): aria-label · title 속성값과 sr-only 요소 글자에 한글이 있으면 실패.
//   · 한국어 페이지(/ko/…): 같은 자리에 한글 없이 영문 단어(3글자 이상)만 있으면 실패.
//   예외 — 고유명사(아래 PROPER_NOUNS: 브랜드·채널 이름), 그 페이지의 <title>/<h1> 과 같은 글자(콘텐츠 제목을 title 속성으로 반복한 것),
//          404 페이지(두 언어를 한 화면에 함께 쓴다).
//   alt 는 보지 않는다 — 기술 페이지 도판 alt 는 영어 사양 표기와 맞추려고 한글 페이지에서도 영어로 두기로 한 것이다.
//
// 사용: node scripts/check-aux-text-lang.mjs [--dist <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argDist = process.argv.indexOf('--dist');
const DIST = argDist >= 0 ? path.resolve(process.argv[argDist + 1]) : path.join(ROOT, 'dist/client');

/** 언어와 무관하게 그대로 쓰는 고유명사 — 브랜드·채널 이름. 문장은 넣지 않는다. */
const PROPER_NOUNS = new Set(['VanaM', 'VANAM', 'LinkedIn', 'YouTube', 'Linktree', 'Naver Store', 'Instagram', 'Facebook', 'X']);
const SKIP_FILES = new Set(['404.html']);

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.html')) files.push(p);
  }
})(DIST);
if (!files.length) { console.error(`check-aux-text-lang: ${DIST} 에 HTML 이 없다 — 먼저 빌드한다`); process.exit(1); }

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const hasHangul = (s) => /[ᄀ-ᇿ㄰-㆏가-힯]/.test(s);
const hasEnglishWord = (s) => /[A-Za-z]{3,}/.test(s);

const problems = new Map();
const note = (key, file) => { if (!problems.has(key)) problems.set(key, new Set()); problems.get(key).add(path.relative(DIST, file)); };
let checked = 0;

for (const file of files) {
  const rel = path.relative(DIST, file);
  if (SKIP_FILES.has(rel)) continue;
  const ko = rel === 'ko' || rel.startsWith('ko/');
  const html = fs.readFileSync(file, 'utf8');
  const pageTitle = decode(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '');
  const h1 = decode(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? '');
  const found = [];
  for (const m of html.matchAll(/\s(aria-label|title)="([^"]*)"/g)) found.push([m[1], decode(m[2])]);
  for (const m of html.matchAll(/<([a-z0-9]+)[^>]*\bclass="[^"]*\bsr-only\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)) found.push(['sr-only', decode(m[2])]);
  for (const [kind, text] of found) {
    if (!text) continue;
    checked++;
    if (PROPER_NOUNS.has(text) || text === pageTitle || text === h1) continue;
    const bad = ko ? (!hasHangul(text) && hasEnglishWord(text)) : hasHangul(text);
    if (bad) note(`${ko ? 'KO' : 'EN'} 페이지 ${kind}="${text}"`, file);
  }
}

if (problems.size) {
  console.error(`✗ 보조 문구 언어 불일치 ${problems.size}종 — 영문 페이지에는 영문, 한국어 페이지에는 한글로 쓴다(고유명사 제외):`);
  for (const [k, set] of [...problems.entries()].sort((a, b) => b[1].size - a[1].size)) console.error(`  ✗ ${k}  — ${set.size}개 파일 (예: ${[...set][0]})`);
  process.exit(1);
}
console.log(`check-aux-text-lang OK — HTML ${files.length}개 · aria-label·title·sr-only ${checked}건 모두 페이지 언어와 일치`);
