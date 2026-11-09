// scripts/check-page-titles.mjs — 페이지 <title> 게이트 (GEO 정리 2차)
//
// 왜 있는가: 제목은 검색 결과·AI 답변에서 페이지를 대표하는 한 줄이다. 데이터 파일(site.json) 한 줄이 바뀌거나
//   컴포넌트가 접미사를 빼먹어도 화면은 멀쩡해서 아무도 모른다. 기대값을 여기(게이트 데이터)에 따로 두고 빌드 결과와 대조한다.
//
// 검사(빌드 결과 dist/client):
//   ① 아래 EXPECTED 표의 30개 페이지 <title> 이 표와 정확히 같다.
//   ② 소재 상세 114개(57종 × EN·KO)의 <title> 이 규칙과 같다 — 기대값은 소재 데이터(src/content/materials)에서 여기서 따로 만든다.
//        영문:   {name} ({formula}) Thin Film — {PVD|ALD} | VanaM          (Multilayer 는 Thin Film → Multilayer)
//        한국어: {name_ko} ({formula}) 박막 — {PVD|ALD} 증착 | 반암(VanaM)   (Multilayer 는 박막 → 다층막)
//   ③ 사이트맵의 모든 페이지 <title> 이 서로 겹치지 않는다.
//   ④ 홈(/, /ko/)과 블로그 글을 뺀 사이트맵 페이지의 제목은 영문 " | VanaM", 한국어 " | 반암(VanaM)" 으로 끝난다.
//   ⑤ og:title 은 <title> 과 같다(BaseLayout 이 같은 값을 쓴다).
//
// 사용: node scripts/check-page-titles.mjs [--dist <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argDist = process.argv.indexOf('--dist');
const DIST = argDist >= 0 ? path.resolve(process.argv[argDist + 1]) : path.join(ROOT, 'dist/client');

/** ① 고정 제목 — 2차 지시 표 그대로. 바꾸려면 site.json(또는 src/lib/page-titles.js · src/lib/faq.ts)과 이 표를 함께 고친다. */
const EXPECTED = {
  '/product/': 'Product & Solution — Thin Films, Wafers, Analysis & Equipment | VanaM',
  '/ko/product/': '제품 · 솔루션 — 박막·웨이퍼·분석·장비 | 반암(VanaM)',
  '/product/oxides/': 'Oxides — Custom Oxide Thin-Film Deposition | VanaM',
  '/ko/product/oxides/': '산화물 박막 — 맞춤 증착 | 반암(VanaM)',
  '/product/nitrides/': 'Nitrides — Custom Nitride Thin-Film Deposition | VanaM',
  '/ko/product/nitrides/': '질화물 박막 — 맞춤 증착 | 반암(VanaM)',
  '/product/metals/': 'Metals — Custom Metal Thin-Film Deposition | VanaM',
  '/ko/product/metals/': '금속 박막 — 맞춤 증착 | 반암(VanaM)',
  '/product/multilayers/': 'Multilayers — Custom Multilayer Thin-Film Stacks | VanaM',
  '/ko/product/multilayers/': '다층 박막 — 맞춤 적층 | 반암(VanaM)',
  '/product/wafers/': 'Wafers — Bare & Thin-Film-Coated | VanaM',
  '/ko/product/wafers/': '웨이퍼 — 베어·박막 코팅 웨이퍼 | 반암(VanaM)',
  '/wafers/': 'Wafers — Silicon, Oxide & Sapphire, Buy Online | VanaM',
  '/ko/wafers/': '웨이퍼 — 실리콘·산화막·사파이어 온라인 구매 | 반암(VanaM)',
  '/technology/': 'Technology — AI Deposition, Quantum Photonics & VO₂ | VanaM',
  '/ko/technology/': '기술 — AI 증착 공정·양자 포토닉스·VO₂ | 반암(VanaM)',
  '/materials/': 'Thin-Film Materials Library — Specs & Data | VanaM',
  '/ko/materials/': '박막 소재 라이브러리 — 사양·측정 데이터 | 반암(VanaM)',
  '/faq/': 'FAQ — Thin-Film Deposition, Materials & Ordering | VanaM',
  '/ko/faq/': '자주 묻는 질문 — 박막 증착·소재·주문 | 반암(VanaM)',
  '/contact/': 'Contact — Thin-Film Deposition Quotes & Consultation | VanaM',
  '/ko/contact/': '문의 — 박막 증착 견적·기술 상담 | 반암(VanaM)',
  '/news/': 'Insight — News, Press & Blog | VanaM',
  '/ko/news/': '인사이트 — 뉴스·보도자료·블로그 | 반암(VanaM)',
  // 한국어 웨이퍼 상세 6개 — 상품명(h1) 그대로 + 한국어 접미사
  '/ko/wafers/wafer-si-4inch/': '4인치 실리콘 웨이퍼 | 반암(VanaM)',
  '/ko/wafers/wafer-si-oxide-4inch/': '4인치 산화막 실리콘 웨이퍼 | 반암(VanaM)',
  '/ko/wafers/wafer-si-6inch-prime/': '6인치 실리콘 웨이퍼 (Prime) | 반암(VanaM)',
  '/ko/wafers/wafer-si-6inch-test/': '6인치 실리콘 웨이퍼 (Test) | 반암(VanaM)',
  '/ko/wafers/wafer-si-oxide-6inch/': '6인치 산화막 실리콘 웨이퍼 | 반암(VanaM)',
  '/ko/wafers/wafer-sapphire-2inch/': '2인치 사파이어 웨이퍼 | 반암(VanaM)',
};

let bad = 0;
const fail = (page, what, got, why) => { console.error(`  ✗ ${page} · ${what}: ${got} — ${why}`); bad++; };
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const read = (p) => {
  const f = path.join(DIST, p.replace(/^\//, ''), 'index.html');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};
const titleOf = (html) => decode(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '');
const ogTitleOf = (html) => decode(/<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ?? '');

const sitemapFile = path.join(DIST, 'sitemap-0.xml');
if (!fs.existsSync(sitemapFile)) { console.error(`check-page-titles: ${sitemapFile} 가 없다 — 먼저 빌드한다`); process.exit(1); }
const sitemapPaths = [...fs.readFileSync(sitemapFile, 'utf8').matchAll(/<loc>https:\/\/vanam\.co\.kr([^<]*)<\/loc>/g)].map((m) => m[1]);

// ① 고정 표
for (const [p, want] of Object.entries(EXPECTED)) {
  const html = read(p);
  if (!html) { fail(p, '<title>', '(페이지 없음)', '빌드 결과에 없다'); continue; }
  const got = titleOf(html);
  if (got !== want) fail(p, '<title>', got, `기대값: ${want}`);
}

// ② 소재 상세 — 데이터에서 기대값 생성 (src/lib/page-titles.js 와 별개로 여기서 다시 적는다)
const matDir = path.join(ROOT, 'src/content/materials');
const mats = fs.readdirSync(matDir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ id: path.basename(f, '.json'), ...JSON.parse(fs.readFileSync(path.join(matDir, f), 'utf8')) }));
let matChecked = 0;
for (const m of mats) {
  const sys = m.system === 'ald' ? 'ALD' : 'PVD';
  const multi = m.category === 'Multilayer';
  const expect = {
    [`/materials/${m.id}/`]: `${m.name ?? m.formula} (${m.formula}) ${multi ? 'Multilayer' : 'Thin Film'} — ${sys} | VanaM`,
    [`/ko/materials/${m.id}/`]: `${m.name_ko ?? m.name ?? m.formula} (${m.formula}) ${multi ? '다층막' : '박막'} — ${sys} 증착 | 반암(VanaM)`,
  };
  for (const [p, want] of Object.entries(expect)) {
    const html = read(p);
    if (!html) { fail(p, '<title>', '(페이지 없음)', '빌드 결과에 없다'); continue; }
    matChecked++;
    const got = titleOf(html);
    if (got !== want) fail(p, '<title>', got, `규칙 기대값: ${want}`);
    // h1·화학식 배지와 같은 값인지 — 제목의 이름·화학식이 화면과 어긋나면 안 된다
    const h1 = decode(/<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1] ?? '');
    if (!got.startsWith(`${h1} (${m.formula})`)) fail(p, '<title> 과 h1', `${h1} / ${got}`, '제목의 이름이 h1 과 다르다');
  }
}

// ③ 중복 · ④ 접미사 · ⑤ og:title
const seen = new Map();
let suffixChecked = 0;
for (const p of sitemapPaths) {
  const html = read(p);
  if (!html) { fail(p, '<title>', '(페이지 없음)', '사이트맵 페이지가 빌드 결과에 없다'); continue; }
  const t = titleOf(html);
  if (!t) fail(p, '<title>', '(비어 있음)', '제목이 없다');
  if (seen.has(t)) fail(p, '<title> 중복', t, `${seen.get(t)} 와 같다`); else seen.set(t, p);
  const og = ogTitleOf(html);
  if (og && og !== t) fail(p, 'og:title', og, `<title>(${t}) 과 다르다`);
  const ko = p === '/ko/' || p.startsWith('/ko/');
  const isHome = p === '/' || p === '/ko/';
  const isBlog = /^\/(ko\/)?blog\//.test(p);
  if (isHome || isBlog) continue;
  suffixChecked++;
  const suffix = ko ? ' | 반암(VanaM)' : ' | VanaM';
  if (!t.endsWith(suffix)) fail(p, '<title> 접미사', t, `"${suffix}" 로 끝나야 한다`);
}

if (bad) { console.error(`\n✗ check-page-titles 실패 — ${bad}건`); process.exit(1); }
console.log(`check-page-titles OK — 고정 제목 ${Object.keys(EXPECTED).length}개 · 소재 제목 ${matChecked}개 규칙 일치 · 사이트맵 ${sitemapPaths.length}개 제목 중복 없음 · 접미사 ${suffixChecked}개 일치 · og:title 동일`);
