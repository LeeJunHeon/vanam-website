// IndexNow 전송 — 배포가 끝난 뒤 바뀐 주소를 https://api.indexnow.org/indexnow 로 보낸다. (GEO 정리 3차)
//
//   ⚠️ 어떤 경우에도 종료 코드는 0 이다. 전송 실패·네트워크 오류·형식 오류는 로그만 남긴다 — 배포를 실패시키지 않는다.
//
//   로그 순서: ① 실행 환경 판단 한 줄(WORKERS_CI · WORKERS_CI_BRANCH · --all → 보내는지) ② 대상 개수·목록 ③ 라이브 확인 ④ 전송 결과.
//
//   인자 없음 (npm run deploy 의 wrangler deploy 다음):
//     · 실제 사이트 배포(WORKERS_CI=1 이고 WORKERS_CI_BRANCH 가 프로덕션 브랜치)일 때만 보낸다. 로컬·미리보기 빌드는 로그만 남기고 끝.
//     · 대상은 빌드가 남긴 dist/indexnow-targets.json (scripts/indexnow-targets.mjs).
//     · 보내기 전에 라이브가 이번 빌드인지 확인한다 — 라이브 /sitemap-lastmod.json 이 dist/client/sitemap-lastmod.json 과 같아질 때까지 재시도.
//       라이브 키 파일 /<key>.txt 도 200·내용 일치여야 한다. 둘 중 하나라도 아니면 보내지 않는다.
//   --dry   : 보낼 목록과 개수만 출력하고 보내지 않는다 (npm run indexnow:dry)
//   --all   : 사이트맵 전체(라이브 sitemap-index.xml 기준) + llms 두 파일을 한 번 보낸다. WORKERS_CI 없이도 보낸다 (npm run indexnow:submit -- --all).
//             라이브 키 파일 확인은 한다. 빌드 결과는 필요 없다.
//   --targets <file> · --dist <dir> : 대상 파일·빌드 결과 위치 바꾸기(테스트용)
//   환경변수: INDEXNOW_ENDPOINT(전송 주소) · INDEXNOW_LIVE_BASE(라이브 주소) · INDEXNOW_WAIT_MS(재시도 간격) — 테스트용
import fs from 'node:fs';
import path from 'node:path';
import { config, keyPath, submitUrls, toUrl, canonJson, RECORD_FILES } from './lib/indexnow-lib.mjs';
import lastmodConfig from './sitemap-lastmod.config.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const ALL = argv.includes('--all');
const ti = argv.indexOf('--targets');
const TARGETS = ti >= 0 ? argv[ti + 1] : config.targetsFile;
const di = argv.indexOf('--dist');
const DIST = di >= 0 ? argv[di + 1] : 'dist/client';
const BASE = (process.env.INDEXNOW_LIVE_BASE || config.live.base).replace(/\/+$/, '');
const ENDPOINT = process.env.INDEXNOW_ENDPOINT || config.endpoint;
const log = (s) => console.log(`indexnow-submit: ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(config.live.timeoutMs), cache: 'no-store' });
  return { status: res.status, text: res.ok ? await res.text() : '' };
}

/** 라이브 사이트맵의 모든 URL (--all 용). */
async function liveSitemapUrls() {
  const idx = await getText(`${BASE}/sitemap-index.xml`);
  if (idx.status !== 200) throw new Error(`라이브 sitemap-index.xml HTTP ${idx.status}`);
  const children = [...idx.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => `${BASE}${new URL(m[1]).pathname}`); // 자식 사이트맵도 같은 라이브 주소에서
  const urls = [];
  for (const c of children) {
    const xml = await getText(c);
    if (xml.status !== 200) throw new Error(`라이브 ${c} HTTP ${xml.status}`);
    for (const m of xml.text.matchAll(/<url>[\s\S]*?<loc>([^<]+)<\/loc>/g)) urls.push(m[1]);
  }
  if (!urls.length) throw new Error('라이브 사이트맵에 URL 이 없다');
  return urls;
}

/** 라이브 키 파일 확인 — 200 이고 내용(공백 제거)이 키와 같아야 한다. */
async function keyFileOk() {
  const url = `${BASE}${keyPath()}`;
  try {
    const r = await getText(url);
    if (r.status !== 200) { log(`키 파일 ${url} HTTP ${r.status} — 보내지 않는다`); return false; }
    if (r.text.trim() !== config.key) { log(`키 파일 ${url} 내용이 설정의 키와 다르다 — 보내지 않는다`); return false; }
    log(`키 파일 확인 ${url} HTTP 200 · 내용 일치`);
    return true;
  } catch (e) { log(`키 파일 ${url} 요청 실패 — ${e.message} — 보내지 않는다`); return false; }
}

/** 라이브가 이번 빌드인지 — 라이브 /sitemap-lastmod.json == dist/client/sitemap-lastmod.json 이 될 때까지 기다린다. */
async function liveIsThisBuild() {
  const local = path.join(DIST, lastmodConfig.publicRecord.file);
  if (!fs.existsSync(local)) { log(`${local} 이 없다 — 이번 빌드의 공개 기록을 찾을 수 없어 보내지 않는다`); return false; }
  const want = canonJson(JSON.parse(fs.readFileSync(local, 'utf8')));
  const url = `${BASE}/sitemap-lastmod.json`;
  for (let i = 1; i <= config.live.waitAttempts; i++) {
    try {
      const r = await getText(url);
      if (r.status === 200 && canonJson(JSON.parse(r.text)) === want) { log(`라이브 공개 기록이 이번 빌드와 같다 (${i}번째 확인)`); return true; }
      log(`라이브 공개 기록이 아직 이번 빌드와 다르다 (HTTP ${r.status}, ${i}/${config.live.waitAttempts})`);
    } catch (e) { log(`라이브 공개 기록 요청 실패 — ${e.message} (${i}/${config.live.waitAttempts})`); }
    if (i < config.live.waitAttempts) await sleep(Number(process.env.INDEXNOW_WAIT_MS) || config.live.waitIntervalMs);
  }
  log('라이브가 이번 빌드로 바뀐 것을 확인하지 못했다 — 보내지 않는다');
  return false;
}

/** 실행 환경 판단 — 대상 파일을 읽기 전에 한 줄로 남긴다(Cloudflare 빌드 로그에서 이 줄을 본다). */
function decideEnv() {
  const ci = process.env.WORKERS_CI; const br = process.env.WORKERS_CI_BRANCH;
  const env = `WORKERS_CI=${JSON.stringify(ci ?? '')} · WORKERS_CI_BRANCH=${JSON.stringify(br ?? '')} · --all ${ALL ? '있음' : '없음'}${DRY ? ' · --dry' : ''}`;
  let send; let why;
  if (DRY) { send = false; why = '--dry 라 보내지 않는다'; }
  else if (ALL) { send = true; why = '수동 --all 이라 보낸다(라이브 키 파일 확인 뒤)'; }
  else if (ci !== '1') { send = false; why = 'WORKERS_CI=1 이 아니다(로컬 빌드) — 보내지 않는다'; }
  else if (br !== config.productionBranch) { send = false; why = `WORKERS_CI_BRANCH ≠ ${config.productionBranch}(프로덕션) — 미리보기 배포라 보내지 않는다`; }
  else { send = true; why = `프로덕션 배포(WORKERS_CI=1 · ${config.productionBranch}) — 라이브 확인 뒤 보낸다`; }
  log(`실행 환경: ${env} → ${why}`);
  return send;
}

async function main() {
  const send = decideEnv();
  // 1) 대상
  let urls;
  if (ALL) {
    urls = [...new Set([...(await liveSitemapUrls()), ...RECORD_FILES.map((p) => toUrl(p))])]; // 보내는 주소는 항상 https://vanam.co.kr/… (사이트맵 <loc> 과 같은 호스트)
    log(`대상: 라이브 사이트맵 전체 + 파일 ${RECORD_FILES.length}개 = ${urls.length}개`);
  } else {
    if (!fs.existsSync(TARGETS)) { log(`대상 파일 ${TARGETS} 이 없다 — npm run build 가 만든다. 보내지 않는다`); return; }
    const t = JSON.parse(fs.readFileSync(TARGETS, 'utf8'));
    urls = Array.isArray(t.urls) ? t.urls : [];
    log(`대상 파일 ${TARGETS} (${t.mode}${t.generatedAt ? `, ${t.generatedAt}` : ''}): ${urls.length}개`);
    if (t.error) log(`  빌드 때 대상 계산 오류: ${t.error}`);
    for (const u of urls) console.log(`  ${u}${t.reasons?.[u] ? `  [${t.reasons[u]}]` : ''}`);
  }
  if (ALL) for (const u of urls) console.log(`  ${u}`);
  if (!send) { log('보내지 않는다 (위 실행 환경 판단대로)'); return; }
  if (!urls.length) { log('보낼 주소가 없다 — 바뀐 페이지가 없는 빌드. 보내지 않는다'); return; }

  // 3) 라이브 확인
  if (!(await keyFileOk())) return;
  if (!ALL && !(await liveIsThisBuild())) return;

  // 4) 전송
  const keyLocation = `https://${config.host}${keyPath()}`;
  log(`POST ${ENDPOINT} — host ${config.host} · keyLocation ${keyLocation} · ${urls.length}개(1회 최대 ${config.maxPerRequest}개)`);
  const results = await submitUrls(urls, { endpoint: ENDPOINT, keyLocation });
  for (const r of results) {
    if (r.ok) log(`✓ ${r.count}개 → HTTP ${r.status}${r.status === 202 ? ' (접수 — 키 확인 대기)' : ''}`);
    else log(`✗ ${r.count}개 → ${r.status ? `HTTP ${r.status}${r.body ? ` ${r.body.replace(/\s+/g, ' ')}` : ''}` : r.error} — 로그만 남긴다`);
  }
}

try { await main(); } catch (e) { log(`오류 — ${e.message} — 보내지 않는다(배포에는 영향 없음)`); }
process.exitCode = 0;
