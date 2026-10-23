// scripts/test-rate-limit.mjs — 요청 횟수 제한(src/lib/rate-limit.ts) · 관리자 로그인 순서 테스트
//
//   ① rateKeyIp — IPv4 그대로 · IPv6 안의 IPv4 → IPv4 · IPv6 는 /64 정규형 · 이상한 값
//   ② 실제 라우트(api/admin/login)와 실제 rate-limit.ts 를 esbuild 로 묶어 돌린다.
//      가짜: D1(rate_limits 한 표 — UPSERT … RETURNING · UPDATE · DELETE 를 문장 단위로 원자적으로) · admin-auth(checkPassword 호출 수)
//      확인: 같은 /64 의 다른 주소 6개 → 6번째 막힘 · 틀린 비밀번호 20개 동시 → 확인 5번 이하 · 맞는 비밀번호 10번 → 안 막히고 0
//            · 틀림 4 + 맞음 1 → 다음 틀림 허용(5) · DB 오류 → 통과 · 되돌리기 오류 → 로그인 성공
// 네트워크·비밀값 없이 돈다. 700ms 지연은 0 으로 줄여 돌린다(지연이 걸렸는지는 센다).
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let total = 0, failed = 0;
const report = console.error.bind(console);
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    report(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}

// ── 묶기 ────────────────────────────────────────────────────────────────────────
const STUBS = [
  [/\/lib\/db$/, `export async function db() { return globalThis.__rl.db; }`],
  [/\/lib\/admin-auth$/, `export const adminConfigured = () => true;
    export async function checkPassword(p) { globalThis.__rl.checks++; await new Promise((r) => setTimeout(r, 0)); return p === 'right-pass'; }
    export async function makeSessionCookie() { return 'vanam_admin=ok; Path=/; HttpOnly'; }
    export const clearSessionCookie = () => 'vanam_admin=; Max-Age=0';`],
];
const dir = mkdtempSync(join(tmpdir(), 'rate-limit-'));
let M;
try {
  const out = join(dir, 'm.mjs');
  await build({
    stdin: {
      contents: `export { POST as login } from ${JSON.stringify(resolve('src/pages/api/admin/login.ts'))};
        export { rateKeyIp, rateLimit, rateRefund } from ${JSON.stringify(resolve('src/lib/rate-limit.ts'))};`,
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => {
          const hit = STUBS.findIndex(([re]) => re.test(a.path));
          return hit >= 0 ? { path: String(hit), namespace: 'stub' } : undefined;
        });
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[Number(a.path)][1], loader: 'js' }));
      },
    }],
  });
  M = await import(pathToFileURL(out).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── ① rateKeyIp ────────────────────────────────────────────────────────────────
const K = M.rateKeyIp;
eq('IPv4 그대로', K('1.2.3.4'), '1.2.3.4');
eq('IPv4 앞자리 0 정리 · 공백', K(' 001.002.003.004 '), '1.2.3.4');
eq('IPv6 안의 IPv4(점 표기) → IPv4', [K('::ffff:1.2.3.4'), K('::FFFF:1.2.3.4'), K('0:0:0:0:0:ffff:1.2.3.4')], ['1.2.3.4', '1.2.3.4', '1.2.3.4']);
eq('IPv6 안의 IPv4(16진 표기) → IPv4', K('::ffff:0102:0304'), '1.2.3.4');
eq('같은 /64 는 같은 키(압축·대소문자·앞자리 0)', [K('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), K('2001:0DB8:0001:0002::1')], ['2001:db8:1:2::/64', '2001:db8:1:2::/64']);
eq('다른 /64 는 다른 키', K('2001:db8:1:3::1'), '2001:db8:1:3::/64');
eq('zone · 대괄호[]:포트', [K('fe80::1%eth0'), K('[2001:db8:1:2::5]:443')], ['fe80:0:0:0::/64', '2001:db8:1:2::/64']);
eq('::1 · ::', [K('::1'), K('::')], ['0:0:0:0::/64', '0:0:0:0::/64']);
eq('빈 값·없음 → unknown', [K(''), K(null), K(undefined), K('   ')], ['unknown', 'unknown', 'unknown', 'unknown']);
eq('이상한 값 → 정리한 원문(64자)', [K('999.1.1.1'), K('1::2::3'), K('<script>'), K('x'.repeat(100)).length, K('12345:1::1')],
  ['999.1.1.1', '1::2::3', 'script', 64, '12345:1::1']);

// ── ② 가짜 D1 · 로그인 ─────────────────────────────────────────────────────────
const tick = () => new Promise((r) => setTimeout(r, 0));
function fakeDb({ fail = false, failRefund = false } = {}) {
  const t = new Map(); // key → { hits, window_start }
  return {
    t,
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim();
      let a = [];
      const stmt = {
        bind(...x) { a = x; return stmt; },
        async first() {
          await tick();
          if (fail) throw new Error('D1 down');
          if (q.startsWith('INSERT INTO rate_limits (key, hits, window_start) VALUES (?1, 1, ?2) ON CONFLICT(key) DO UPDATE')) {
            // 한 문장 — 이 동기 구간 안에서 읽고 쓴다(원자)
            const [key, now, win] = a;
            const r = t.get(key);
            if (!r) t.set(key, { hits: 1, window_start: now });
            else if (now - r.window_start >= win) Object.assign(r, { hits: 1, window_start: now });
            else r.hits += 1;
            return { ...t.get(key) };
          }
          if (q.startsWith('SELECT hits, window_start FROM rate_limits WHERE key = ?')) return t.get(a[0]) ? { ...t.get(a[0]) } : null;
          throw new Error(`fake D1: 모르는 SQL — ${q}`);
        },
        async run() {
          await tick();
          if (fail || (failRefund && q.startsWith('UPDATE'))) throw new Error('D1 down');
          if (q === 'UPDATE rate_limits SET hits = hits - 1 WHERE key = ?1 AND hits > 0 AND ?2 - window_start < ?3') {
            const r = t.get(a[0]);
            if (r && r.hits > 0 && a[1] - r.window_start < a[2]) { r.hits -= 1; return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (q.startsWith('DELETE FROM rate_limits WHERE window_start < ?')) {
            for (const [k, r] of t) if (r.window_start < a[0]) t.delete(k);
            return { meta: { changes: 0 } };
          }
          throw new Error(`fake D1: 모르는 SQL — ${q}`);
        },
      };
      return stmt;
    },
  };
}

// 700ms 지연은 0 으로(걸린 횟수만 센다)
const realSetTimeout = globalThis.setTimeout;
let delays = 0;
globalThis.setTimeout = (fn, ms, ...x) => { if (ms === 700) { delays++; ms = 0; } return realSetTimeout(fn, ms, ...x); };

function scene(opts) {
  globalThis.__rl = { db: fakeDb(opts), checks: 0 };
  delays = 0;
  return globalThis.__rl;
}
async function login(password, ip = '203.0.113.7', form = false) {
  const headers = { 'CF-Connecting-IP': ip, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' };
  const body = form ? new URLSearchParams({ password }).toString() : JSON.stringify({ password });
  const res = await M.login({ request: new Request('https://vanam.co.kr/api/admin/login', { method: 'POST', headers, body }) });
  if (form) return { status: res.status, location: res.headers.get('location') };
  return { status: res.status, ...(await res.json()), cookie: Boolean(res.headers.get('set-cookie')) };
}
const hitsOf = (st, ip) => st.db.t.get(`login:${K(ip)}`)?.hits ?? 0;
const quiet = async (fn) => {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, warn, error }); }
};

await quiet(async () => {
  // 같은 /64 의 서로 다른 IPv6 6개 → 6번째가 막힌다
  {
    const st = scene();
    const ips = ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:ffff::3', '2001:0db8:0001:0002:0:0:0:4', '2001:DB8:1:2:a:b:c:d', '2001:db8:1:2::6'];
    const r = [];
    for (const ip of ips) r.push((await login('wrong', ip)).error);
    eq('같은 /64 다른 주소 6개: 5번 invalid · 6번째 rate_limited', r, ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'rate_limited']);
    eq('같은 /64: 확인 5번 · 다른 /64 는 따로', [st.checks, (await login('wrong', '2001:db8:1:3::1')).error], [5, 'invalid']);
  }

  // 틀린 비밀번호 20개를 동시에 → 확인은 5번 이하, 나머지는 막힘
  {
    const st = scene();
    const rs = await Promise.all(Array.from({ length: 20 }, () => login('wrong')));
    const n = (e) => rs.filter((x) => x.error === e).length;
    eq('동시 20개: 비밀번호 확인 5번 이하', st.checks <= 5, true);
    eq('동시 20개: invalid 5 · rate_limited 15 · 429 + Retry-After 값', [n('invalid'), n('rate_limited'), rs.filter((x) => x.status === 429 && x.retryAfterSec > 0).length], [5, 15, 15]);
    eq('동시 20개: 700ms 지연은 틀린 확인마다(5번) · 남은 카운트 5(막힌 15개는 되돌림)', [delays, hitsOf(st, '203.0.113.7')], [5, 5]);
    // 막혀 있는 동안은 맞는 비밀번호도 막힌다(지금과 같다)
    const ok = await login('right-pass');
    eq('막힌 동안 맞는 비밀번호도 막힘', [ok.status, ok.error, ok.cookie], [429, 'rate_limited', false]);
  }

  // 맞는 비밀번호 10번 → 한 번도 막히지 않고 카운트는 0
  {
    const st = scene();
    const rs = [];
    for (let i = 0; i < 10; i++) rs.push(await login('right-pass'));
    eq('맞는 비밀번호 10번: 모두 200 + 쿠키 · 카운트 0', [rs.every((x) => x.status === 200 && x.ok && x.cookie), hitsOf(st, '203.0.113.7')], [true, 0]);
    // 동시에 10번 — 먼저 세므로 그 순간 5개를 넘는 몫은 막히지만, 막힌 몫도 되돌려 카운트는 0 으로 돌아온다(뒤에 막히지 않는다)
    const rs2 = await Promise.all(Array.from({ length: 10 }, () => login('right-pass')));
    const after = await login('right-pass');
    eq('맞는 비밀번호 동시 10번: 5개 이상 200 · 카운트 0 · 다음 로그인 200',
      [rs2.filter((x) => x.status === 200).length >= 5, hitsOf(st, '203.0.113.7'), after.status], [true, 0, 200]);
  }

  // 틀림 4번 + 맞음 1번 → 다음 틀림 1번은 아직 허용(카운트 5)
  {
    const st = scene();
    for (let i = 0; i < 4; i++) await login('wrong');
    const ok = await login('right-pass');
    const w5 = await login('wrong');
    const w6 = await login('wrong');
    eq('틀림 4 + 맞음 1: 맞음 200 · 다음 틀림 invalid(카운트 5) · 그다음은 막힘',
      [ok.status, w5.error, hitsOf(st, '203.0.113.7') >= 5, w6.error], [200, 'invalid', true, 'rate_limited']);
  }

  // 빈 비밀번호·본문 오류는 세지 않는다 · 폼 제출 응답 형식 그대로
  {
    const st = scene();
    const e1 = await login('');
    const e2 = await M.login({ request: new Request('https://vanam.co.kr/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }) });
    eq('빈 값 400 empty · 본문 오류 400 · 세지 않음 · 확인 0', [e1.status, e1.error, e2.status, st.db.t.size, st.checks], [400, 'empty', 400, 0, 0]);
    const f1 = await login('wrong', '198.51.100.1', true);
    const f2 = await login('right-pass', '198.51.100.1', true);
    const f3 = await login('', '198.51.100.1', true);
    eq('폼 제출: 303 /admin?login=invalid · 성공 /admin · 빈 값 empty', [f1.status, f1.location, f2.status, f2.location, f3.location],
      [303, '/admin?login=invalid', 303, '/admin', '/admin?login=empty']);
    for (let i = 0; i < 5; i++) await login('wrong', '198.51.100.1', true);
    eq('폼 제출: 막히면 /admin?login=limited', (await login('wrong', '198.51.100.1', true)).location, '/admin?login=limited');
  }

  // DB 오류 → 통과(지금과 같다) · 되돌리기 오류 → 로그인 성공을 막지 않는다
  {
    const st = scene({ fail: true });
    const rs = [];
    for (let i = 0; i < 7; i++) rs.push((await login('wrong')).error);
    eq('DB 오류: 막지 않음(7번 모두 invalid · 확인 7번)', [rs.every((e) => e === 'invalid'), st.checks], [true, 7]);
    const ok = await login('right-pass');
    eq('DB 오류: 맞는 비밀번호 200', [ok.status, ok.cookie], [200, true]);
  }
  {
    const st = scene({ failRefund: true });
    const ok = await login('right-pass');
    eq('되돌리기 오류: 로그인 200 + 쿠키(카운트는 1 남음)', [ok.status, ok.cookie, hitsOf(st, '203.0.113.7')], [200, true, 1]);
  }

  // rateRefund — 창이 지났거나 0 이면 그대로
  {
    const st = scene();
    const req = () => new Request('https://vanam.co.kr/x', { headers: { 'CF-Connecting-IP': '192.0.2.9' } });
    await M.rateRefund(st.db, 'login', req());
    eq('되돌리기: 행 없음 → 그대로', st.db.t.size, 0);
    await M.rateLimit(st.db, 'login', req());
    await M.rateRefund(st.db, 'login', req());
    await M.rateRefund(st.db, 'login', req());
    eq('되돌리기: 0 아래로 안 내려감', st.db.t.get('login:192.0.2.9').hits, 0);
    st.db.t.get('login:192.0.2.9').hits = 3;
    st.db.t.get('login:192.0.2.9').window_start = Date.now() - 16 * 60 * 1000;
    await M.rateRefund(st.db, 'login', req());
    eq('되돌리기: 지난 창은 그대로', st.db.t.get('login:192.0.2.9').hits, 3);
    await M.rateRefund(null, 'login', req());
    eq('되돌리기: DB 없음 → 조용히', true, true);
  }
});
globalThis.setTimeout = realSetTimeout;

if (failed) {
  console.error(`\n요청 횟수 제한 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 요청 횟수 제한(rate-limit·admin/login) — ${total}건 통과 · IPv6 /64 · 로그인 먼저 세고 성공 시 되돌리기 · 동시 20개 → 확인 5번 이하`);
