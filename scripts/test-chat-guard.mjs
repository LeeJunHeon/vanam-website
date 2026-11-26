// scripts/test-chat-guard.mjs — 구글챗 알림 게이트의 판정 로직 단위 테스트
//
// 게이트가 "통과"만 하고 실제로는 아무것도 못 잡으면 의미가 없다.
// 진리표와 임시 폴더로 (a)(b)(c) 가 각각 걸리는지 확인한다.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chatModeAtBuild } from '../src/lib/chat-mode.js';
import { checkSource, scanDist, judgeDist, ALERT_KEY } from './check-chat-guard.mjs';
import { chatChannelOf, chatTargets, chatShouldFallback, chatDeliver } from '../src/lib/chat-channel.js';
import { readFileSync } from 'node:fs';

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
  // 오류 알림 채팅방 웹훅 이름(11-26)도 chat-send.ts 에서만
  eq('오류 알림 웹훅 이름: chat-send.ts 에서 읽음 → 통과', checkSource(src('src-alert-ok', {
    'lib/chat-send.ts': `env.GOOGLE_CHAT_WEBHOOK; env.${ALERT_KEY}`, 'lib/chat-channel.js': 'export const x = 1', 'lib/quote-ack-run.ts': "sendChat(t, { channel: 'alert' })",
  })).length, 0);
  eq('오류 알림 웹훅 이름: 다른 파일이 읽음 → 실패(규칙 2개에 걸림)', checkSource(src('src-alert-key', {
    'lib/chat-send.ts': 'x', 'lib/staff-notify-run.ts': `cfEnv.${ALERT_KEY}`,
  })).length, 2);
  eq('오류 알림 웹훅 이름: 관리자 화면에 이름이 있어도 실패', checkSource(src('src-alert-admin', {
    'lib/chat-send.ts': 'x', 'pages/admin/index.astro': `<p>${ALERT_KEY} 미설정</p>`,
  })).length, 2);
  eq('채널 판정 파일이 런타임 env 를 읽음 → 실패', checkSource(src('src-channel-env', {
    'lib/chat-send.ts': 'x', 'lib/chat-channel.js': `import { env } from '${['cloudflare', 'workers'].join(':')}'`,
  })).length, 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── 채널 선택·대체 판정(chat-channel.js — 순수 함수). 웹훅 값은 가짜 글자 ─────────────
const guardTests = total;
const M = 'hook-main', A = 'hook-alert';
eq('채널 이름 정리', [chatChannelOf('alert'), chatChannelOf('main'), chatChannelOf(undefined), chatChannelOf('ALERT'), chatChannelOf(1)], ['alert', 'main', 'main', 'main', 'main']);
eq('main 채널 → 기존 방만(오류 방 설정이 있어도)', chatTargets('main', { main: M, alert: A }), [{ channel: 'main', url: M }]);
eq('채널 생략 → main', chatTargets(undefined, { main: M, alert: A }), [{ channel: 'main', url: M }]);
eq('alert 설정 있음 → 오류 방 먼저, 기존 방이 대체', chatTargets('alert', { main: M, alert: A }), [{ channel: 'alert', url: A }, { channel: 'main', url: M }]);
eq('alert 설정 없음 → 기존 방으로', chatTargets('alert', { main: M, alert: '' }), [{ channel: 'main', url: M }]);
eq('alert 설정만 있음(기존 방 없음) → 오류 방만', chatTargets('alert', { main: '', alert: A }), [{ channel: 'alert', url: A }]);
eq('둘 다 없음 → 빈 목록(웹훅 미설정)', [chatTargets('alert', { main: '', alert: '' }), chatTargets('main', {}), chatTargets('alert', undefined)], [[], [], []]);
eq('두 값이 같으면 한 번만', chatTargets('alert', { main: M, alert: M }), [{ channel: 'alert', url: M }]);
eq('main 채널은 오류 방으로 대체하지 않는다', chatTargets('main', { main: '', alert: A }), []);
eq('대체 판정 — 전송 실패만', [{ sent: false, reason: 'http_error' }, { sent: false, reason: 'fetch_error' }, { sent: true, reason: 'ok' },
  { sent: false, reason: 'no_webhook' }, { sent: false, reason: 'blocked_build' }, null].map(chatShouldFallback), [true, true, false, false, false, false]);
async function deliver(channel, urls, results) {
  const posted = [];
  const r = await chatDeliver(chatTargets(channel, urls), async (t) => { posted.push(t.channel); return results[t.channel]; });
  return { r, posted };
}
const OK = { sent: true, reason: 'ok', status: 200 };
{
  const { r, posted } = await deliver('alert', { main: M, alert: A }, { alert: OK, main: OK });
  eq('alert 성공 → 오류 방 한 번만', [posted, r], [['alert'], { ...OK, channel: 'alert', fallback: false }]);
}
for (const bad of [{ sent: false, reason: 'http_error', status: 500 }, { sent: false, reason: 'fetch_error' }]) {
  const { r, posted } = await deliver('alert', { main: M, alert: A }, { alert: bad, main: OK });
  eq(`alert 실패(${bad.reason}) → 기존 방으로 한 번 더`, [posted, r], [['alert', 'main'], { ...OK, channel: 'main', fallback: true }]);
}
{
  const bad = { sent: false, reason: 'http_error', status: 404 };
  const { r, posted } = await deliver('alert', { main: M, alert: A }, { alert: bad, main: { sent: false, reason: 'fetch_error' } });
  eq('alert·기존 방 모두 실패 → 마지막(기존 방) 결과 · 두 번만 시도', [posted, r], [['alert', 'main'], { sent: false, reason: 'fetch_error', channel: 'main', fallback: true }]);
}
{
  const { r, posted } = await deliver('alert', { main: M, alert: '' }, { main: OK });
  eq('alert 설정 없음 → 기존 방 한 번(대체 아님)', [posted, r], [['main'], { ...OK, channel: 'main', fallback: false }]);
}
{
  const { r, posted } = await deliver('main', { main: M, alert: A }, { main: { sent: false, reason: 'http_error', status: 500 }, alert: OK });
  eq('main 실패 → 오류 방으로 보내지 않는다', [posted, r?.sent, r?.channel], [['main'], false, 'main']);
}
eq('보낼 곳 없음 → null', (await deliver('alert', {}, {})).r, null);
// 원문 검사 — 'alert' 채널로 보내는 곳은 메일 오류 알림 셋뿐 · 통로는 값·본문·응답을 로그에 남기지 않는다
const read = (p) => readFileSync(p, 'utf8');
const alertCalls = (p) => (read(p).match(/channel:\s*'alert'/g) ?? []).length;
eq("'alert' 채널 호출 — 담당자 메일 실패 1 · 확인 메일 실패+하루 상한 2", [alertCalls('src/lib/staff-notify-run.ts'), alertCalls('src/lib/quote-ack-run.ts')], [1, 2]);
eq('그 밖의 알림은 main 그대로', ['src/pages/api/inquiry.ts', 'src/pages/api/order.ts', 'src/lib/paypal.ts'].map(alertCalls), [0, 0, 0]);
const sendSrc = read('src/lib/chat-send.ts');
eq('통로: 빌드 차단이 채널 선택보다 먼저', sendSrc.indexOf('if (!CHAT_ENABLED)') > 0 && sendSrc.indexOf('if (!CHAT_ENABLED)') < sendSrc.indexOf('chatTargets(channel'), true);
eq('통로: 응답 본문·오류 객체·웹훅 값을 로그에 넘기지 않는다', [/res\.text\(/.test(sendSrc), /console\.\w+\([^)]*\b(?:err|url|text)\b[^)]*\)/.test(sendSrc)], [false, false]);
eq('통로: 설정 여부만 내보낸다(boolean)', /export function alertChannelConfigured\(\): boolean/.test(sendSrc), true);
eq('통로: fetch 는 한 곳', (sendSrc.match(/\bfetch\s*\(/g) ?? []).length, 1);
const channelTests = total - guardTests;

if (failed) {
  console.error(`\n구글챗 게이트 단위 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 구글챗 게이트 단위 테스트 — ${total}건 통과 · 채널 선택·대체(alert 있음/없음/실패 시 main) ${channelTests}건`);
