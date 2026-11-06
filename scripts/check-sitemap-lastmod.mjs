// 사이트맵 lastmod 게이트 — 빌드 결과(dist/client)의 사이트맵을 검사한다. (흐름·사용법은 scripts/sitemap-lastmod.mjs 상단)
//   node scripts/check-sitemap-lastmod.mjs [--dist <dir>] [--record <file>]
//
// 어디서나 실패:
//   · XML 이 올바른 형식이 아니다
//   · lastmod 가 없는 URL (설정의 noHtmlUrls 예외만 허용) / YYYY-MM-DD 가 아닌 날짜 / 오늘(KST) 이후 날짜
//   · sitemap-index 의 lastmod ≠ 자식 sitemap 의 가장 최근 날짜
//   · URL 수·hreflang 수·lastmod 를 뺀 XML 이 astro 가 만든 결과와 다르다 (lastmod 외의 것이 바뀜)
//   · 지문이 기록과 같은 URL 인데 lastmod 가 기록 날짜와 다르다 (적용 단계가 안 돌았다)
// 로컬에서만 실패 (Cloudflare 빌드 WORKERS_CI=1 에서는 경고):
//   · 지문이 기록과 다른 URL · 기록에 없는 URL · 사이트맵에서 사라졌는데 기록에 남은 URL
//     → npm run sitemap:stamp 후 다시 빌드
import fs from 'node:fs';
import path from 'node:path';
import {
  config, parseArgs, kstDate, isCloudflareBuild, isValidDate, loadRecord,
  evaluate, summarize, xmlError, reportFile,
} from './lib/sitemap-lastmod-lib.mjs';

const args = parseArgs(process.argv.slice(2));
const today = kstDate();
const cf = isCloudflareBuild();
const errors = []; const warnings = [];
const fail = (m) => errors.push(m);
const some = (list, n = 12) => list.slice(0, n).join(', ') + (list.length > n ? ` … 외 ${list.length - n}건` : '');

if (!fs.existsSync(path.join(args.dist, 'sitemap-index.xml'))) {
  console.error(`check-sitemap-lastmod FAIL: ${path.join(args.dist, 'sitemap-index.xml')} 가 없다 — npm run build 먼저`);
  process.exit(1);
}
const record = loadRecord(args.record);
const { sm, rows, stale } = evaluate(args.dist, record);

// 1) XML 형식
for (const [file, xml] of [[sm.indexFile, sm.indexXml], ...sm.children.map((c) => [c.file, c.xml])]) {
  const e = xmlError(xml);
  if (e) fail(`XML 형식 오류 ${file}: ${e}`);
}

// 2) lastmod 유무·형식·미래 날짜
const noHtmlOk = new Set(config.noHtmlUrls);
const missing = rows.filter((r) => !r.lastmod && !noHtmlOk.has(r.path));
if (missing.length) fail(`lastmod 없는 URL ${missing.length}개: ${some(missing.map((r) => r.path))}`);
const unexpected = rows.filter((r) => noHtmlOk.has(r.path) && r.file);
if (unexpected.length) fail(`noHtmlUrls 예외인데 정적 HTML 이 있는 URL ${unexpected.length}개(예외 목록에서 빼야 함): ${some(unexpected.map((r) => r.path))}`);
const badFormat = rows.filter((r) => r.lastmod && !isValidDate(r.lastmod));
if (badFormat.length) fail(`lastmod 형식이 YYYY-MM-DD 가 아닌 URL ${badFormat.length}개: ${some(badFormat.map((r) => `${r.path}=${r.lastmod}`))}`);
const future = rows.filter((r) => r.lastmod && isValidDate(r.lastmod) && r.lastmod > today);
if (future.length) fail(`오늘(${today} KST) 이후 날짜 ${future.length}개: ${some(future.map((r) => `${r.path}=${r.lastmod}`))}`);
const noFp = rows.filter((r) => (r.status === 'no-html' || r.status === 'no-main') && !noHtmlOk.has(r.path));
if (noFp.length) fail(`지문을 만들 수 없는 URL ${noFp.length}개(정적 HTML 또는 <main> 없음): ${some(noFp.map((r) => `${r.path}(${r.status})`))}`);

// 3) sitemap-index lastmod = 자식의 최댓값
for (const c of sm.children) {
  const dates = c.urls.map((u) => u.lastmod).filter(Boolean).sort();
  const max = dates.length ? dates[dates.length - 1] : null;
  if (c.lastmod !== max) fail(`sitemap-index 의 ${c.name} lastmod(${c.lastmod}) ≠ 자식의 가장 최근 날짜(${max})`);
}

// 4) astro 가 만든 결과와 비교 — lastmod 외에는 한 글자도 달라지면 안 된다
const now = summarize(sm);
const repFile = reportFile(args.dist);
if (!fs.existsSync(repFile)) fail(`${repFile} 가 없다 — 적용 단계(scripts/sitemap-lastmod.mjs)가 돌지 않았다. npm run build 로 빌드한다`);
else {
  const gen = JSON.parse(fs.readFileSync(repFile, 'utf8')).generated;
  for (const name of new Set([...Object.keys(gen), ...Object.keys(now)])) {
    const a = gen[name], b = now[name];
    if (!a || !b) { fail(`사이트맵 파일 구성이 생성 결과와 다르다: ${name}`); continue; }
    if (a.urls !== b.urls) fail(`${name} URL 수 ${b.urls} ≠ 생성 결과 ${a.urls}`);
    if (a.hreflang !== b.hreflang) fail(`${name} hreflang 링크 수 ${b.hreflang} ≠ 생성 결과 ${a.hreflang}`);
    if (a.sha256NoLastmod !== b.sha256NoLastmod) fail(`${name} 에서 lastmod 외의 내용이 생성 결과와 다르다`);
  }
}

// 5) 기록과의 일치
const drift = rows.filter((r) => r.status === 'same' && r.lastmod !== r.rec.date);
if (drift.length) fail(`지문은 기록과 같은데 lastmod 가 기록 날짜와 다른 URL ${drift.length}개(적용 단계가 안 돌았다 — 다시 빌드): ${some(drift.map((r) => `${r.path} ${r.lastmod}≠${r.rec.date}`))}`);
const changed = rows.filter((r) => r.status === 'changed');
const added = rows.filter((r) => r.status === 'new');
const localOnly = [];
if (changed.length) localOnly.push(`본문 지문이 기록과 다른 URL ${changed.length}개: ${some(changed.map((r) => r.path))}`);
if (added.length) localOnly.push(`기록에 없는 URL ${added.length}개: ${some(added.map((r) => r.path))}`);
if (stale.length) localOnly.push(`사이트맵에서 사라졌는데 기록에 남은 URL ${stale.length}개: ${some(stale)}`);
if (localOnly.length) {
  const guide = '→ 화면 글자를 바꾼 작업이면 npm run sitemap:stamp 후 다시 빌드(npm run build)하고, src/data/sitemap-lastmod.json 을 함께 커밋한다';
  if (cf) warnings.push(...localOnly, '(Cloudflare 빌드라 경고만 — 로컬에서 stamp 후 기록 파일을 커밋해야 날짜가 고정된다)');
  else { localOnly.forEach(fail); fail(guide); }
}

const urls = rows.length; const hreflang = rows.reduce((n, r) => n + r.hreflang, 0);
for (const w of warnings) console.warn('  ⚠ ' + w);
if (errors.length) {
  console.error(`check-sitemap-lastmod FAIL (${errors.length}건, ${args.dist}):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
const dates = rows.map((r) => r.lastmod).filter(Boolean).sort();
console.log(`check-sitemap-lastmod OK — URL ${urls}개 · hreflang ${hreflang}개 · lastmod ${dates.length}개 (${dates[0]} ~ ${dates[dates.length - 1]}) · 기록 일치 ${rows.filter((r) => r.status === 'same').length}${cf ? ' · Cloudflare 빌드' : ''}`);
