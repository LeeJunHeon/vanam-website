// IndexNow 알림 대상 계산 — npm run build 의 마지막 단계(scripts/sitemap-lastmod.mjs 다음). (GEO 정리 3차)
//
//   이번 빌드의 공개 기록(dist/client/sitemap-lastmod.json: main 지문·head 지문·llms 파일 지문)을
//   지난 배포의 공개 기록(https://vanam.co.kr/sitemap-lastmod.json)과 비교해 알릴 주소를 고른다(규칙은 scripts/lib/indexnow-lib.mjs computeTargets).
//   결과는 dist/indexnow-targets.json 에 남긴다 — dist/client 밖이라 사이트에 올라가지 않는다. 배포 뒤 scripts/indexnow-submit.mjs 가 읽는다.
//
//   ⚠️ 이 단계는 어떤 경우에도 빌드를 실패시키지 않는다(종료 코드 항상 0). 공개 기록을 못 받으면 전체를 대상으로 적고 이유를 남긴다.
//   사용: node scripts/indexnow-targets.mjs [--dist <dir>] [--out <file>]   환경변수 SITEMAP_LASTMOD_LIVE_URL(테스트용 — 지난 기록 주소)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchPublicRecord, liveRecordSource, publicRecordFile, publicRecordError } from './sitemap-lastmod.mjs';
import { kstDate } from './lib/sitemap-lastmod-lib.mjs';
import { config, computeTargets, toUrl, RECORD_FILES } from './lib/indexnow-lib.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const DIST = opt('--dist', 'dist/client');
const OUT = opt('--out', config.targetsFile);

const write = (obj) => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(obj, null, 2) + '\n');
};

try {
  const curFile = publicRecordFile(DIST);
  const cur = JSON.parse(fs.readFileSync(curFile, 'utf8'));
  const err = publicRecordError(cur, kstDate());
  if (err) throw new Error(`이번 빌드의 공개 기록 형식 오류 ${curFile}: ${err}`);
  const live = await fetchPublicRecord(liveRecordSource());
  const t = computeTargets(live.ok ? live.record : null, cur, RECORD_FILES);
  const byReason = {};
  for (const r of Object.values(t.reasons)) byReason[r] = (byReason[r] ?? 0) + 1;
  write({
    generatedAt: new Date().toISOString(),
    mode: t.mode,
    host: config.host,
    previous: live.ok ? { src: live.src, entries: live.entries } : { src: live.src, error: live.error },
    buildRecordSha256: crypto.createHash('sha256').update(fs.readFileSync(curFile)).digest('hex'),
    counts: { total: t.urls.length, byReason },
    urls: t.urls.map((p) => toUrl(p)),
    reasons: Object.fromEntries(t.urls.map((p) => [toUrl(p), t.reasons[p]])),
  });
  console.log(`indexnow-targets: ${t.mode === 'all' ? '전체' : '차이'} ${t.urls.length}개 → ${OUT}`);
  console.log(`  지난 공개 기록: ${live.ok ? `받음 ${live.src} (${live.entries}개)` : `못 씀 ${live.src} — ${live.error}`}`);
  for (const [r, n] of Object.entries(byReason)) console.log(`  ${r}: ${n}개`);
  if (t.mode === 'diff' && t.urls.length) for (const p of t.urls.slice(0, 40)) console.log(`    ${toUrl(p)}  [${t.reasons[p]}]`);
  if (t.urls.length > 40 && t.mode === 'diff') console.log(`    … 외 ${t.urls.length - 40}개`);
} catch (e) {
  console.warn(`⚠ indexnow-targets: 대상을 계산하지 못했다 — ${e.message} (빌드는 계속한다)`);
  try { write({ generatedAt: new Date().toISOString(), mode: 'error', error: e.message, counts: { total: 0 }, urls: [], reasons: {} }); } catch { /* 쓰기도 실패 — 그래도 빌드는 계속 */ }
}
process.exitCode = 0;
