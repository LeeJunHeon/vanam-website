// scripts/test-chat-guard.mjs — 구글챗 알림 게이트의 판정 로직 단위 테스트
//
// 게이트가 "통과"만 하고 실제로는 아무것도 못 잡으면 의미가 없다.
// 진리표와 임시 폴더로 (a)(b)(c) 가 각각 걸리는지 확인한다.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chatModeAtBuild } from '../src/lib/chat-mode.js';
import { checkSource, scanDist, judgeDist } from './check-chat-guard.mjs';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}
// 표식 문자열을 소스에 그대로 적지 않는다(게이트 규칙과 같은 이유).
const ON = ['CHAT', 'MODE', 'ON'].join('_');
const OFF = ['CHAT', 'MODE', 'OFF'].join('_');
const HOST = ['chat', 'googleapis', 'com'].join('.');

// ── chatModeAtBuild 진리표 ──────────────────────────────────────────────
eq('Cloudflare main', chatModeAtBuild({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' }), ON);
eq('Cloudflare 다른 브랜치', chatModeAtBuild({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'quote-engine' }), OFF);
// Cloudflare 빌드인데 브랜치 정보가 없으면 판정하지 않고 빌드를 멈춘다(조용히 꺼진 채 배포 방지)
const throws = (env) => { try { chatModeAtBuild(env); return '예외 없음'; } catch (e) { return e.message; } };
const NO_BRANCH = 'Cloudflare 빌드인데 브랜치 정보가 없습니다 — 구글챗 알림 판정 불가';
eq('Cloudflare 브랜치 없음 → 예외', throws({ WORKERS_CI: '1' }), NO_BRANCH);
eq('Cloudflare 브랜치 빈 문자열 → 예외', throws({ WORKERS_CI: '1', WORKERS_CI_BRANCH: '' }), NO_BRANCH);
eq('Cloudflare 브랜치 공백 → 예외', throws({ WORKERS_CI: '1', WORKERS_CI_BRANCH: '  ' }), NO_BRANCH);
eq('CI 없음 + main', chatModeAtBuild({ WORKERS_CI_BRANCH: 'main' }), OFF);
eq('CI 없음(로컬)', chatModeAtBuild({}), OFF);
eq('WORKERS_CI=true (1 이 아님)', chatModeAtBuild({ WORKERS_CI: 'true', WORKERS_CI_BRANCH: 'main' }), OFF);
eq('브랜치 Main (대소문자 다름)', chatModeAtBuild({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'Main' }), OFF);
eq('env 없음', chatModeAtBuild(undefined), OFF);

// ── 임시 폴더로 (b)(c) 판정 ─────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'chat-guard-'));
const LOCAL = {};
const MAIN = { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' };
/** dist/server 모양의 폴더를 만든다. @param {Record<string,string>} files */
function dist(name, files) {
  const d = join(root, name);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  return d;
}
const judge = (d, env) => judgeDist(scanDist(d), env).length;

try {
  const off = dist('off', { 'chunks/chat.mjs': `const CHAT_ENABLED = "${OFF}".endsWith("_ON");` });
  const on = dist('on', { 'chunks/chat.mjs': `const CHAT_ENABLED = "${ON}".endsWith("_ON");` });
  eq('꺼짐 번들 + 로컬 → 통과', judge(off, LOCAL), 0);
  eq('켜짐 번들 + 로컬 → 실패', judge(on, LOCAL), 1);
  eq('켜짐 번들 + Cloudflare main → 통과', judge(on, MAIN), 0);
  eq('꺼짐 번들 + Cloudflare main → 실패(알림 꺼진 채 배포 방지)', judge(off, MAIN), 1);
  eq('표식 0개 → 실패', judge(dist('none', { 'a.mjs': 'x' }), LOCAL), 1);
  eq('표식 2개 → 실패', judge(dist('two', { 'a.mjs': `"${OFF}"`, 'b.mjs': `"${OFF}"` }), LOCAL), 1);
  eq('웹훅 주소가 번들에 → 실패', judge(dist('hook', {
    'chunks/chat.mjs': `"${OFF}"`, 'chunks/order.mjs': `fetch("https://${HOST}/hook")`,
  }), LOCAL), 1);
  // .dev.vars 는 어댑터가 로컬 .env 를 복사한 wrangler dev 전용 파일 — 배포되지 않는 비밀값이라 판정 밖
  eq('.dev.vars 의 웹훅·표식은 판정 밖', judge(dist('devvars', {
    'chunks/chat.mjs': `"${OFF}"`, '.dev.vars': `GOOGLE_CHAT_WEBHOOK="https://${HOST}/x"\nX="${ON}"`,
  }), LOCAL), 0);
  // 실패 문구에 기대값·실제값·환경을 적는다
  const msg = judgeDist(scanDist(on), LOCAL)[0] ?? '';
  eq('실패 문구에 기대·실제·환경', [OFF, ON, 'WORKERS_CI=', 'WORKERS_CI_BRANCH='].every((s) => msg.includes(s)), true);

  // ── (a) 소스 판정 ─────────────────────────────────────────────────────
  const src = (name, files) => dist(name, files);
  eq('정상 소스', checkSource(src('src-ok', {
    'lib/chat-send.ts': 'env.GOOGLE_CHAT_WEBHOOK', 'lib/chat-mode.js': `'${ON}'`, 'pages/api/inquiry.ts': 'sendChat()',
  })).length, 0);
  eq('다른 파일이 웹훅 키를 읽음', checkSource(src('src-key', {
    'lib/chat-send.ts': 'x', 'pages/api/order.ts': 'import.meta.env.GOOGLE_CHAT_WEBHOOK',
  })).length, 1);
  eq('소스에 웹훅 주소', checkSource(src('src-host', { 'lib/a.ts': `"https://${HOST}/"` })).length, 1);
  eq('런타임 파일에 켜짐 표식', checkSource(src('src-on', { 'lib/chat-send.ts': `=== '${ON}'` })).length, 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n구글챗 게이트 단위 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 구글챗 게이트 단위 테스트 — ${total}건 통과`);
