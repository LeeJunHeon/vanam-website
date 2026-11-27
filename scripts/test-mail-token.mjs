// scripts/test-mail-token.mjs — Gmail 접근 토큰 요청의 시도 계획·판정(src/lib/mail-token.js) + 실행 위치 읽기(cf-colo.js) 단위 테스트
//
// 네트워크를 쓰지 않는다 — 가짜 전송 함수와 가짜 시계로 흐름을 돌린다(실제 요청은 mail-send.ts 가 한다).
// 확인하는 것: 기본 → 예비 → 기본 순서 · 마지막 시도만 긴 대기 · 발송 몫 5초 · OAuth 오류는 다시 시도하지 않음 · 로그 한 줄 모양.
import { readFileSync } from 'node:fs';
import {
  tokenOpts, tokenPlan, tokenWaitMs, tokenVerdict, tokenLogLine, tokenFlow, errorName,
  TOKEN_LAST_WAIT_MS, TOKEN_SEND_RESERVE_MS, TOKEN_MIN_WAIT_MS, TOKEN_DEFAULTS,
} from '../src/lib/mail-token.js';
import { coloText, requestColo } from '../src/lib/cf-colo.js';
import { settingDefaults } from '../src/lib/site-settings.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}

// ① 설정값 · 순서 · 대기 시간
eq('상수: 마지막 8초 · 발송 몫 5초 · 최소 1.5초', [TOKEN_LAST_WAIT_MS, TOKEN_SEND_RESERVE_MS, TOKEN_MIN_WAIT_MS], [8000, 5000, 1500]);
eq('기본값 = 운영 설정 기본값', [TOKEN_DEFAULTS.tries, TOKEN_DEFAULTS.waitSec], [settingDefaults().mail_token_tries, settingDefaults().mail_token_wait_sec]);
eq('설정: 없으면 3번·3초', [tokenOpts(undefined), tokenOpts({}), tokenOpts(null)], Array(3).fill({ tries: 3, waitMs: 3000 }));
eq('설정: 범위 안은 그대로', [tokenOpts({ tries: 1, waitSec: 2 }), tokenOpts({ tries: 2, waitSec: 4 })], [{ tries: 1, waitMs: 2000 }, { tries: 2, waitMs: 4000 }]);
eq('설정: 범위 밖·정수 아님 → 기본값', [tokenOpts({ tries: 0, waitSec: 1 }), tokenOpts({ tries: 4, waitSec: 5 }), tokenOpts({ tries: '2', waitSec: 2.5 })],
  Array(3).fill({ tries: 3, waitMs: 3000 }));
eq('순서: 기본 → 예비 → 기본', [tokenPlan(3), tokenPlan(2), tokenPlan(1), tokenPlan(9)],
  [['primary', 'backup', 'primary'], ['primary', 'backup'], ['primary'], ['primary', 'backup', 'primary']]);
eq('대기: 앞의 시도는 짧게 · 마지막만 8초', [0, 1, 2].map((index) => tokenWaitMs({ index, total: 3, waitMs: 3000, remainingMs: 20000 })), [3000, 3000, 8000]);
eq('대기: 시도 횟수 1 이면 8초 한 번', tokenWaitMs({ index: 0, total: 1, waitMs: 3000, remainingMs: 20000 }), 8000);
eq('대기: 시도 횟수 2 면 3초 · 8초', [0, 1].map((index) => tokenWaitMs({ index, total: 2, waitMs: 3000, remainingMs: 20000 })), [3000, 8000]);
eq('대기: 남은 시간 − 발송 몫 5초를 넘지 않는다', [tokenWaitMs({ index: 2, total: 3, waitMs: 3000, remainingMs: 9000 }), tokenWaitMs({ index: 0, total: 3, waitMs: 3000, remainingMs: 7000 })], [4000, 2000]);
eq('대기: 1.5초 미만이면 시도하지 않는다(0)', [6499, 6500, 5000, 0, -100].map((remainingMs) => tokenWaitMs({ index: 0, total: 3, waitMs: 3000, remainingMs })), [0, 1500, 0, 0, 0]);

// ② 응답 판정
eq('판정: 토큰 받음', tokenVerdict({ status: 200, token: 'T' }), 'ok');
eq('판정: OAuth 오류 400/401 → 즉시 끝', [tokenVerdict({ status: 400, error: 'invalid_grant' }), tokenVerdict({ status: 401, error: 'invalid_client' })], ['fatal', 'fatal']);
eq('판정: 오류 코드 없는 400/401 → 다음 시도', [tokenVerdict({ status: 400 }), tokenVerdict({ status: 401, error: '' }), tokenVerdict({ status: 400, error: { x: 1 } })], ['next', 'next', 'next']);
eq('판정: 404·429·5xx → 다음 시도', [404, 429, 500, 502, 503].map((status) => tokenVerdict({ status })), Array(5).fill('next'));
eq('판정: 접근 토큰 없는 200 → 다음 시도', [tokenVerdict({ status: 200 }), tokenVerdict({ status: 200, token: '' }), tokenVerdict({ status: 200, token: 5 })], ['next', 'next', 'next']);
eq('판정: 오류 코드가 있어도 5xx·403 은 다음 시도', [tokenVerdict({ status: 503, error: 'server_error' }), tokenVerdict({ status: 403, error: 'access_denied' })], ['next', 'next']);
eq('판정: 응답 없음', [tokenVerdict(null), tokenVerdict(undefined), tokenVerdict({})], ['next', 'next', 'next']);

// ③ 로그 한 줄
eq('로그: 실패 줄', tokenLogLine({ n: 1, host: 'oauth2', what: 'TimeoutError', ms: 3002, colo: 'HKG', ref: 'INQ-20991231-TEST' }),
  '[mail] token try=1 host=oauth2 TimeoutError 3002ms colo=HKG INQ-20991231-TEST');
eq('로그: 성공 줄', tokenLogLine({ ok: true, n: 2, host: 'www', ms: 58, colo: 'HKG', ref: 'INQ-20991231-TEST' }),
  '[mail] token ok try=2 host=www 58ms colo=HKG INQ-20991231-TEST');
eq('로그: 실행 위치·접수번호가 없거나 이상하면 빼거나 - 로', [tokenLogLine({ n: 1, host: 'oauth2', what: 'http=503', ms: 12.4 }), tokenLogLine({ ok: true, n: 1, host: 'oauth2', ms: 1, colo: 'hkg; x', ref: 'a b@c' })],
  ['[mail] token try=1 host=oauth2 http=503 12ms colo=-', '[mail] token ok try=1 host=oauth2 1ms colo=-']);
eq('오류 이름: 이름 모양만(메시지·이상한 값은 Error)', [errorName({ name: 'TimeoutError' }), errorName(new TypeError('secret https://x')), errorName({ name: 'a b' }), errorName(null), errorName('x')],
  ['TimeoutError', 'TypeError', 'Error', 'Error', 'Error']);

// ④ 흐름 — 가짜 전송 함수 · 가짜 시계(시도가 걸린 시간만큼 흐른다)
const ENDPOINTS = { primary: { label: 'oauth2', url: 'P' }, backup: { label: 'www', url: 'B' } };
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
/** script: 시도마다 { throws, takes(ms — 없으면 대기 시간을 다 씀) } 또는 { res, takes } */
async function flow(script, opts = {}) {
  let clock = 1_000_000;
  const calls = [];
  const logs = [];
  const r = await tokenFlow({
    tries: opts.tries, waitSec: opts.waitSec, deadline: clock + (opts.budget ?? 20000), now: () => clock,
    endpoints: ENDPOINTS, colo: opts.colo ?? 'HKG', ref: 'INQ-20991231-TEST',
    log: (line, level) => logs.push(`${level}|${line}`),
    attempt: async (ep, timeoutMs) => {
      const step = script[calls.length] ?? { throws: timeout() };
      calls.push({ url: ep.url, timeoutMs });
      clock += step.takes ?? (step.throws ? timeoutMs : 50);
      if (step.throws) throw step.throws;
      return step.res;
    },
  });
  return { r, calls, logs, spent: clock - 1_000_000 };
}
const OK = { res: { status: 200, token: 'ya29.TEST', expiresIn: 3599 } };
{
  const { r, calls, logs } = await flow([{ throws: timeout() }, OK]);
  eq('기본 시간 초과 → 예비 성공', [r, calls], [{ ok: true, token: 'ya29.TEST', expiresIn: 3599, tried: 2 }, [{ url: 'P', timeoutMs: 3000 }, { url: 'B', timeoutMs: 3000 }]]);
  eq('기본 시간 초과 → 예비 성공: 로그 두 줄', logs, ['error|[mail] token try=1 host=oauth2 TimeoutError 3000ms colo=HKG INQ-20991231-TEST', 'info|[mail] token ok try=2 host=www 50ms colo=HKG INQ-20991231-TEST']);
}
{
  const { r, calls } = await flow([{ throws: timeout() }, { throws: new TypeError('fetch failed') }, OK]);
  eq('기본·예비 실패 → 기본 재시도 성공(마지막만 8초)', [r.ok, r.tried, calls], [true, 3, [{ url: 'P', timeoutMs: 3000 }, { url: 'B', timeoutMs: 3000 }, { url: 'P', timeoutMs: 8000 }]]);
}
{
  const { r, calls, logs, spent } = await flow([]);
  eq('세 번 모두 시간 초과 → token_unreachable · 14초', [r, calls.map((c) => c.timeoutMs), spent], [{ ok: false, reason: 'token_unreachable', tried: 3 }, [3000, 3000, 8000], 14000]);
  eq('세 번 모두 실패: 시도마다 로그 한 줄 · 발송 몫 5초 남김', [logs.length, logs.every((l) => l.startsWith('error|[mail] token try=')), 20000 - spent >= TOKEN_SEND_RESERVE_MS], [3, true, true]);
}
{
  const { r, calls, logs } = await flow([{ res: { status: 400, error: 'invalid_grant' } }, OK]);
  eq('OAuth 오류 400 → auth_failed · 다시 시도하지 않음', [r, calls.length], [{ ok: false, reason: 'auth_failed', status: 400, tried: 1 }, 1]);
  eq('OAuth 오류: 로그에 상태·오류 코드만', logs, ['error|[mail] token try=1 host=oauth2 http=400 invalid_grant 50ms colo=HKG INQ-20991231-TEST']);
}
{
  const { r, calls } = await flow([{ throws: timeout() }, { res: { status: 401, error: 'invalid_client' } }, OK]);
  eq('예비 주소에서 OAuth 오류 401 → 거기서 끝(세 번째 없음)', [r, calls.length], [{ ok: false, reason: 'auth_failed', status: 401, tried: 2 }, 2]);
}
for (const status of [500, 503, 429, 404]) {
  const { r, calls } = await flow([{ res: { status } }, OK]);
  eq(`${status} → 다음 시도(예비 주소)에서 성공`, [r.ok, calls.map((c) => c.url)], [true, ['P', 'B']]);
}
{
  const { r, calls } = await flow([{ res: { status: 200 } }, { res: { status: 200, token: '' } }, OK]);
  eq('접근 토큰 없는 200 → 다음 시도', [r.ok, calls.length], [true, 3]);
}
{
  const { r } = await flow([{ res: { status: 503 } }, { res: { status: 502 } }, { res: { status: 429 } }]);
  eq('모두 비정상 응답 → token_unreachable + 마지막 상태', r, { ok: false, reason: 'token_unreachable', status: 429, tried: 3 });
  const b = await flow([{ res: { status: 503 } }, { res: { status: 502 } }, { throws: timeout() }]);
  eq('마지막이 응답 없음이면 상태를 싣지 않는다', b.r, { ok: false, reason: 'token_unreachable', tried: 3 });
}
{
  const { r, calls, spent } = await flow([], { tries: 1 });
  eq('시도 횟수 1 → 기본 주소 8초 한 번', [r, calls, spent], [{ ok: false, reason: 'token_unreachable', tried: 1 }, [{ url: 'P', timeoutMs: 8000 }], 8000]);
  const ok1 = await flow([{ res: OK.res, takes: 6000 }], { tries: 1 });
  eq('시도 횟수 1 → 6초 걸려도 성공(예전과 같다)', [ok1.r.ok, ok1.calls.length], [true, 1]);
}
{
  const { r, calls } = await flow([], { tries: 2, waitSec: 4 });
  eq('시도 횟수 2 · 대기 4초 → 기본 4초 · 예비 8초', [r.reason, calls], ['token_unreachable', [{ url: 'P', timeoutMs: 4000 }, { url: 'B', timeoutMs: 8000 }]]);
}
{
  const slow = await flow([{ throws: timeout() }, { throws: timeout() }, { res: OK.res, takes: 7000 }]);
  eq('느리지만 응답은 오는 경우 — 마지막 시도(8초)에서 성공', [slow.r.ok, slow.spent], [true, 13000]);
}
{
  // 마감까지 12초: 3초 → 3초 → (12 − 6 − 5 = 1초 < 1.5초) 시도하지 않음
  const { r, calls, logs, spent } = await flow([], { budget: 12000 });
  eq('남은 시간이 부족하면 중단', [r, calls.map((c) => c.timeoutMs), spent], [{ ok: false, reason: 'token_unreachable', tried: 2 }, [3000, 3000], 6000]);
  eq('중단도 로그 한 줄', logs.at(-1), 'error|[mail] token try=3 host=oauth2 no_time 0ms colo=HKG INQ-20991231-TEST');
  const cut = await flow([], { budget: 15000 });
  eq('마지막 시도는 남은 시간 − 5초까지만(15초 마감 → 3 · 3 · 4초)', [cut.calls.map((c) => c.timeoutMs), 15000 - cut.spent], [[3000, 3000, 4000], 5000]);
  const none = await flow([OK], { budget: 6000 });
  eq('처음부터 시간이 없으면 요청하지 않는다', [none.r, none.calls.length], [{ ok: false, reason: 'token_unreachable', tried: 0 }, 0]);
}
for (const budget of [20000, 24000, 17000, 9000, 7000]) {
  const { spent, calls } = await flow([], { budget });
  eq(`마감 ${budget / 1000}초: 어떤 시도도 발송 몫 5초를 침범하지 않는다`, [budget - spent >= TOKEN_SEND_RESERVE_MS, calls.every((c) => c.timeoutMs >= TOKEN_MIN_WAIT_MS)], [true, true]);
}
{
  let threw = false;
  const r = await tokenFlow({ deadline: 20000, now: () => 0, endpoints: ENDPOINTS, attempt: async () => OK.res, log: () => { throw new Error('x'); } }).catch(() => { threw = true; });
  eq('로그 함수가 던져도 흐름은 그대로', [threw, r?.ok], [false, true]);
}

// ⑤ 실행 위치 읽기
eq('위치 코드: 영문 대문자 3~4자만', ['HKG', 'NRT', 'ICN', 'KIXX', 'hkg', 'HK', 'HKGNR', 'H1G', '', null, undefined, 5, { colo: 'HKG' }].map(coloText),
  ['HKG', 'NRT', 'ICN', 'KIXX', '', '', '', '', '', '', '', '', '']);
eq('요청에서 읽기: cf.colo', [requestColo({ cf: { colo: 'HKG' } }), requestColo({ cf: {} }), requestColo({}), requestColo(null), requestColo({ cf: { colo: 'x' } })], ['HKG', '', '', '', '']);
eq('요청에서 읽기: 접근만 해도 던지는 경우 → 빈 값(던지지 않는다)', requestColo(Object.defineProperty({}, 'cf', { get() { throw new Error('removed'); } })), '');

// ⑥ 원문 검사 — 주소·비밀값은 mail-send.ts 에만 · 순수 파일은 import 없음 · Promise 를 모듈 변수에 담지 않는다
const pure = readFileSync('src/lib/mail-token.js', 'utf8');
const colo = readFileSync('src/lib/cf-colo.js', 'utf8');
const send = readFileSync('src/lib/mail-send.ts', 'utf8');
const HOST = ['googleapis', 'com'].join('.');
eq('순수 파일: import 없음 · 주소·비밀값 이름 없음', [/^\s*import\s/m.test(pure), pure.includes(HOST), /https?:\/\//.test(pure), /GMAIL_/.test(pure), /^\s*import\s/m.test(colo)], [false, false, false, false, false]);
eq('발송 통로: 토큰 주소 두 개(기본·예비)', [send.includes(`https://oauth2.${HOST}/token`), send.includes(`https://www.${HOST}/oauth2/v4/token`)], [true, true]);
eq('발송 통로: 토큰 흐름은 mail-token.js 로 · 캐시는 값만(모듈 변수 let 은 cached 하나)', [/tokenFlow\(/.test(send), (send.match(/^let\s+\w+/gm) ?? []).join(','), /^let cached: \{ token: string; until: number \} \| null = null;/m.test(send)],
  [true, 'let cached', true]);
eq('발송 통로: 발송 요청은 한 곳(자동으로 다시 보내지 않음) · 토큰 실패 사유', [(send.match(/fetch\(SEND_URL/g) ?? []).length, send.includes("'token_unreachable'")], [1, true]);
eq('세 경로가 실행 위치를 넘긴다', ['src/pages/api/inquiry.ts', 'src/pages/api/admin/quote-mail.ts', 'src/pages/api/admin/staff-mail.ts'].map((p) => /requestColo\(request\)/.test(readFileSync(p, 'utf8'))), [true, true, true]);

if (failed) {
  console.error(`\n메일 토큰 요청 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 메일 토큰 요청(mail-token·cf-colo) — ${total}건 통과 · 기본→예비→기본 · 마지막만 8초 · 발송 몫 5초 · OAuth 오류는 재시도 없음`);
