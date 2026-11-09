// 사이트맵 lastmod — "그 페이지 본문 글자가 실제로 바뀐 날"만 넣는다. 날짜를 정하는 곳은 이 스크립트 하나다.
//
// ── 어떻게 동작하나 ──
//   1) astro build 가 lastmod 없는 사이트맵을 만든다 (astro.config.mjs 는 URL 목록·hreflang·제외 규칙만 정한다).
//   2) npm run build 가 이어서 이 스크립트를 실행한다:
//        사이트맵의 URL 마다 dist/client 의 HTML 에서 본문 지문(<main> 글자의 SHA-256, scripts/lib/page-text.mjs)을 만들고
//        아래 순서로 날짜를 정한다 (Cloudflare 빌드·로컬 공통).
//          a. 지문이 저장소 기록 파일 src/data/sitemap-lastmod.json 과 같다 → 기록에 적힌 날짜.
//          b. 다르거나 기록에 없다 → 이전 배포의 공개 기록(https://vanam.co.kr/sitemap-lastmod.json)을 한 번 받아,
//             그 URL 에 같은 지문이 있으면 그 날짜를 이어받는다. (Keystatic 수정 때 Cloudflare 가 찍은 날짜가 배포마다 밀리지 않게 한다)
//          c. 공개 기록에도 같은 지문이 없다(= 이번에 새로 바뀜), 또는 공개 기록을 못 받았거나 형식이 잘못됐다 →
//               로컬: 오늘(KST) 날짜로 쓰고 경고. (verify 의 check-sitemap-lastmod 가 실패시킨다)
//               Cloudflare 빌드(WORKERS_CI=1): HEAD 커밋 날짜(KST)로 쓰고 경고. git 을 못 쓰면 빌드 날짜(KST).
//                 빌드는 실패시키지 않는다 — Keystatic 에서 직접 고친 커밋이 이 경우다.
//        sitemap-index.xml 의 <lastmod> 는 그 자식 sitemap 에서 가장 최근 날짜다.
//        이번 빌드가 사이트맵에 실제로 쓴 { 지문, 날짜 } 를 dist/client/sitemap-lastmod.json 으로 함께 내보낸다(다음 빌드의 b 단계가 읽는다).
//        (3차) 공개 기록에는 head 지문과 llms 파일 지문도 함께 둔다 — IndexNow 알림 대상 판단(scripts/indexnow-targets.mjs)에만 쓰고 lastmod 에는 쓰지 않는다.
//      배포일, 코드·스타일·구조화 데이터(JSON-LD)만 바뀐 날은 지문이 그대로라 날짜가 바뀌지 않는다.
//      날짜 출처는 기록 파일 · 이전 배포의 공개 기록 · HEAD 커밋 날짜 · 오늘(로컬) 네 가지뿐이다.
//
// ── 작업 흐름 (화면 글자를 바꾸는 작업을 했을 때) ──
//   npm run build → npm run verify
//     → check-sitemap-lastmod 가 "지문이 다른 URL" 로 실패하면:
//   npm run sitemap:stamp   (바뀐 URL 만 새 지문으로 기록을 고치고, 사라진 URL 은 기록에서 지운다.
//                            날짜는 이전 배포의 공개 기록에 같은 지문이 있으면 그 날짜, 없으면 오늘)
//   → npm run build → npm run verify → src/data/sitemap-lastmod.json 을 같은 커밋에 함께 올린다.
//   stamp 가 출력한 "바뀐 URL" 목록이 이번 작업으로 글자가 바뀐 페이지와 맞는지 꼭 확인한다.
//   글자를 안 바꿨는데 목록에 나오면 stamp 하지 말고 원인(빌드마다 달라지는 글자 등)을 찾아
//   scripts/sitemap-lastmod.config.mjs 의 제외 목록으로 처리한다.
//
// ── 명령 ──
//   node scripts/sitemap-lastmod.mjs            적용 (npm run build 가 자동 실행)
//   node scripts/sitemap-lastmod.mjs --stamp    기록 갱신 후 다시 적용 (npm run sitemap:stamp)
//   공통 옵션: --dist <dir> (기본 dist/client) · --record <file> (기본 src/data/sitemap-lastmod.json) — 테스트용
//   환경변수: SITEMAP_LASTMOD_LIVE_URL — 이전 배포의 공개 기록 주소를 바꾼다(파일 경로도 허용) — 테스트용
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  config, parseArgs, kstDate, isCloudflareBuild, headCommitDateKST, isValidDate, loadRecord, saveRecord,
  evaluate, summarize, setUrlLastmod, setIndexLastmod, xmlError, reportFile, isFileKey, fileEntries,
} from './lib/sitemap-lastmod-lib.mjs';

const PUB = config.publicRecord;
const listSome = (items, n = 40) => { for (const s of items.slice(0, n)) console.warn('    ' + s); if (items.length > n) console.warn(`    … 외 ${items.length - n}건`); };

// ── 공개 기록 ──
/** 이번 빌드가 내보내는 공개 기록 파일 위치. */
export const publicRecordFile = (dist) => path.join(dist, PUB.file);

/**
 * 공개 기록 형식 검사. 문제없으면 null.
 *   페이지 항목 { "<URL 경로>": { hash, date, head? } } — 날짜는 YYYY-MM-DD 이고 오늘(KST) 이후가 아니다. head(3차 추가)는 있으면 SHA-256.
 *   파일 항목 { "/llms.txt": { hash } } — config.publicRecord.files 의 키만. date 없음.
 *   옛 형식(head·파일 항목 없음)도 통과한다 — 하위 호환.
 */
const SHA_RE = /^[0-9a-f]{64}$/;
export function publicRecordError(obj, today = kstDate()) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'JSON 객체가 아니다';
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return `${k}: 항목이 객체가 아니다`;
    if (typeof v.hash !== 'string' || !SHA_RE.test(v.hash)) return `${k}: hash 가 SHA-256(16진수 64자)이 아니다`;
    if (isFileKey(k)) { if (v.date !== undefined) return `${k}: 파일 항목에는 date 가 없어야 한다`; continue; }
    if (typeof v.date !== 'string' || !isValidDate(v.date)) return `${k}: date 가 YYYY-MM-DD 가 아니다 (${JSON.stringify(v.date)})`;
    if (v.date > today) return `${k}: 오늘(${today} KST) 이후 날짜 ${v.date}`;
    if (v.head !== undefined && (typeof v.head !== 'string' || !SHA_RE.test(v.head))) return `${k}: head 가 SHA-256(16진수 64자)이 아니다`;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function httpGetText(url) {
  let last;
  for (let attempt = 0; attempt <= PUB.retries; attempt++) {
    if (attempt) await sleep(2000);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PUB.timeoutMs), cache: 'no-store', headers: { accept: 'application/json' } });
      if (res.ok) return await res.text();
      last = new Error(`HTTP ${res.status}`);
      if (res.status < 500 && res.status !== 408 && res.status !== 429) break; // 404 등은 다시 받아도 같다
    } catch (e) {
      last = new Error(e.name === 'TimeoutError' ? `시간 초과(${PUB.timeoutMs / 1000}초)` : `${e.message}${(e.cause?.code ?? e.cause?.errors?.[0]?.code) ? ` (${e.cause.code ?? e.cause.errors[0].code})` : ''}`);
    }
  }
  throw last;
}

/** 이전 배포의 공개 기록 주소(환경변수 SITEMAP_LASTMOD_LIVE_URL 로 바꿀 수 있다 — 파일 경로도 허용). */
export const liveRecordSource = () => process.env.SITEMAP_LASTMOD_LIVE_URL || PUB.liveUrl;
/** 공개 기록을 받아 형식까지 확인한다. 실패해도 던지지 않는다 — { ok, src, record?, entries?, error? }. (scripts/indexnow-targets.mjs 도 쓴다) */
export async function fetchPublicRecord(src = liveRecordSource(), today = kstDate()) {
  let text;
  try {
    if (/^https?:\/\//i.test(src)) text = await httpGetText(src);
    else text = fs.readFileSync(src.startsWith('file://') ? fileURLToPath(src) : src, 'utf8');
  } catch (e) {
    return { ok: false, src, error: `받지 못했다 — ${e.message}` };
  }
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { ok: false, src, error: `JSON 이 아니다 — ${e.message}` }; }
  const err = publicRecordError(obj, today);
  if (err) return { ok: false, src, error: `형식이 잘못됐다 — ${err}` };
  return { ok: true, src, record: obj, entries: Object.keys(obj).length };
}
/** 이전 배포의 공개 기록을 받는다. 빌드당 한 번(지문이 안 맞는 URL 이 있을 때만). */
let livePromise = null;
const loadLive = (today) => (livePromise ??= fetchPublicRecord(liveRecordSource(), today));
/** 공개 기록에 그 URL 이 같은 지문으로 있으면 그 항목. */
const liveMatch = (live, r) => (live?.ok && Object.hasOwn(live.record, r.path) && live.record[r.path].hash === r.hash ? live.record[r.path] : null);
const liveLine = (live) => (!live ? '받지 않음 — 지문이 기록과 다른 URL 이 없다'
  : live.ok ? `받음 ${live.src} (${live.entries}개)`
    : `못 씀 ${live.src} — ${live.error}`);

// ── stamp: 기록 파일 갱신 ──
async function stamp(args, today) {
  const record = loadRecord(args.record);
  const { rows, stale } = evaluate(args.dist, record);
  const pending = rows.filter((r) => r.status === 'new' || r.status === 'changed');
  const live = pending.length ? await loadLive(today) : null;
  const changed = []; let fromLive = 0;
  for (const r of pending) {
    const lv = liveMatch(live, r);
    const date = lv ? lv.date : today;
    if (lv) fromLive++;
    changed.push(`${r.path}  ${r.status === 'new' ? '(새 URL)' : r.rec.date} → ${date}  [${lv ? '이전 배포의 공개 기록' : '오늘(KST)'}]`);
    record[r.path] = { hash: r.hash, date };
  }
  for (const k of stale) delete record[k];
  const skipped = rows.filter((r) => r.status === 'no-html' || r.status === 'no-main');
  saveRecord(args.record, record);
  console.log(`sitemap:stamp — 기록 ${args.record}: 바뀐 URL ${changed.length}개(이전 배포의 공개 기록 날짜 ${fromLive}개 · 오늘 ${today} ${changed.length - fromLive}개), 지운 URL ${stale.length}개`);
  if (live) console.log(`  공개 기록(이전 배포): ${liveLine(live)}`);
  if (live && !live.ok) console.warn('  ⚠ 공개 기록을 쓸 수 없어 바뀐 URL 은 모두 오늘 날짜로 기록했다.');
  for (const s of changed) console.log('  바뀜  ' + s);
  for (const s of stale) console.log('  지움  ' + s);
  if (skipped.length) { console.warn(`  ⚠ 지문을 만들 수 없어 건너뛴 URL ${skipped.length}개:`); listSome(skipped.map((r) => `${r.path} (${r.status})`)); }
  if (!changed.length && !stale.length) console.log('  바뀐 것 없음');
}

// ── apply: 사이트맵 XML 에 lastmod 넣기 + 공개 기록 출력 ──
async function apply(args, today) {
  const record = loadRecord(args.record);
  const { sm, rows, stale } = evaluate(args.dist, record);
  const base = summarize(sm); // 고치기 전 생성 결과(개수·lastmod 뺀 해시)
  const cf = isCloudflareBuild();
  const pending = rows.filter((r) => r.status === 'new' || r.status === 'changed');
  const live = pending.length ? await loadLive(today) : null; // 지문이 전부 맞으면 받으러 가지 않는다
  let fallback = null; // c 단계 날짜
  const fallbackDate = () => {
    if (fallback) return fallback;
    if (!cf) return (fallback = { date: today, source: '오늘(KST) — 로컬' });
    const head = headCommitDateKST();
    return (fallback = head && head <= today ? { date: head, source: 'HEAD 커밋 날짜(KST)' } : { date: today, source: '빌드 날짜(KST) — git 사용 불가' });
  };
  const noHtmlOk = new Set(config.noHtmlUrls);
  const decided = []; const dateByLoc = new Map(); const mismatch = []; const noDate = [];
  const stages = { a: 0, b: 0, c: 0 }; const pub = {};
  const set = (r, stage, date, source) => {
    stages[stage]++; dateByLoc.set(r.loc, date); pub[r.path] = { hash: r.hash, date, head: r.head };
    decided.push({ path: r.path, date, stage, source, ...(stage === 'a' ? {} : { status: r.status }) });
    if (stage !== 'a') mismatch.push(`${r.path}  ${r.status === 'new' ? '기록 없음' : `지문 다름(기록 ${r.rec.date})`} → ${date}  [${stage} · ${source}]`);
  };
  for (const r of rows) {
    if (r.status === 'same') set(r, 'a', r.rec.date, '기록 파일');
    else if (r.status === 'new' || r.status === 'changed') {
      const lv = liveMatch(live, r);
      if (lv) set(r, 'b', lv.date, '이전 배포의 공개 기록');
      else { const f = fallbackDate(); set(r, 'c', f.date, f.source); }
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
  Object.assign(pub, fileEntries(args.dist)); // llms 파일 내용 지문(IndexNow 판단용)
  saveRecord(publicRecordFile(args.dist), pub); // 이번 빌드가 사이트맵에 실제로 쓴 값 + head·파일 지문
  const noDateCount = decided.filter((d) => !d.date).length;
  fs.writeFileSync(reportFile(args.dist), JSON.stringify({
    mode: cf ? 'cloudflare' : 'local', today, generated: base, stages,
    live: live ? { used: true, ok: live.ok, src: live.src, ...(live.ok ? { entries: live.entries } : { error: live.error }) } : { used: false },
    mismatch: decided.filter((d) => d.status), noDate: decided.filter((d) => !d.date).map((d) => d.path),
  }, null, 2) + '\n');

  const all = [...dateByLoc.values()].sort();
  console.log(`sitemap-lastmod: URL ${rows.length}개 — 기록과 같음 ${stages.a}, 지문 불일치 ${mismatch.length}, lastmod 없음 ${noDateCount}` +
    (all.length ? ` · 날짜 범위 ${all[0]} ~ ${all[all.length - 1]}` : '') + ` (${cf ? 'Cloudflare 빌드' : '로컬'})`);
  console.log(`  날짜 출처: a 기록 파일 ${stages.a} · b 이전 배포의 공개 기록 ${stages.b} · c 새로 바뀜 ${stages.c}`);
  console.log(`  공개 기록(이전 배포): ${liveLine(live)}`);
  console.log(`  공개 기록 출력: ${publicRecordFile(args.dist)} (${Object.keys(pub).length}개)`);
  if (live && !live.ok) console.warn('  ⚠ 이전 배포의 공개 기록을 쓸 수 없어 b 단계를 건너뛰었다 — 지문이 다른 URL 은 모두 c 단계 날짜를 받는다.');
  if (mismatch.length) {
    console.warn(`  ⚠ 지문 불일치 ${mismatch.length}개 — 기록 파일(${args.record})과 본문이 다르다:`); listSome(mismatch);
    console.warn(cf ? '  ⚠ Cloudflare 빌드라 위 날짜로 내보낸다. 이 날짜는 공개 기록으로 다음 배포에 이어진다. 로컬에서 npm run sitemap:stamp 후 기록 파일을 커밋하면 저장소에도 고정된다.'
      : '  ⚠ 글자를 바꾼 작업이면: npm run sitemap:stamp → npm run build → 기록 파일을 함께 커밋. (verify 의 check-sitemap-lastmod 가 실패한다)');
  }
  if (noDate.length) { console.warn(`  ⚠ lastmod 를 넣지 못한 URL ${noDate.length}개(설정의 noHtmlUrls 에 없음):`); listSome(noDate); }
  if (stale.length) { console.warn(`  ⚠ 사이트맵에서 사라졌는데 기록에 남은 URL ${stale.length}개 (npm run sitemap:stamp 가 지운다):`); listSome(stale); }
}

// 게이트(check-sitemap-lastmod.mjs)가 위 검사 함수를 가져다 쓴다 — 직접 실행했을 때만 적용한다.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const today = kstDate();
  if (!fs.existsSync(path.join(args.dist, 'sitemap-index.xml'))) {
    console.error(`sitemap-lastmod: ${path.join(args.dist, 'sitemap-index.xml')} 가 없다 — astro build 뒤에 실행한다`);
    process.exit(1);
  }
  if (args.stamp) await stamp(args, today);
  await apply(args, today);
}
