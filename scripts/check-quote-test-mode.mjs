// scripts/check-quote-test-mode.mjs — 견적 테스트 모드 빌드 게이트
//
// 고객 견적 폼의 "예상 견적 보기"(원가·계산 내역이 그대로 보이는 내부 검증 UI)는
// npm run local 빌드에서만 켜진다(src/lib/quote-test-mode.js). 이 게이트는 그 약속을 확인한다:
//   (a) 소스: 켜짐 표식 문자열은 quote-test-mode.js 에만
//   (b) 번들: dist/server 의 표식이 1개 이상이고 전부 이 환경의 기대값과 같다
//   (c) 꺼짐 빌드: dist/client 에 켜짐 표식·테스트 UI 흔적이 0건 (공개 결과물에 새지 않음)
//       켜짐 빌드: dist/client 에 테스트 UI 가 실제로 들어갔는지(1건 이상)
// .dev.vars 는 보지 않는다(로컬 비밀값 파일 — check-chat-guard 와 같은 이유).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { quoteTestModeAtBuild } from '../src/lib/quote-test-mode.js';

// 표식 문자열을 그대로 적지 않는다(게이트 (a) 와 같은 이유).
const ON = ['QUOTE', 'TEST', 'ON'].join('_');
const MARKER_RE = /QUOTE_TEST_(?:ON|OFF)/g;
/** 테스트 UI 흔적 — src/components/QuoteEstimateTest.astro 의 id·문구·API 경로와 같게 유지한다. */
export const TRACES = ['qet-panel', 'qet-run', '/api/quote-estimate', '예상 견적 보기', '운영 빌드에는 포함되지 않음'];
const DEV_VARS = '.dev.vars';

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const isDevVars = (f) => f.endsWith(sep + DEV_VARS) || f === DEV_VARS;

/** (a) @param {string} srcDir @returns {string[]} */
export function checkSource(srcDir) {
  const errs = [];
  for (const f of walk(srcDir)) {
    const rel = relative(srcDir, f).split(sep).join('/');
    if (readFileSync(f, 'utf8').includes(ON) && rel !== 'lib/quote-test-mode.js') {
      errs.push(`src/${rel}: 견적 테스트 켜짐 표식(${ON})은 src/lib/quote-test-mode.js 에만 — 런타임 비교는 endsWith 로`);
    }
  }
  return errs;
}

/** dist 폴더 훑기. @param {string} dir */
export function scanMarkers(dir) {
  const markers = [];
  for (const f of walk(dir)) {
    if (isDevVars(f)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(MARKER_RE)) markers.push({ file: relative(dir, f), value: m[0] });
  }
  return markers;
}
/** @param {string} dir @returns {{file: string, trace: string}[]} */
export function scanTraces(dir) {
  const hits = [];
  for (const f of walk(dir)) {
    if (isDevVars(f)) continue;
    const text = readFileSync(f, 'utf8');
    for (const t of TRACES) if (text.includes(t)) hits.push({ file: relative(dir, f), trace: t });
  }
  return hits;
}

/**
 * (b)(c) 판정.
 * @param {{server: string, client: string}} dist
 * @param {Record<string, string|undefined>} env
 * @returns {{errs: string[], mode: string, markers: number, traces: number}}
 */
export function judgeDist(dist, env) {
  const errs = [];
  const expected = quoteTestModeAtBuild(env);
  const ctx = `기대값 ${expected} · VANAM_QUOTE_TEST=${env.VANAM_QUOTE_TEST ?? '(없음)'} · WORKERS_CI=${env.WORKERS_CI ?? '(없음)'}`;
  const markers = scanMarkers(dist.server);
  if (markers.length === 0) errs.push(`dist/server 에 견적 테스트 표식이 없다 — ${ctx}`);
  for (const m of markers) if (m.value !== expected) errs.push(`dist/server/${m.file}: 표식 ${m.value} — ${ctx}`);

  const clientOn = scanMarkers(dist.client).filter((m) => m.value === ON);
  const traces = scanTraces(dist.client);
  if (expected !== ON) {
    for (const m of clientOn) errs.push(`dist/client/${m.file}: 꺼짐 빌드인데 켜짐 표식이 있다`);
    for (const t of traces) errs.push(`dist/client/${t.file}: 꺼짐 빌드인데 테스트 UI 흔적 "${t.trace}"`);
  } else if (traces.length === 0) {
    errs.push(`켜짐 빌드인데 dist/client 에 테스트 UI 가 없다 — ${ctx}`);
  }
  return { errs, mode: expected, markers: markers.length, traces: traces.length };
}

// ── 실행 ────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errs = checkSource('src');
  let res = null;
  if (!existsSync('dist/server') || !existsSync('dist/client')) errs.push('dist 가 없다 — npm run build 뒤에 실행하세요');
  else {
    res = judgeDist({ server: 'dist/server', client: 'dist/client' }, process.env);
    errs.push(...res.errs);
  }
  if (errs.length) {
    for (const e of errs) console.error('  ✗', e);
    console.error(`\n견적 테스트 모드 게이트 실패 — ${errs.length}건.`);
    process.exit(1);
  }
  console.log(res.mode === ON
    ? `✓ 견적 테스트 모드 게이트 — 켜짐(${res.mode}) · 번들 표식 ${res.markers}개 · 테스트 UI ${res.traces}건`
    : `✓ 견적 테스트 모드 게이트 — 꺼짐(${res.mode}) · 번들 표식 ${res.markers}개 · 공개 결과물의 테스트 UI 흔적 0건`);
}
