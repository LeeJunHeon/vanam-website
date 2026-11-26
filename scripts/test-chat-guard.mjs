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
import { chatTestMessage, chatTestOutcome, chatTestLabel, chatTestResponseLabel, CHAT_TEST_TAG } from '../src/lib/chat-test.js';

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

// ── 오류 알림 테스트 보내기(chat-test.js) — sendChat 결과 → 결과 구분 → 화면 문구 ─────────
const beforeChatTest = total;
eq('시험 메시지 본문', chatTestMessage('2099-12-31 16:15'), '🔔 오류 알림 테스트 — 관리자 화면에서 보낸 시험 메시지입니다. (2099-12-31 16:15 · 한국 시간)');
eq('시험 메시지: 시각 없으면 괄호 없음', chatTestMessage(''), '🔔 오류 알림 테스트 — 관리자 화면에서 보낸 시험 메시지입니다.');
const viaSend = (r) => chatTestOutcome(r);
eq('결과 구분: 별도 채팅방으로 보냄', viaSend({ sent: true, reason: 'ok', status: 200, channel: 'alert', fallback: false }), { ok: true, code: 'alert', reason: null, status: 200 });
eq('결과 구분: 별도 설정 없어 기존 채팅방', viaSend({ sent: true, reason: 'ok', status: 200, channel: 'main', fallback: false }), { ok: true, code: 'main_unset', reason: null, status: 200 });
eq('결과 구분: 별도 채팅방 실패 → 기존 채팅방', viaSend({ sent: true, reason: 'ok', status: 200, channel: 'main', fallback: true }), { ok: true, code: 'main_fallback', reason: null, status: 200 });
eq('결과 구분: 실패(거절)', viaSend({ sent: false, reason: 'http_error', status: 404, channel: 'main', fallback: true }), { ok: false, code: 'failed', reason: 'http_error', status: 404 });
eq('결과 구분: 실패(연결)', viaSend({ sent: false, reason: 'fetch_error', channel: 'main', fallback: false }), { ok: false, code: 'failed', reason: 'fetch_error', status: null });
eq('결과 구분: 웹훅 미설정', viaSend({ sent: false, reason: 'no_webhook' }), { ok: false, code: 'failed', reason: 'no_webhook', status: null });
eq('결과 구분: 테스트 빌드', viaSend({ sent: false, reason: 'blocked_build' }), { ok: false, code: 'blocked_build', reason: null, status: null });
eq('결과 구분: 이상한 값 → 실패(error)', [viaSend(null), viaSend({})].map((o) => `${o.ok}:${o.code}:${o.reason}`), ['false:failed:error', 'false:failed:error']);
// chatDeliver 가 실제로 내는 결과를 그대로 넣어도 같은 구분이 나온다(통로 → 구분이 이어지는지)
{
  const bad = { sent: false, reason: 'http_error', status: 500 };
  const a = (await deliver('alert', { main: M, alert: A }, { alert: OK, main: OK })).r;
  const b = (await deliver('alert', { main: M, alert: '' }, { main: OK })).r;
  const c = (await deliver('alert', { main: M, alert: A }, { alert: bad, main: OK })).r;
  const d = (await deliver('alert', { main: M, alert: A }, { alert: bad, main: bad })).r;
  eq('통로 결과 → 구분(4가지)', [a, b, c, d].map((r) => chatTestOutcome(r).code), ['alert', 'main_unset', 'main_fallback', 'failed']);
}
eq('화면 문구: 5가지 구분', ['alert', 'main_unset', 'main_fallback', 'blocked_build'].map((code) => chatTestLabel({ code })), [
  { tone: 'ok', text: '별도 채팅방으로 보냈습니다.' },
  { tone: 'warn', text: '별도 설정이 없어 기존 채팅방으로 보냈습니다.' },
  { tone: 'warn', text: '별도 채팅방 전송이 실패해 기존 채팅방으로 보냈습니다.' },
  { tone: 'warn', text: '테스트 빌드라 보내지 않았습니다.' },
]);
eq('화면 문구: 실패 사유', [
  chatTestLabel({ code: 'failed', reason: 'http_error', status: 404 }), chatTestLabel({ code: 'failed', reason: 'fetch_error', status: null }),
  chatTestLabel({ code: 'failed', reason: 'no_webhook' }), chatTestLabel({ code: 'failed', reason: 'weird' }), chatTestLabel(null),
].map((l) => `${l.tone}|${l.text}`), [
  'bad|실패 — 구글챗이 요청을 거절했습니다 (HTTP 404)', 'bad|실패 — 구글챗 연결 오류', 'bad|실패 — 구글챗 웹훅이 설정돼 있지 않습니다', 'bad|실패 — weird', 'bad|실패 — 처리 중 오류',
]);
eq('응답 → 화면: 결과가 있으면 그 문구', chatTestResponseLabel(200, { ok: true, result: { code: 'alert' } }).text, '별도 채팅방으로 보냈습니다.');
eq('응답 → 화면: 로그인 만료 · 횟수 제한 · 그 밖', [
  chatTestResponseLabel(401, { ok: false, error: 'unauthorized' }).text, chatTestResponseLabel(429, { ok: false, error: 'rate_limited', retryAfterSec: 41.2 }).text,
  chatTestResponseLabel(429, {}).text, chatTestResponseLabel(500, {}).text, chatTestResponseLabel(503, { error: 'no_db' }).text,
], ['로그인이 만료되었습니다. 새로고침한 뒤 다시 로그인하세요.', '너무 자주 눌렀습니다 — 42초 뒤 다시 시도하세요.', '너무 자주 눌렀습니다 — 잠시 뒤 다시 시도하세요.', '실패 — 500', '실패 — no_db']);
// 원문 검사 — API 는 관리자 확인 뒤 alert 채널로 한 번 · 횟수 제한 버킷은 RATE_RULES 의 키와 글자 그대로 · 웹훅을 읽지 않는다
const testApi = read('src/pages/api/admin/chat-test.ts');
const rules = read('src/lib/rate-limit.ts');
const bucket = testApi.match(/rateLimit\([^,]+,\s*'([A-Za-z]+)'/)?.[1] ?? '';
eq('API: 버킷 이름이 RATE_RULES 의 키와 같다(1분 3회)', [bucket, new RegExp(`\\n  ${bucket}: \\{ limit: 3, windowSec: 60 \\},`).test(rules)], ['chatTest', true]);
eq('API: 관리자 확인이 먼저 · alert 채널 한 번 · 직접 전송 없음', [
  testApi.indexOf('isAdmin(request)') > 0 && testApi.indexOf('isAdmin(request)') < testApi.indexOf('rateLimit(') && testApi.indexOf('rateLimit(') < testApi.indexOf('sendChat('),
  (testApi.match(/sendChat\(/g) ?? []).length, alertCalls('src/pages/api/admin/chat-test.ts'), /\bfetch\s*\(/.test(testApi), testApi.includes(CHAT_TEST_TAG) || testApi.includes('CHAT_TEST_TAG'),
], [true, 1, 1, false, true]);
eq('통로: 대체 전송 여부를 결과에 싣는다', /fallback: r\.fallback/.test(sendSrc), true);
eq('순수 파일(chat-test.js): import 없음', /^\s*import\s/m.test(read('src/lib/chat-test.js')), false);
eq('실제 저장소 src → 구글챗 소스 게이트 통과', checkSource('src'), []);
const chatTestTests = total - beforeChatTest;

if (failed) {
  console.error(`\n구글챗 게이트 단위 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 구글챗 게이트 단위 테스트 — ${total}건 통과 · 채널 선택·대체(alert 있음/없음/실패 시 main) ${channelTests}건 · 오류 알림 테스트 보내기 ${chatTestTests}건`);
