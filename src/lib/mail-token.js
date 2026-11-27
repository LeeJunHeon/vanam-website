// Gmail 접근 토큰 요청 — 시도 계획과 판정(순수 함수). 실제 요청은 mail-send.ts 가 한다.
//
// 왜(11-26): 구글 인증 서버가 8초 동안 응답하지 않아 메일이 실패했다(요청에 따라 됐다 안 됐다).
//   한 번만 하고 끝내던 토큰 요청을 짧게 끊어 주소를 바꿔 가며 다시 시도한다.
//   순서(최대 3번): ① 기본 주소 ② 예비 주소 ③ 기본 주소 — 시도 횟수 2 면 ①②, 1 이면 기본 주소 한 번.
//   대기: 마지막 시도를 뺀 앞의 시도는 '짧은 대기'(운영 설정 · 기본 3초), 마지막 시도는 최대 8초
//         (느리지만 응답은 오는 경우에 예전보다 나빠지지 않게). 시도 횟수 1 이면 8초 한 번 = 예전 동작.
//   시간 배분: 어떤 시도도 "남은 마감 시간 − 발송 몫 5초"를 넘겨 기다리지 않는다. 그렇게 계산한 대기가 1.5초 미만이면 더 시도하지 않는다.
//   다음 시도로: 연결 오류·시간 초과, OAuth 오류 코드가 없는 비정상 응답(404 · 429 · 5xx · 접근 토큰이 없는 200 등).
//   바로 끝냄: 구글이 OAuth 오류 코드(invalid_grant · invalid_client 등)와 함께 400/401 로 답함 → auth_failed(주소를 바꿔도 같다).
//   모두 실패: token_unreachable — 메일은 나가지 않았다(다시 보내면 된다).
//
// ⚠️ .js 이고 다른 모듈을 import 하지 않는다 — node 테스트(scripts/test-mail-token.mjs)가 가짜 전송 함수로 흐름을 확인한다.
// ⚠️ 주소·비밀값을 문자열로 담지 않는다(인자로 받는다 — 주소와 Gmail 비밀값은 mail-send.ts 에만).
// ⚠️ 진행 중인 요청(Promise)을 모듈 변수에 담아 요청끼리 공유하지 않는다 — Workers 에서는 다른 요청이 만든 Promise 를 기다리면 멈출 수 있다.
// ⚠️ 로그 한 줄에는 시도 번호·주소 이름표·결과·걸린 시간·실행 위치·접수번호만 — 비밀값·주소 전체·응답 본문은 넣지 않는다.

/** 마지막 시도의 최대 대기(ms) — 예전의 한 번짜리 요청과 같다 */
export const TOKEN_LAST_WAIT_MS = 8000;
/** 토큰을 받은 뒤 발송에 남겨 두는 몫(ms) */
export const TOKEN_SEND_RESERVE_MS = 5000;
/** 대기 시간이 이보다 짧으면 시도하지 않는다(ms) */
export const TOKEN_MIN_WAIT_MS = 1500;
/** 운영 설정이 없거나 이상할 때의 값(src/lib/site-settings.js 의 기본값과 같다) */
export const TOKEN_DEFAULTS = Object.freeze({ tries: 3, waitSec: 3 });

const int = (v, min, max, def) => (Number.isInteger(v) && v >= min && v <= max ? v : def);

/**
 * 시도 횟수·짧은 대기 — 범위(1~3번 · 2~4초)를 벗어나면 기본값.
 * @param {{ tries?: unknown, waitSec?: unknown } | null | undefined} o
 * @returns {{ tries: number, waitMs: number }}
 */
export function tokenOpts(o) {
  return {
    tries: int(o?.tries, 1, 3, TOKEN_DEFAULTS.tries),
    waitMs: int(o?.waitSec, 2, 4, TOKEN_DEFAULTS.waitSec) * 1000,
  };
}

/**
 * 시도 순서 — 기본 → 예비 → 기본.
 * @param {number} tries 1~3 @returns {('primary' | 'backup')[]}
 */
export function tokenPlan(tries) {
  return /** @type {('primary' | 'backup')[]} */ (['primary', 'backup', 'primary']).slice(0, int(tries, 1, 3, TOKEN_DEFAULTS.tries));
}

/**
 * 이번 시도의 대기 시간(ms). 0 = 시간이 모자라 더 시도하지 않는다.
 * @param {{ index: number, total: number, waitMs: number, remainingMs: number }} p
 *   index = 몇 번째 시도(0부터) · total = 계획한 시도 수 · remainingMs = 마감까지 남은 시간
 */
export function tokenWaitMs(p) {
  const cap = p.index >= p.total - 1 ? TOKEN_LAST_WAIT_MS : p.waitMs;
  const wait = Math.floor(Math.min(cap, p.remainingMs - TOKEN_SEND_RESERVE_MS));
  return wait >= TOKEN_MIN_WAIT_MS ? wait : 0;
}

/**
 * 응답 한 건의 판정.
 *   ok = 접근 토큰을 받았다 · fatal = OAuth 오류 코드와 함께 400/401(권한 문제 — 다시 시도해도 같다) · next = 다음 시도로
 * @param {{ status?: unknown, token?: unknown, error?: unknown } | null | undefined} r
 * @returns {'ok' | 'fatal' | 'next'}
 */
export function tokenVerdict(r) {
  const status = Number(r?.status);
  if (status >= 200 && status < 300 && typeof r?.token === 'string' && r.token) return 'ok';
  if ((status === 400 || status === 401) && typeof r?.error === 'string' && r.error.trim()) return 'fatal';
  return 'next';
}

const word = (v, re, fallback) => (typeof v === 'string' && re.test(v) ? v : fallback);
/** 오류 이름(TimeoutError 등) — 이름 모양이 아니면 'Error'. 메시지는 쓰지 않는다. */
export const errorName = (e) => word(e?.name, /^[A-Za-z]{1,40}$/, 'Error');
const oauthCode = (v) => word(typeof v === 'string' ? v.trim() : v, /^[a-z_]{1,40}$/, '');
const coloOf = (v) => word(v, /^[A-Z]{3,4}$/, '-');
const refOf = (v) => word(v, /^[A-Za-z0-9-]{1,40}$/, '');

/**
 * 로그 한 줄.
 *   실패: [mail] token try=1 host=oauth2 TimeoutError 3002ms colo=HKG <접수번호>
 *   성공: [mail] token ok try=2 host=www 58ms colo=HKG <접수번호>
 * @param {{ ok?: boolean, n: number, host: string, what?: string, ms: number, colo?: unknown, ref?: unknown }} p
 */
export function tokenLogLine(p) {
  const host = word(p.host, /^[a-z0-9]{1,20}$/, '-');
  const tail = `${Math.max(0, Math.round(p.ms))}ms colo=${coloOf(p.colo)} ${refOf(p.ref)}`.trimEnd();
  return p.ok ? `[mail] token ok try=${p.n} host=${host} ${tail}` : `[mail] token try=${p.n} host=${host} ${p.what || 'Error'} ${tail}`;
}

/**
 * 토큰 요청 한 묶음(시도 → 판정 → 다음 시도). 예외를 던지지 않는다.
 * @param {{
 *   tries?: unknown, waitSec?: unknown, deadline: number, now: () => number,
 *   endpoints: { primary: { label: string, url: string }, backup: { label: string, url: string } },
 *   attempt: (ep: { label: string, url: string }, timeoutMs: number) => Promise<{ status: number, token?: unknown, expiresIn?: unknown, error?: unknown }>,
 *   log?: (line: string, level: 'info' | 'error') => void, colo?: unknown, ref?: unknown,
 * }} d
 *   attempt = 실제 요청(mail-send.ts) — 응답을 받으면 상태·토큰·OAuth 오류 코드를 돌려주고, 연결 오류·시간 초과면 던진다. 테스트는 가짜를 넘긴다.
 * @returns {Promise<
 *   { ok: true, token: string, expiresIn: unknown, tried: number } |
 *   { ok: false, reason: 'auth_failed' | 'token_unreachable', status?: number, tried: number }>}
 *   tried = 실제로 요청한 횟수 · status = 마지막 시도가 받은 HTTP 상태(응답이 없었으면 없음)
 */
export async function tokenFlow(d) {
  const { tries, waitMs } = tokenOpts(d);
  const plan = tokenPlan(tries);
  const say = (line, level) => {
    try { d.log?.(line, level); } catch { /* 로그 실패는 무시 */ }
  };
  let tried = 0;
  let lastStatus;
  for (let i = 0; i < plan.length; i++) {
    const timeoutMs = tokenWaitMs({ index: i, total: plan.length, waitMs, remainingMs: d.deadline - d.now() });
    const ep = d.endpoints[plan[i]];
    const at = { n: i + 1, host: ep?.label, colo: d.colo, ref: d.ref };
    if (!timeoutMs) {
      say(tokenLogLine({ ...at, what: 'no_time', ms: 0 }), 'error');
      break;
    }
    tried++;
    const t0 = d.now();
    let r;
    try {
      r = await d.attempt(ep, timeoutMs);
    } catch (e) {
      lastStatus = undefined;
      say(tokenLogLine({ ...at, what: errorName(e), ms: d.now() - t0 }), 'error');
      continue;
    }
    const ms = d.now() - t0;
    const verdict = tokenVerdict(r);
    if (verdict === 'ok') {
      say(tokenLogLine({ ...at, ok: true, ms }), 'info');
      return { ok: true, token: String(r.token), expiresIn: r.expiresIn, tried };
    }
    const status = Number.isInteger(r?.status) ? r.status : undefined;
    // 오류 코드(invalid_grant 등)만 남긴다 — 응답 본문 전체는 남기지 않는다
    say(tokenLogLine({ ...at, what: [`http=${status ?? '-'}`, oauthCode(r?.error)].filter(Boolean).join(' '), ms }), 'error');
    if (verdict === 'fatal') return { ok: false, reason: 'auth_failed', status, tried };
    lastStatus = status;
  }
  return { ok: false, reason: 'token_unreachable', ...(lastStatus === undefined ? {} : { status: lastStatus }), tried };
}
