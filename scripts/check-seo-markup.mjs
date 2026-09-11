// scripts/check-seo-markup.mjs — 검색 노출 마크업 게이트 (0911, 재발 방지 가드레일)
//
// 왜 있는가: 아래 넷은 전부 "조용히 사라지는" 종류의 회귀다.
//   ① 소재 상세 52개로 가는 내부 링크 — 링크가 사라져도 화면은 멀쩡하고, 색인만 몇 달 밀린다.
//      (실제로 0910 이전까지 상세 104개가 사이트맵에만 있고 앵커는 0개였다)
//   ② 사이트맵 lastmod — 빌드 시각이 새어 들어가면 매 배포마다 전 페이지가 "갱신됨"이 되어
//      크롤러가 lastmod 자체를 무시하게 된다.
//   ③ canonical 이 다른 곳을 가리키는 URL(/blog/ → /news/)이 사이트맵에 남아 상충 신호를 준다.
//   ④ 웨이퍼 Product/Offer — 필드 하나만 빠져도 리치 결과에서 통째로 탈락한다.
//
// 사용: node scripts/check-seo-markup.mjs   (빌드 후 실행 — dist 를 읽는다)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist/client');
const SITE = 'https://vanam.co.kr';

let bad = 0;
const fail = (msg) => { console.error('  ✗', msg); bad++; };
const ok = (msg) => console.log('  ✓', msg);
const html = (rel) => readFileSync(join(DIST, rel), 'utf8');

// ── ① 소재 상세 내부 링크 ────────────────────────────────
const matCount = readdirSync(join(ROOT, 'src/content/materials')).filter((f) => f.endsWith('.json')).length;
for (const [page, prefix] of [['materials/index.html', '/materials/'], ['ko/materials/index.html', '/ko/materials/']]) {
  const h = html(page);
  const re = new RegExp(`<a [^>]*href="${prefix.replace(/\//g, '\\/')}m\\d+\\/"`, 'g');
  const n = (h.match(re) || []).length;
  if (n !== matCount) fail(`${page}: 소재 상세 앵커 ${n}개 — ${matCount}개여야 한다(칩이 <a> 가 아니면 0이 된다)`);
  else ok(`${page}: 소재 상세 앵커 ${n}개`);
}

// ── ①-b 블로그 내부 링크의 끝 슬래시 ────────────────────
// 슬래시가 빠지면 링크마다 307 이 한 홉 더 붙고, 사이트맵의 정본 URL 과 어긋난다.
// dist 전체(HTML)에서 /blog/<slug> 형태의 슬래시 없는 내부 링크·JSON-LD url 을 찾는다.
{
  const pages = [];
  (function walk(dir) {
    for (const n of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, n.name);
      if (n.isDirectory()) walk(full);
      else if (n.name.endsWith('.html')) pages.push(full);
    }
  })(DIST);

  // href="/ko/blog/slug"(슬래시·확장자 없음) 과 JSON-LD 의 절대 URL 둘 다 본다.
  const HREF_RE = /href="(\/(?:ko\/)?blog\/[a-z0-9][a-z0-9-]*)"/g;
  const LD_RE = new RegExp(`"(${SITE}\\/(?:ko\\/)?blog\\/[a-z0-9][a-z0-9-]*)"`, 'g');
  const offenders = new Map();
  for (const f of pages) {
    const h = readFileSync(f, 'utf8');
    for (const re of [HREF_RE, LD_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(h))) {
        const rel = f.replace(DIST + '/', '');
        if (!offenders.has(m[1])) offenders.set(m[1], rel);
      }
    }
  }
  if (offenders.size) {
    const sample = [...offenders.entries()].slice(0, 5).map(([u, f]) => `${u} (${f})`).join(', ');
    fail(`끝 슬래시 없는 블로그 링크 ${offenders.size}종: ${sample}`);
  } else {
    ok(`블로그 내부 링크 전부 끝 슬래시 (${pages.length}개 HTML 검사)`);
  }
}

// ── ②③ 사이트맵 ─────────────────────────────────────────
const smPath = join(DIST, 'sitemap-0.xml');
if (!existsSync(smPath)) {
  fail('sitemap-0.xml 이 없다');
} else {
  const xml = readFileSync(smPath, 'utf8');
  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => {
    const loc = /<loc>([^<]*)<\/loc>/.exec(m[1])?.[1] ?? '';
    const lastmod = /<lastmod>([^<]*)<\/lastmod>/.exec(m[1])?.[1] ?? null;
    return { loc, path: loc.replace(SITE, ''), lastmod };
  });
  ok(`사이트맵 URL ${entries.length}개`);

  const blogIndex = entries.filter((e) => /^\/(?:ko\/)?blog\/?$/.test(e.path));
  if (blogIndex.length) fail(`블로그 목록이 사이트맵에 남아 있다(canonical 은 /news/): ${blogIndex.map((e) => e.path).join(', ')}`);
  else ok('블로그 목록(/blog/, /ko/blog/) 제외됨');

  const posts = entries.filter((e) => /^\/(?:ko\/)?blog\/[^/]+\/$/.test(e.path));
  const postsNoDate = posts.filter((e) => !e.lastmod);
  if (!posts.length) fail('블로그 글이 사이트맵에 하나도 없다');
  else if (postsNoDate.length) fail(`lastmod 없는 블로그 글 ${postsNoDate.length}개: ${postsNoDate.slice(0, 3).map((e) => e.path).join(', ')}`);
  else ok(`블로그 글 ${posts.length}개 전부 lastmod 보유`);

  const others = entries.filter((e) => !/^\/(?:ko\/)?blog\/[^/]+\/$/.test(e.path));
  const strayLastmod = others.filter((e) => e.lastmod);
  if (strayLastmod.length) fail(`실제 날짜가 없는 페이지에 lastmod 가 붙었다(빌드 시각 누출 의심) ${strayLastmod.length}개: ${strayLastmod.slice(0, 3).map((e) => e.path).join(', ')}`);
  else ok(`나머지 ${others.length}개 페이지에는 lastmod 없음`);

  // 블로그 글의 lastmod 가 콘텐츠의 date 와 같은지 (빌드 시각이 아닌지) 표본 확인
  const blogDir = join(ROOT, 'src/content/blog');
  let mismatch = 0;
  for (const e of posts) {
    const slug = e.path.replace(/^\/(?:ko\/)?blog\//, '').replace(/\/$/, '');
    const f = join(blogDir, `${slug}.json`);
    if (!existsSync(f)) continue;
    const want = new Date(JSON.parse(readFileSync(f, 'utf8')).date).toISOString().slice(0, 10);
    if (e.lastmod.slice(0, 10) !== want) mismatch++;
  }
  if (mismatch) fail(`lastmod 가 글의 date 와 다른 항목 ${mismatch}개`);
  else ok('블로그 lastmod = 콘텐츠 date');
}

// ── ⑤ 메타 설명 (0911c) ─────────────────────────────────
// 검색 스니펫이 비거나 한 줄짜리면 클릭률이 바닥이다. 주요 페이지는 최소 길이를 못 박고,
// 제품 설명의 물질 나열이 라이브러리와 어긋나지 않는지(소재 추가 시 누락) 대조한다.
{
  const META_D = /<meta name="description" content="([^"]*)"/;
  const META_OG = /<meta property="og:description" content="([^"]*)"/;
  const decode = (v) => v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const descOf = (rel) => {
    const h = html(rel);
    return { d: decode(META_D.exec(h)?.[1] ?? ''), og: decode(META_OG.exec(h)?.[1] ?? '') };
  };

  const KEY_PAGES = [];
  for (const loc of ['', 'ko/']) {
    for (const p of ['product/oxides', 'product/nitrides', 'product/metals', 'product/multilayers',
                     'product/wafers', 'wafers', 'materials', 'contact']) {
      KEY_PAGES.push(`${loc}${p}/index.html`);
    }
  }
  const MIN_KEY = 80;
  const short = [];
  const noOg = [];
  for (const rel of KEY_PAGES) {
    if (!existsSync(join(DIST, rel))) { fail(`${rel} 없음`); continue; }
    const { d, og } = descOf(rel);
    if (d.length < MIN_KEY) short.push(`${rel}(${d.length}자)`);
    if (!og.trim()) noOg.push(rel);
  }
  if (short.length) fail(`주요 페이지 description 이 ${MIN_KEY}자 미만: ${short.join(', ')}`);
  else ok(`주요 페이지 ${KEY_PAGES.length}개 description ${MIN_KEY}자 이상`);
  if (noOg.length) fail(`og:description 없음: ${noOg.join(', ')}`);
  else ok(`주요 페이지 og:description 전부 존재`);

  // 산화물 제품 설명에 라이브러리의 산화물이 전부 들어 있는지 (소재를 추가했는데 설명이 안 따라온 경우 탐지)
  const oxides = readdirSync(join(ROOT, 'src/content/materials'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(ROOT, 'src/content/materials', f), 'utf8')))
    .filter((m) => m.category === 'Oxide')
    .map((m) => m.formula);
  const uniqOxides = [...new Set(oxides)];
  for (const rel of ['product/oxides/index.html', 'ko/product/oxides/index.html']) {
    const { d } = descOf(rel);
    const missing = uniqOxides.filter((f) => !d.includes(f));
    if (missing.length) fail(`${rel}: 설명에 빠진 산화물 ${missing.length}종 — ${missing.join(', ')}`);
    else ok(`${rel}: 라이브러리 산화물 ${uniqOxides.length}종 전부 포함`);
  }

  // 블로그 글 — 한 줄짜리 제목 복붙이 많아 자동 보강한 결과를 검사
  const blogPages = [];
  (function walk(dir) {
    for (const n of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, n.name);
      if (n.isDirectory()) walk(full);
      else if (n.name === 'index.html' && /\/blog\/[^/]+\/index\.html$/.test(full)) blogPages.push(full);
    }
  })(DIST);
  const MIN_BLOG = 60;
  const shortBlog = blogPages
    .map((f) => ({ p: f.replace(DIST + '/', ''), len: decode(META_D.exec(readFileSync(f, 'utf8'))?.[1] ?? '').length }))
    .filter((x) => x.len < MIN_BLOG);
  if (shortBlog.length) fail(`블로그 description ${MIN_BLOG}자 미만 ${shortBlog.length}개: ${shortBlog.slice(0, 3).map((x) => `${x.p}(${x.len})`).join(', ')}`);
  else ok(`블로그 ${blogPages.length}편 description ${MIN_BLOG}자 이상`);
}

// ── ④ 웨이퍼 Product/Offer ───────────────────────────────
const waferIds = readdirSync(join(ROOT, 'src/content/wafers'))
  .filter((f) => f.endsWith('.json'))
  .filter((f) => JSON.parse(readFileSync(join(ROOT, 'src/content/wafers', f), 'utf8')).published !== false)
  .map((f) => f.replace(/\.json$/, ''));

let ldOk = 0;
for (const loc of ['', 'ko/']) {
  for (const id of waferIds) {
    const rel = `${loc}wafers/${id}/index.html`;
    if (!existsSync(join(DIST, rel))) { fail(`${rel} 없음`); continue; }
    const h = html(rel);
    const blocks = [...h.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    let prod = null;
    for (const b of blocks) {
      let j;
      try { j = JSON.parse(b); } catch { fail(`${rel}: JSON-LD 파싱 실패`); continue; }
      if (j['@type'] === 'Product') prod = j;
    }
    if (!prod) { fail(`${rel}: Product JSON-LD 없음`); continue; }

    const problems = [];
    if (!prod.name?.trim()) problems.push('name 비었음');
    if (!prod.description?.trim()) problems.push('description 비었음');
    if (!prod.sku?.trim()) problems.push('sku 비었음');
    if (prod.brand?.name !== 'VanaM') problems.push('brand.name 이 VanaM 이 아님');
    if (!prod.image) problems.push('image 없음');
    else if (!String(prod.image).startsWith('https://')) problems.push(`image 가 절대 URL 이 아님(${prod.image})`);
    const o = prod.offers;
    if (!o) problems.push('offers 없음');
    else {
      if (typeof o.price !== 'number' || !(o.price > 0)) problems.push(`price 가 양의 숫자가 아님(${JSON.stringify(o.price)})`);
      if (o.priceCurrency !== 'KRW') problems.push(`priceCurrency=${o.priceCurrency}`);
      if (!String(o.url || '').startsWith(SITE)) problems.push(`offers.url 이 절대 URL 이 아님(${o.url})`);
      if (o.availability !== 'https://schema.org/InStock') problems.push(`availability=${o.availability}`);
      if (o.itemCondition !== 'https://schema.org/NewCondition') problems.push(`itemCondition=${o.itemCondition}`);
      // 다이싱 요금이 기본가로 새어 들어가지 않았는지 — 컬렉션의 priceKrw 와 정확히 같아야 한다
      const src = JSON.parse(readFileSync(join(ROOT, 'src/content/wafers', `${id}.json`), 'utf8'));
      if (o.price !== src.priceKrw) problems.push(`price(${o.price}) ≠ priceKrw(${src.priceKrw})`);
    }
    if (problems.length) fail(`${rel}: ${problems.join(' · ')}`);
    else ldOk++;
  }
}
if (ldOk) ok(`웨이퍼 Product/Offer ${ldOk}개 페이지 필수 필드 충족`);

if (bad) {
  console.error(`\n✗ 검색 노출 마크업 게이트 실패 — ${bad}건`);
  process.exit(1);
}
console.log('✓ 검색 노출 마크업 게이트 통과 — 소재 내부 링크 · 사이트맵 lastmod · 웨이퍼 Product/Offer');
