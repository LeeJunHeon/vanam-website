// 사이트맵 lastmod — "그 페이지 본문 글자가 실제로 바뀐 날"만 넣는다. 날짜를 정하는 곳은 이 스크립트 하나다.
//
// ── 어떻게 동작하나 ──
//   1) astro build 가 lastmod 없는 사이트맵을 만든다 (astro.config.mjs 는 URL 목록·hreflang·제외 규칙만 정한다).
//   2) npm run build 가 이어서 이 스크립트를 실행한다:
//        사이트맵의 URL 마다 dist/client 의 HTML 에서 본문 지문(<main> 글자의 SHA-256, scripts/lib/page-text.mjs)을 만들고
//        기록 파일 src/data/sitemap-lastmod.json 과 비교한다.
//          · 지문이 같다 → 기록에 적힌 날짜를 <lastmod> 로 쓴다.
//          · 지문이 다르거나 기록에 없다 →
//              로컬: 오늘(KST) 날짜로 쓰고 경고. (verify 의 check-sitemap-lastmod 가 실패시킨다)
//              Cloudflare 빌드(WORKERS_CI=1): HEAD 커밋 날짜(KST)로 쓰고 경고. git 을 못 쓰면 빌드 날짜(KST).
//                빌드는 실패시키지 않는다 — Keystatic 에서 직접 고친 커밋이 이 경우다.
//        sitemap-index.xml 의 <lastmod> 는 그 자식 sitemap 에서 가장 최근 날짜다.
//      배포일, 코드·스타일·구조화 데이터(JSON-LD)만 바뀐 날은 지문이 그대로라 날짜가 바뀌지 않는다.
//
// ── 작업 흐름 (화면 글자를 바꾸는 작업을 했을 때) ──
//   npm run build → npm run verify
//     → check-sitemap-lastmod 가 "지문이 다른 URL" 로 실패하면:
//   npm run sitemap:stamp   (바뀐 URL 만 오늘 날짜 + 새 지문으로 기록을 고치고, 사라진 URL 은 기록에서 지운다)
//   → npm run build → npm run verify → src/data/sitemap-lastmod.json 을 같은 커밋에 함께 올린다.
//   stamp 가 출력한 "바뀐 URL" 목록이 이번 작업으로 글자가 바뀐 페이지와 맞는지 꼭 확인한다.
//   글자를 안 바꿨는데 목록에 나오면 stamp 하지 말고 원인(빌드마다 달라지는 글자 등)을 찾아
//   scripts/sitemap-lastmod.config.mjs 의 제외 목록으로 처리한다.
//
// ── 명령 ──
//   node scripts/sitemap-lastmod.mjs            적용 (npm run build 가 자동 실행)
//   node scripts/sitemap-lastmod.mjs --stamp    기록 갱신 후 다시 적용 (npm run sitemap:stamp)
//   공통 옵션: --dist <dir> (기본 dist/client) · --record <file> (기본 src/data/sitemap-lastmod.json) — 테스트용
import fs from 'node:fs';
import path from 'node:path';
import {
  config, parseArgs, kstDate, isCloudflareBuild, headCommitDateKST, loadRecord, saveRecord,
  evaluate, summarize, setUrlLastmod, setIndexLastmod, xmlError, reportFile,
} from './lib/sitemap-lastmod-lib.mjs';

const args = parseArgs(process.argv.slice(2));
const today = kstDate();
const listSome = (items, n = 40) => { for (const s of items.slice(0, n)) console.warn('    ' + s); if (items.length > n) console.warn(`    … 외 ${items.length - n}건`); };

// ── stamp: 기록 파일 갱신 ──
function stamp() {
  const record = loadRecord(args.record);
  const { rows, stale } = evaluate(args.dist, record);
  const changed = [];
  for (const r of rows) {
    if (r.status === 'new' || r.status === 'changed') {
      changed.push(`${r.path}  ${r.status === 'new' ? '(새 URL)' : r.rec.date} → ${today}`);
      record[r.path] = { hash: r.hash, date: today };
    }
  }
  for (const k of stale) delete record[k];
  const skipped = rows.filter((r) => r.status === 'no-html' || r.status === 'no-main');
  saveRecord(args.record, record);
  console.log(`sitemap:stamp — 기록 ${args.record}: 바뀐 URL ${changed.length}개(오늘 ${today}), 지운 URL ${stale.length}개`);
  for (const s of changed) console.log('  바뀜  ' + s);
  for (const s of stale) console.log('  지움  ' + s);
  if (skipped.length) { console.warn(`  ⚠ 지문을 만들 수 없어 건너뛴 URL ${skipped.length}개:`); listSome(skipped.map((r) => `${r.path} (${r.status})`)); }
  if (!changed.length && !stale.length) console.log('  바뀐 것 없음');
}

// ── apply: 사이트맵 XML 에 lastmod 넣기 ──
function apply() {
  const record = loadRecord(args.record);
  const { sm, rows, stale } = evaluate(args.dist, record);
  const base = summarize(sm); // 고치기 전 생성 결과(개수·lastmod 뺀 해시)
  const cf = isCloudflareBuild();
  let fallback = null; // 지문이 안 맞는 URL 에 쓸 날짜
  const fallbackDate = () => {
    if (fallback) return fallback;
    if (!cf) return (fallback = { date: today, source: '오늘(KST) — 로컬' });
    const head = headCommitDateKST();
    return (fallback = head && head <= today ? { date: head, source: 'HEAD 커밋 날짜(KST)' } : { date: today, source: '빌드 날짜(KST) — git 사용 불가' });
  };
  const noHtmlOk = new Set(config.noHtmlUrls);
  const decided = []; const dateByLoc = new Map(); const mismatch = []; const noDate = [];
  for (const r of rows) {
    if (r.status === 'same') { dateByLoc.set(r.loc, r.rec.date); decided.push({ path: r.path, date: r.rec.date, source: 'record' }); }
    else if (r.status === 'new' || r.status === 'changed') {
      const f = fallbackDate(); dateByLoc.set(r.loc, f.date); decided.push({ path: r.path, date: f.date, source: f.source, status: r.status });
      mismatch.push(`${r.path}  ${r.status === 'new' ? '기록 없음' : `지문 다름(기록 ${r.rec.date})`} → ${f.date}  [${f.source}]`);
    } else { decided.push({ path: r.path, date: null, source: r.status }); if (!noHtmlOk.has(r.path)) noDate.push(`${r.path}  (${r.status === 'no-html' ? '정적 HTML 없음' : '<main> 없음'})`); }
  }
  // 자식 sitemap → index
  const indexDates = new Map(); const outputs = [];
  for (const c of sm.children) {
    const xml = setUrlLastmod(c.xml, dateByLoc);
    const dates = c.urls.map((u) => dateByLoc.get(u.loc)).filter(Boolean).sort();
    if (dates.length) indexDates.set(c.loc, dates[dates.length - 1]);
    outputs.push([c.file, xml]);
  }
  outputs.push([sm.indexFile, setIndexLastmod(sm.indexXml, indexDates)]);
  for (const [file, xml] of outputs) { const e = xmlError(xml); if (e) throw new Error(`sitemap-lastmod: 결과 XML 형식 오류 ${file}: ${e}`); }
  for (const [file, xml] of outputs) fs.writeFileSync(file, xml);
  fs.writeFileSync(reportFile(args.dist), JSON.stringify({ mode: cf ? 'cloudflare' : 'local', today, generated: base, mismatch: decided.filter((d) => d.status), noDate: decided.filter((d) => !d.date).map((d) => d.path) }, null, 2) + '\n');

  const all = [...dateByLoc.values()].sort();
  console.log(`sitemap-lastmod: URL ${rows.length}개 — 기록과 같음 ${rows.length - mismatch.length - decided.filter((d) => !d.date).length}, 지문 불일치 ${mismatch.length}, lastmod 없음 ${decided.filter((d) => !d.date).length}` +
    (all.length ? ` · 날짜 범위 ${all[0]} ~ ${all[all.length - 1]}` : '') + ` (${cf ? 'Cloudflare 빌드' : '로컬'})`);
  if (mismatch.length) {
    console.warn(`  ⚠ 지문 불일치 ${mismatch.length}개 — 기록 파일(${args.record})과 본문이 다르다:`); listSome(mismatch);
    console.warn(cf ? '  ⚠ Cloudflare 빌드라 위 날짜로 내보낸다. 로컬에서 npm run sitemap:stamp 후 기록 파일을 커밋해야 날짜가 고정된다.'
      : '  ⚠ 글자를 바꾼 작업이면: npm run sitemap:stamp → npm run build → 기록 파일을 함께 커밋. (verify 의 check-sitemap-lastmod 가 실패한다)');
  }
  if (noDate.length) { console.warn(`  ⚠ lastmod 를 넣지 못한 URL ${noDate.length}개(설정의 noHtmlUrls 에 없음):`); listSome(noDate); }
  if (stale.length) { console.warn(`  ⚠ 사이트맵에서 사라졌는데 기록에 남은 URL ${stale.length}개 (npm run sitemap:stamp 가 지운다):`); listSome(stale); }
}

if (!fs.existsSync(path.join(args.dist, 'sitemap-index.xml'))) {
  console.error(`sitemap-lastmod: ${path.join(args.dist, 'sitemap-index.xml')} 가 없다 — astro build 뒤에 실행한다`);
  process.exit(1);
}
if (args.stamp) stamp();
apply();
