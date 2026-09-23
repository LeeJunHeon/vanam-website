// scripts/test-quote-test-mode.mjs — 견적 테스트 모드 판정·게이트 단위 테스트
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { quoteTestModeAtBuild } from '../src/lib/quote-test-mode.js';
import { checkSource, judgeDist, TRACES } from './check-quote-test-mode.mjs';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}
const ON = ['QUOTE', 'TEST', 'ON'].join('_');
const OFF = ['QUOTE', 'TEST', 'OFF'].join('_');
const throws = (env) => { try { return quoteTestModeAtBuild(env); } catch (e) { return `예외: ${e.message}`; } };
const CF_ERR = '예외: Cloudflare 빌드에서는 견적 테스트 모드를 켤 수 없습니다';

// ── 진리표 ──────────────────────────────────────────────────────────────
eq('로컬 + VANAM_QUOTE_TEST=1', throws({ VANAM_QUOTE_TEST: '1' }), ON);
eq('로컬 + 없음', throws({}), OFF);
eq('로컬 + VANAM_QUOTE_TEST=true (1 아님)', throws({ VANAM_QUOTE_TEST: 'true' }), OFF);
eq('로컬 + VANAM_QUOTE_TEST=0', throws({ VANAM_QUOTE_TEST: '0' }), OFF);
eq('Cloudflare main', throws({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' }), OFF);
eq('Cloudflare 다른 브랜치', throws({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'x' }), OFF);
eq('Cloudflare + VANAM_QUOTE_TEST=1 → 예외', throws({ WORKERS_CI: '1', VANAM_QUOTE_TEST: '1' }), CF_ERR);
eq('Cloudflare + VANAM_QUOTE_TEST=0 → 예외(설정 자체 금지)', throws({ WORKERS_CI: '1', VANAM_QUOTE_TEST: '0' }), CF_ERR);
eq('Cloudflare + VANAM_QUOTE_TEST 빈 값 → 예외', throws({ WORKERS_CI: '1', VANAM_QUOTE_TEST: '' }), CF_ERR);
eq('env 없음', throws(undefined), OFF);

// ── 임시 폴더로 dist 판정 ────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'quote-test-guard-'));
function mk(name, files) {
  const d = join(root, name);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  return d;
}
const dist = (name, server, client) => ({ server: mk(`${name}/server`, server), client: mk(`${name}/client`, client) });
const n = (d, env) => judgeDist(d, env).errs.length;
const LOCAL = {}, TEST = { VANAM_QUOTE_TEST: '1' };
const cleanClient = { 'ko/product/x/index.html': '<form id="quote-form"></form>' };
const testClient = { 'ko/product/x/index.html': `<div id="${TRACES[0]}"></div><button id="${TRACES[1]}"></button>` };

try {
  eq('꺼짐 번들 + 깨끗한 client + 로컬 → 통과', n(dist('a', { 'c.mjs': `"${OFF}".endsWith("_ON")` }, cleanClient), LOCAL), 0);
  eq('표식 여러 개도 전부 같으면 통과', n(dist('b', { 'c.mjs': `"${OFF}"`, 'd.mjs': `"${OFF}"` }, cleanClient), LOCAL), 0);
  eq('표식 없음 → 실패', n(dist('c', { 'c.mjs': 'x' }, cleanClient), LOCAL), 1);
  eq('켜짐 번들인데 기대 꺼짐 → 실패', n(dist('d', { 'c.mjs': `"${ON}"` }, cleanClient), LOCAL), 1);
  eq('표식 섞임 → 실패', n(dist('e', { 'c.mjs': `"${OFF}"`, 'd.mjs': `"${ON}"` }, cleanClient), LOCAL), 1);
  eq('꺼짐인데 client 에 테스트 UI 흔적 → 실패', n(dist('f', { 'c.mjs': `"${OFF}"` }, testClient), LOCAL) > 0, true);
  eq('꺼짐인데 client 에 켜짐 표식 → 실패', n(dist('g', { 'c.mjs': `"${OFF}"` }, { 'a.js': `"${ON}"` }), LOCAL), 1);
  eq('켜짐 기대 + 켜짐 번들 + 테스트 UI → 통과', n(dist('h', { 'c.mjs': `"${ON}"` }, testClient), TEST), 0);
  eq('켜짐 기대인데 테스트 UI 없음 → 실패', n(dist('i', { 'c.mjs': `"${ON}"` }, cleanClient), TEST), 1);
  eq('.dev.vars 는 판정 밖', n(dist('j', { 'c.mjs': `"${OFF}"`, '.dev.vars': `X="${ON}"` }, cleanClient), LOCAL), 0);

  eq('소스: quote-test-mode.js 에만 → 통과', checkSource(mk('src-ok', { 'lib/quote-test-mode.js': `'${ON}'`, 'lib/x.ts': 'endsWith("_ON")' })).length, 0);
  eq('소스: 런타임 파일에 켜짐 표식 → 실패', checkSource(mk('src-bad', { 'pages/api/x.ts': `=== '${ON}'` })).length, 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n견적 테스트 모드 게이트 단위 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 견적 테스트 모드 게이트 단위 테스트 — ${total}건 통과`);
