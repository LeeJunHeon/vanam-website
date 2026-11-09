// scripts/check-internal-links.mjs — 내부 링크 끝 슬래시 게이트 (GEO 정리 1차)
//
// 왜 있는가: 정적 페이지는 Cloudflare 가 /technology 요청을 301 로 /technology/ 에 보낸다.
//   헤더 메뉴처럼 전 페이지에 깔린 링크가 슬래시 없이 걸려 있으면 방문자·크롤러가 클릭마다 한 번씩 더 돌고,
//   사이트맵의 정식 주소(끝 슬래시)와 링크 주소가 어긋난다. 링크는 src/lib/site-path.js 의 함수로만 만들고, 여기서 결과를 전수 검사한다.
//
// 검사: 빌드된 HTML(dist/client) 전체에서 사이트 안을 가리키는 href · action · data-*-url 속성값과
//       JSON-LD·메타의 절대 주소(https://vanam.co.kr/…)를 모아, 경로가
//         · 끝 슬래시가 없고
//         · 빌드 결과에 정적 페이지(<경로>/index.html)가 있으면        → 실패 (301 이 난다)
//       서버 경로(src/lib/site-path.js 의 SERVER_PATHS · /api/…)와 파일(확장자 있음)은 제외한다.
//       사이트맵에 있는 주소는 모두 정적 페이지이므로 "사이트맵 페이지를 슬래시 없이 가리키는 링크" 는 전부 잡힌다.
//
// 사용: node scripts/check-internal-links.mjs [--dist <dir>]   (빌드 후 실행 — dist/client 를 읽는다)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isServerPath, isFilePath, SERVER_PATHS } from '../src/lib/site-path.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argDist = process.argv.indexOf('--dist');
const DIST = argDist >= 0 ? path.resolve(process.argv[argDist + 1]) : path.join(ROOT, 'dist/client');
const SITE = 'https://vanam.co.kr';

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.html')) files.push(p);
  }
})(DIST);
if (!files.length) { console.error(`check-internal-links: ${DIST} 에 HTML 이 없다 — 먼저 빌드한다`); process.exit(1); }

const sitemap = fs.readFileSync(path.join(DIST, 'sitemap-0.xml'), 'utf8');
const sitemapPaths = new Set([...sitemap.matchAll(/<loc>https:\/\/vanam\.co\.kr([^<]*)<\/loc>/g)].map((m) => m[1]));

/** 그 경로에 정적 페이지가 있는가 (/technology → dist/client/technology/index.html) */
const staticPageAt = (p) => {
  const rel = decodeURIComponent(p).replace(/^\//, '');
  if (!rel) return true;
  const f = path.join(DIST, rel, 'index.html');
  return fs.existsSync(f) && fs.statSync(f).isFile();
};

const problems = new Map(); // "속성 → 값" → Set(file)
const note = (key, file) => { if (!problems.has(key)) problems.set(key, new Set()); problems.get(key).add(path.relative(DIST, file)); };
let checked = 0;
let serverSkipped = 0;

for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const values = [];
  for (const m of html.matchAll(/\b(href|action|data-[a-z-]*url)="([^"]*)"/g)) values.push([m[1], m[2]]);
  for (const m of html.matchAll(/"(https:\/\/vanam\.co\.kr[^"]*)"/g)) values.push(['absolute', m[1]]);
  for (const [attr, raw] of values) {
    let v = raw.replace(/&amp;/g, '&');
    if (v.startsWith(SITE)) v = v.slice(SITE.length) || '/';
    if (!v.startsWith('/') || v.startsWith('//')) continue;
    const p = /^([^?#]*)/.exec(v)[1];
    if (!p || p.endsWith('/') || isFilePath(p)) { checked++; continue; }
    if (isServerPath(p)) { serverSkipped++; continue; }
    checked++;
    if (staticPageAt(p)) note(`${attr}="${raw}"${sitemapPaths.has(p + '/') ? ' (사이트맵 페이지)' : ''}`, file);
  }
}

if (problems.size) {
  console.error(`✗ 끝 슬래시 없는 내부 링크 ${problems.size}종 — 정적 페이지는 정식 주소(끝 슬래시)로 걸어야 한다(src/lib/site-path.js):`);
  for (const [k, set] of [...problems.entries()].sort((a, b) => b[1].size - a[1].size)) console.error(`  ✗ ${k}  — ${set.size}개 파일 (예: ${[...set][0]})`);
  process.exit(1);
}
console.log(`check-internal-links OK — HTML ${files.length}개 · 내부 주소 ${checked}건 모두 정식 주소 · 서버 경로 예외 ${serverSkipped}건 (${SERVER_PATHS.join(' ')} · /api/…)`);
