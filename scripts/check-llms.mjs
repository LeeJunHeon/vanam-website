// scripts/check-llms.mjs — AI 용 요약 파일(llms.txt · llms-full.txt) 정확성 게이트 (GEO 정리 1차)
//
// 왜 있는가: llms 파일은 AI 답변 엔진이 사이트 대신 읽는 요약이다. 사이트에 없는 공정(PLD·MOCVD)이 적혀 있거나,
//   옛 주소(/about)나 끝 슬래시 없는 주소가 남거나, FAQ 답이 확정 문구와 한 글자라도 다르면 AI 가 틀린 말을 한다.
//
// 검사(빌드 결과 dist/client 기준):
//   ① 두 파일에 PLD · MOCVD 가 없다.
//   ② 두 파일의 https://vanam.co.kr… 주소는 모두 사이트맵의 정식 주소(끝 슬래시, #앵커 허용 — 앵커는 그 페이지 HTML 에 id 로 있어야 한다)
//      이거나 빌드 결과에 실제로 있는 파일(/llms-full.txt · /sitemap-index.xml 같은 확장자 있는 경로)이다.
//   ③ llms-full.txt 의 FAQ 38개 — ID · 답 위치(EN·KO) · EN 질문·답 · KO 질문·답이 src/data/faq.json 과 글자 하나까지 같다.
//      llms.txt 의 FAQ 섹션 첫 줄에 답 원문이 llms-full.txt 에 있다는 안내가 있다.
//   ④ 사이트맵의 모든 소재 상세 주소(/materials/mNN/ · /ko/materials/mNN/)가 llms-full.txt 에 있고,
//      "## Materials library" 섹션이 소재 데이터에서 만든 것과 같다(사양 줄에 구분자 ';' 가 없어야 한다 — 생성 형식의 전제).
//
// 사용: node scripts/check-llms.mjs [--dist <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFaq, faqUrl, faqSectionRange, sectionRange, parseFullFaqSection, LLMS_FULL_URL, SITE } from './lib/faq-data.mjs';
import { loadMaterials, llmsMaterialsSection, materialUrl, visibleSpecs, MATERIALS_HEADING } from './lib/materials-data.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argDist = process.argv.indexOf('--dist');
const DIST = argDist >= 0 ? path.resolve(process.argv[argDist + 1]) : path.join(ROOT, 'dist/client');

let bad = 0;
const fail = (file, what, got, why) => { console.error(`  ✗ ${file} · ${what}: ${String(got).slice(0, 120)} — ${why}`); bad++; };

const read = (name) => {
  const f = path.join(DIST, name);
  if (!fs.existsSync(f)) { console.error(`check-llms: ${f} 가 없다 — 먼저 빌드한다`); process.exit(1); }
  return fs.readFileSync(f, 'utf8');
};
const texts = { 'llms.txt': read('llms.txt'), 'llms-full.txt': read('llms-full.txt') };
const sitemap = read('sitemap-0.xml');
const sitemapPaths = new Set([...sitemap.matchAll(/<loc>https:\/\/vanam\.co\.kr([^<]*)<\/loc>/g)].map((m) => m[1]));

// ① PLD · MOCVD
for (const [name, text] of Object.entries(texts)) {
  for (const word of ['PLD', 'MOCVD']) {
    const m = new RegExp(`\\b${word}\\b`).exec(text);
    if (m) fail(name, word, text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\n/g, ' '), '사이트에 없는 공정 — FAQ E01 범위(PVD·ALD)만 적는다');
  }
}

// ② 주소
const anchorCache = new Map();
const pageHasId = (p, id) => {
  const key = `${p}#${id}`;
  if (anchorCache.has(key)) return anchorCache.get(key);
  const f = path.join(DIST, decodeURIComponent(p).replace(/^\//, ''), 'index.html');
  const ok = fs.existsSync(f) && new RegExp(` id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(fs.readFileSync(f, 'utf8'));
  anchorCache.set(key, ok);
  return ok;
};
let urlCount = 0;
for (const [name, text] of Object.entries(texts)) {
  for (const m of text.matchAll(/https:\/\/vanam\.co\.kr[^\s)\]>"']*/g)) {
    urlCount++;
    const raw = m[0].replace(/[.,;:]+$/, ''); // 문장 끝 구두점
    const rest = raw.slice(SITE.length);
    const mm = /^([^?#]*)(\?[^#]*)?(#(.*))?$/.exec(rest);
    const p = mm[1]; const hash = mm[4];
    if (mm[2]) { fail(name, '주소', raw, '쿼리(?)가 붙은 주소는 쓰지 않는다'); continue; }
    if (!p) { fail(name, '주소', raw, `경로가 없다 — ${SITE}/ 처럼 끝 슬래시까지 적는다`); continue; }
    if (/\.[a-z0-9]+$/i.test(p)) {
      if (!fs.existsSync(path.join(DIST, p.replace(/^\//, '')))) fail(name, '주소', raw, '빌드 결과에 그 파일이 없다');
      continue;
    }
    if (!sitemapPaths.has(p)) { fail(name, '주소', raw, p.endsWith('/') ? '사이트맵에 없는 주소' : '끝 슬래시 없음 — 사이트맵의 정식 주소로 적는다'); continue; }
    if (hash !== undefined && !pageHasId(p, hash)) fail(name, '주소', raw, `앵커 #${hash} 가 ${p} 페이지에 없다`);
  }
}

// ③ FAQ
const FAQ = loadFaq();
{
  const full = texts['llms-full.txt'];
  let items = [];
  try { const { start, end } = faqSectionRange(full); items = parseFullFaqSection(full.slice(start, end)); }
  catch (e) { fail('llms-full.txt', 'FAQ 섹션', '', e.message); }
  if (items.length !== FAQ.items.length) fail('llms-full.txt', 'FAQ 항목 수', items.length, `${FAQ.items.length}개여야 한다`);
  FAQ.items.forEach((it, i) => {
    const got = items[i];
    if (!got) return;
    const want = { id: it.id, page: `${faqUrl(it, 'en')} · ${faqUrl(it, 'ko')}`, qEn: it.en.q, aEn: it.en.a, qKo: it.ko.q, aKo: it.ko.a };
    for (const [k, v] of Object.entries(want)) if (got[k] !== v) fail('llms-full.txt', `FAQ ${it.id} ${k}`, got[k] ?? '(없음)', '데이터(src/data/faq.json)와 다름');
  });
  const llms = texts['llms.txt'];
  try {
    const { start, end } = faqSectionRange(llms);
    const firstLine = llms.slice(start, end).split('\n')[1] ?? '';
    if (!firstLine.includes(LLMS_FULL_URL)) fail('llms.txt', 'FAQ 첫 줄', firstLine, `답 원문이 ${LLMS_FULL_URL} 에 있다는 안내가 있어야 한다`);
    if (/^- A \(/m.test(llms.slice(start, end))) fail('llms.txt', 'FAQ', '답 줄 발견', 'llms.txt 에는 질문 목록만 둔다(답 원문은 llms-full.txt)');
  } catch (e) { fail('llms.txt', 'FAQ 섹션', '', e.message); }
}

// ④ 소재
const MATS = loadMaterials();
{
  const full = texts['llms-full.txt'];
  const matPaths = [...sitemapPaths].filter((p) => /^\/(ko\/)?materials\/m\d+\/$/.test(p));
  for (const p of matPaths) if (!full.includes(`${SITE}${p}`)) fail('llms-full.txt', '소재 주소', p, '사이트맵의 소재 상세 주소가 없다');
  const dataPaths = new Set(MATS.flatMap((m) => [materialUrl(m, 'en'), materialUrl(m, 'ko')].map((u) => u.slice(SITE.length))));
  for (const p of dataPaths) if (!sitemapPaths.has(p)) fail('sitemap-0.xml', '소재 주소', p, '소재 데이터에는 있는데 사이트맵에 없다');
  for (const m of MATS) for (const s of visibleSpecs(m)) for (const row of s.rows) if (row.includes(';')) fail('materials', `${m.id} 사양 줄`, row, "사양 줄에 ';' 가 있으면 llms 의 한 줄 나열(구분자 ';')과 섞인다 — 생성 형식을 바꾸거나 문구를 확인한다");
  try {
    const { start, end } = sectionRange(full, MATERIALS_HEADING);
    const got = full.slice(start, end);
    const want = llmsMaterialsSection(MATS);
    if (got.replace(/\n+$/, '\n') !== want.replace(/\n+$/, '\n')) fail('llms-full.txt', '소재 목록', got.split('\n')[1], '소재 데이터에서 만든 목록과 다름 — npm run build 로 다시 만든다(scripts/llms-sections.mjs)');
  } catch (e) { fail('llms-full.txt', '소재 섹션', '', e.message); }
}

if (bad) { console.error(`\n✗ check-llms 실패 — ${bad}건`); process.exit(1); }
console.log(`check-llms OK — PLD·MOCVD 없음 · 주소 ${urlCount}건 모두 정식 주소 · FAQ ${FAQ.items.length}개 EN·KO 답 원문 일치 · 소재 ${MATS.length}종 주소·사양 일치`);
