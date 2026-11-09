// IndexNow 게이트 (GEO 정리 3차) — npm run verify 에 포함.
//
//   ① 키: 설정(scripts/indexnow.config.mjs)의 키가 영문 소문자·숫자 32자이고, dist/client/<키>.txt 가 있으며 내용이 키와 같다.
//      public/ 에 다른 32자 키 파일이 남아 있지 않다. robots.txt 가 /<키>.txt 를 막지 않는다(모든 크롤러 그룹).
//   ② 알림 대상 계산(computeTargets) 테스트 — 지난 기록 대비 제목만 바뀜(head) · 본문만 바뀜(main) · 새 주소 · 빠진 주소 · llms 파일 변경은 모두 잡히고,
//      안 바뀐 주소는 잡히지 않는다. head 지문 없는 옛 기록이면 전체가 대상. 기록을 못 받았어도 전체.
//   ③ 대상 목록 파일이 dist/client 안에 없다(공개되지 않는다) — 설정 경로도, 실제 파일도. 빌드가 남긴 대상 파일이 있고 형식이 맞다.
//   ④ WORKERS_CI 가 없을 때 indexnow-submit(인자 없음)은 아무것도 보내지 않는다 — 전송 주소를 막힌 주소로 바꾸고 실제로 실행해 확인.
//   ⑤ 이번 빌드의 공개 기록에 head 지문·llms 파일 항목이 들어 있다(형식은 check-sitemap-lastmod 가 본다).
//
// 사용: node scripts/check-indexnow.mjs [--dist <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, computeTargets, keyFileName, keyPath, KEY_RE, RECORD_FILES } from './lib/indexnow-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argDist = process.argv.indexOf('--dist');
const DIST = argDist >= 0 ? path.resolve(process.argv[argDist + 1]) : path.join(ROOT, 'dist/client');
let bad = 0;
const fail = (what, why) => { console.error(`  ✗ ${what} — ${why}`); bad++; };
const ok = (what) => console.log(`  ✓ ${what}`);

// ① 키
if (!KEY_RE.test(config.key)) fail('키 형식', `영문 소문자·숫자 32자여야 한다: ${JSON.stringify(config.key)}`);
const keyFile = path.join(DIST, keyFileName());
if (!fs.existsSync(keyFile)) fail(`dist/client/${keyFileName()}`, '키 파일이 빌드 결과에 없다 — public/<키>.txt 를 둔다');
else if (fs.readFileSync(keyFile, 'utf8').trim() !== config.key) fail(`dist/client/${keyFileName()}`, '내용이 설정의 키와 다르다');
else ok(`키 파일 ${keyPath()} 내용 일치`);
const strays = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => /^[a-z0-9]{32}\.txt$/.test(f) && f !== keyFileName());
if (strays.length) fail('public/ 옛 키 파일', `설정과 다른 키 파일이 남아 있다: ${strays.join(', ')}`);
{
  // robots.txt — scripts/check-robots.mjs 와 같은 규칙(가장 긴 일치 경로, 같으면 Allow 우선)으로 모든 그룹에 대해 확인
  const robotsFile = path.join(DIST, 'robots.txt');
  if (!fs.existsSync(robotsFile)) fail('robots.txt', '빌드 결과에 없다');
  else {
    const groups = []; let cur = null; let lastUA = false;
    for (const raw of fs.readFileSync(robotsFile, 'utf8').split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim(); if (!line) continue;
      const i = line.indexOf(':'); if (i < 0) continue;
      const key = line.slice(0, i).trim().toLowerCase(); const val = line.slice(i + 1).trim();
      if (key === 'user-agent') { if (!cur || !lastUA) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(val); lastUA = true; }
      else { lastUA = false; if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val }); }
    }
    const toRe = (p) => { const a = p.endsWith('$'); const b = (a ? p.slice(0, -1) : p).replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'); return new RegExp('^' + b + (a ? '$' : '')); };
    for (const g of groups) {
      let best = null;
      for (const r of g.rules) { if (r.path && toRe(r.path).test(keyPath())) { const len = r.path.length; if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow }; } }
      if (best && !best.allow) fail('robots.txt', `그룹(${g.agents.join(', ')})이 ${keyPath()} 를 막는다`);
    }
    if (!groups.length) fail('robots.txt', 'User-agent 그룹이 없다');
    else ok(`robots.txt 가 ${keyPath()} 를 막지 않는다 (그룹 ${groups.length}개)`);
  }
}

// ② 대상 계산 테스트
{
  const H = (s) => s.padEnd(64, '0');
  const page = (hash, head, date = '2026-01-01') => ({ hash: H(hash), date, head: H(head) });
  const prev = {
    '/same/': page('a', 'b'), '/title/': page('c', 'd'), '/body/': page('e', 'f'), '/gone/': page('g', 'h'), '/both/': page('i', 'j'),
    '/llms.txt': { hash: H('l1') }, '/llms-full.txt': { hash: H('l2') },
  };
  const cur = {
    '/same/': page('a', 'b', '2026-02-02'), // 날짜만 달라도 대상 아님
    '/title/': page('c', 'd2'), '/body/': page('e2', 'f'), '/new/': page('n', 'n2'), '/both/': page('i2', 'j2'),
    '/llms.txt': { hash: H('l1') }, '/llms-full.txt': { hash: H('l3') },
  };
  const t = computeTargets(prev, cur);
  const want = ['/body/', '/both/', '/gone/', '/llms-full.txt', '/new/', '/title/'];
  if (t.mode !== 'diff') fail('대상 계산', `mode 가 diff 여야 한다: ${t.mode}`);
  if (JSON.stringify(t.urls) !== JSON.stringify(want)) fail('대상 계산', `기대 ${JSON.stringify(want)} ≠ 결과 ${JSON.stringify(t.urls)}`);
  if (t.urls.includes('/same/') || t.urls.includes('/llms.txt')) fail('대상 계산', '안 바뀐 주소가 대상에 들어갔다');
  const r = t.reasons;
  if (!/head/.test(r['/title/'] ?? '')) fail('대상 계산', `/title/ 이유가 head 여야 한다: ${r['/title/']}`);
  if (!/main/.test(r['/body/'] ?? '')) fail('대상 계산', `/body/ 이유가 본문이어야 한다: ${r['/body/']}`);
  if (!/main/.test(r['/both/'] ?? '')) fail('대상 계산', `/both/ 는 본문 바뀜으로 잡혀야 한다: ${r['/both/']}`);
  if (!/새 주소/.test(r['/new/'] ?? '')) fail('대상 계산', `/new/ 이유: ${r['/new/']}`);
  if (!/빠짐/.test(r['/gone/'] ?? '')) fail('대상 계산', `/gone/ 이유: ${r['/gone/']}`);
  if (!/파일 내용/.test(r['/llms-full.txt'] ?? '')) fail('대상 계산', `/llms-full.txt 이유: ${r['/llms-full.txt']}`);
  // 옛 형식(head 없음) → 전체
  const old = Object.fromEntries(Object.entries(prev).filter(([k]) => !RECORD_FILES.includes(k)).map(([k, v]) => [k, { hash: v.hash, date: v.date }]));
  const t2 = computeTargets(old, cur);
  const allCur = Object.keys(cur).sort();
  if (t2.mode !== 'all' || JSON.stringify(t2.urls) !== JSON.stringify(allCur)) fail('대상 계산(옛 기록)', `head 없는 옛 기록이면 전체(${allCur.length}개)가 대상이어야 한다: ${t2.mode} ${t2.urls.length}개`);
  if (t2.urls.includes('/gone/')) fail('대상 계산(옛 기록)', '전체 모드에는 이번 빌드의 주소만 들어간다');
  // 기록 못 받음 → 전체
  const t3 = computeTargets(null, cur);
  if (t3.mode !== 'all' || t3.urls.length !== allCur.length) fail('대상 계산(기록 없음)', `전체가 대상이어야 한다: ${t3.mode} ${t3.urls.length}개`);
  // 바뀐 것 없음 → 빈 목록
  const t4 = computeTargets(prev, prev);
  if (t4.mode !== 'diff' || t4.urls.length) fail('대상 계산(변화 없음)', `빈 목록이어야 한다: ${JSON.stringify(t4.urls)}`);
  if (!bad) ok('대상 계산 — 제목만·본문만·새 주소·빠진 주소·파일 변경 잡힘, 안 바뀐 주소 제외, 옛 기록·기록 없음은 전체, 변화 없음은 0');
}

// ③ 대상 파일 위치·형식
{
  const targets = path.resolve(ROOT, config.targetsFile);
  const rel = path.relative(DIST, targets);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) fail('대상 파일 설정', `${config.targetsFile} 이 dist/client 안이다 — 공개되면 안 된다`);
  const leaked = path.join(DIST, path.basename(config.targetsFile));
  if (fs.existsSync(leaked)) fail('대상 파일', `${leaked} 가 빌드 결과(공개 위치)에 있다`);
  if (!fs.existsSync(targets)) fail('대상 파일', `${targets} 이 없다 — npm run build(scripts/indexnow-targets.mjs)가 만든다`);
  else {
    let t = null;
    try { t = JSON.parse(fs.readFileSync(targets, 'utf8')); } catch (e) { fail('대상 파일', `JSON 이 아니다: ${e.message}`); }
    if (t) {
      if (!['all', 'diff', 'error'].includes(t.mode)) fail('대상 파일', `mode 가 all·diff·error 중 하나여야 한다: ${t.mode}`);
      if (!Array.isArray(t.urls)) fail('대상 파일', 'urls 배열이 없다');
      else {
        const badUrl = t.urls.filter((u) => !u.startsWith(`https://${config.host}/`));
        if (badUrl.length) fail('대상 파일', `호스트가 다른 주소 ${badUrl.length}개: ${badUrl.slice(0, 3).join(', ')}`);
        if (t.mode === 'error') console.warn(`  ⚠ 빌드 때 대상 계산이 실패했다(${t.error}) — 배포 뒤 전송할 목록이 비어 있다`);
        else ok(`대상 파일 ${path.relative(ROOT, targets)} — ${t.mode} ${t.urls.length}개 (dist/client 밖)`);
      }
    }
  }
}

// ④ WORKERS_CI 없이 실행 → 보내지 않음
{
  const env = { ...process.env, INDEXNOW_ENDPOINT: 'http://127.0.0.1:9/indexnow', INDEXNOW_LIVE_BASE: 'http://127.0.0.1:9' };
  delete env.WORKERS_CI; delete env.WORKERS_CI_BRANCH;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/indexnow-submit.mjs'), '--dist', DIST], { env, encoding: 'utf8', cwd: ROOT, timeout: 60000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  if (r.status !== 0) fail('indexnow-submit(WORKERS_CI 없음)', `종료 코드 ${r.status} — 항상 0 이어야 한다`);
  if (/POST /.test(out) || /키 파일 확인/.test(out)) fail('indexnow-submit(WORKERS_CI 없음)', '라이브 확인·전송 단계로 넘어갔다 — 로컬 빌드에서는 보내면 안 된다');
  if (!/보내지 않는다/.test(out)) fail('indexnow-submit(WORKERS_CI 없음)', `"보내지 않는다" 로그가 없다:\n${out}`);
  else ok('indexnow-submit — WORKERS_CI 없으면 보내지 않음(종료 코드 0)');
}

// ⑤ 공개 기록에 head·파일 항목
{
  const pubFile = path.join(DIST, 'sitemap-lastmod.json');
  if (!fs.existsSync(pubFile)) fail('공개 기록', `${pubFile} 이 없다`);
  else {
    const pub = JSON.parse(fs.readFileSync(pubFile, 'utf8'));
    const pages = Object.entries(pub).filter(([k]) => !RECORD_FILES.includes(k));
    const noHead = pages.filter(([, v]) => !/^[0-9a-f]{64}$/.test(v.head ?? ''));
    if (noHead.length) fail('공개 기록 head', `head 지문이 없는 페이지 ${noHead.length}개: ${noHead.slice(0, 5).map(([k]) => k).join(', ')}`);
    const noFile = RECORD_FILES.filter((k) => !pub[k]);
    if (noFile.length) fail('공개 기록 파일 항목', `없는 항목: ${noFile.join(', ')}`);
    if (!noHead.length && !noFile.length) ok(`공개 기록 — 페이지 ${pages.length}개 head 지문 · 파일 항목 ${RECORD_FILES.length}개`);
  }
}

if (bad) { console.error(`\n✗ check-indexnow 실패 — ${bad}건`); process.exit(1); }
console.log('check-indexnow OK');
