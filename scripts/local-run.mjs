// npm run local — 빌드 결과를 로컬 D1 로 띄운다 (맥미니 전용 · 127.0.0.1 전용).
//
// 왜 astro dev 가 아닌가:
//   dev 는 순수 Node 라 D1 이 없어 주문·관리자·견적 계산기를 확인할 수 없고,
//   .env 의 값을 그대로 읽는다(예전에 로컬 제출이 실제 채팅방 알림이 된 경로).
//   astro preview 는 이 저장소에서 어댑터가 빌드 때만 붙어 쓸 수 없다.
//   → 빌드한 워커를 wrangler dev --local 로 띄우고, price-db-import 가 넣은
//     로컬 D1(.wrangler/state)을 그대로 읽는다.
//
// 순서: ① CI 거부 → ② 빌드 → ③ 알림 꺼짐·고객 메일 테스트 모드 확인 → ④ 로컬 전용 비밀값 → ⑤ .dev.vars 덮어쓰기
//       → ⑥ wrangler dev (127.0.0.1:8787) → ⑦ 접속 안내
//
// ⚠️ 이 스크립트는 .env 의 "값"을 읽지 않는다. 키 이름만 모아 빈 값으로 덮는다.
// ⚠️ wrangler 는 dev --local 만 부른다. deploy·secret·--remote 는 쓰지 않는다.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanDist, judgeDist, WEBHOOK_HOST } from './check-chat-guard.mjs';
import { scanDist as scanMail, judgeDist as judgeMail } from './check-mail-guard.mjs';
import { TURNSTILE_SITEKEY_TEST } from '../src/lib/turnstile-key.js';

const HOST = '127.0.0.1';
const PORT = 8787;
const DIST = 'dist/server';
const DEV_VARS = join(DIST, '.dev.vars');
const LOCAL_VARS = join(homedir(), 'vanam-data', 'local.vars');

const die = (msg) => { console.error(`\n✗ npm run local 중단 — ${msg}`); process.exit(1); };

// ① Cloudflare 빌드 서버에서는 돌리지 않는다(거기서는 알림이 켜진 빌드가 나온다).
if (process.env.WORKERS_CI) die('WORKERS_CI 가 설정된 환경입니다. 로컬 실행은 맥미니에서만 합니다.');

// 포트는 빌드 전에 먼저 본다 — 빌드 1분 뒤에 실패하면 헛수고다.
const portFree = () => new Promise((resolve) => {
  const probe = createConnection({ host: HOST, port: PORT });
  probe.once('connect', () => { probe.destroy(); resolve(false); });
  probe.once('error', () => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(PORT, HOST, () => srv.close(() => resolve(true)));
  });
});
if (!(await portFree())) die(`${HOST}:${PORT} 가 이미 사용 중입니다. 이전 로컬 서버를 PID 로 종료한 뒤 다시 실행하세요 (lsof -nP -iTCP:${PORT} -sTCP:LISTEN).`);

// ② 빌드 (Vite 캐시 삭제는 package.json 의 prebuild 가 먼저 한다)
//    Turnstile 은 로컬 테스트 키로 빌드한다(운영 키는 localhost 에서 위젯이 뜨지 않아 폼 제출 시험이 안 된다).
console.log('▶ npm run build (Turnstile 로컬 테스트 키)');
const BUILD_ENV = { ...process.env, VANAM_LOCAL_TURNSTILE: 'test' };
const b = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', env: BUILD_ENV });
if (b.status !== 0) die(`빌드 실패 (exit ${b.status})`);

// ③ 번들이 알림 꺼짐이고 웹훅 주소가 없는지 — 아니면 절대 띄우지 않는다.
const errs = judgeDist(scanDist(DIST), process.env);
if (errs.length) die(`알림 게이트 실패:\n  ${errs.join('\n  ')}`);
if (scanDist(DIST).markers[0].value !== 'CHAT_MODE_OFF') die('번들이 알림 꺼짐(CHAT_MODE_OFF)이 아닙니다.');
console.log('✓ 번들 확인 — 구글챗 알림 꺼짐(CHAT_MODE_OFF) · 웹훅 주소 0건');
// 고객 메일도 테스트 모드여야 띄운다 — 테스트 모드는 @vanam.co.kr 주소로만 보낸다(src/lib/mail-send.ts).
{
  const merrs = judgeMail(scanMail(DIST), process.env);
  if (merrs.length) die(`고객 메일 게이트 실패:\n  ${merrs.join('\n  ')}`);
  if (scanMail(DIST).markers[0].value !== 'MAIL_MODE_TEST') die('번들이 고객 메일 테스트 모드(MAIL_MODE_TEST)가 아닙니다.');
  console.log('✓ 번들 확인 — 고객 메일 테스트 모드(MAIL_MODE_TEST · @vanam.co.kr 주소로만) · 비밀값 0건');
}
{
  const page = join('dist', 'client', 'ko', 'product', 'multilayers', 'index.html');
  if (!existsSync(page) || !readFileSync(page, 'utf8').includes(`data-sitekey="${TURNSTILE_SITEKEY_TEST}"`)) {
    die(`${page} 에 Turnstile 로컬 테스트 키가 없습니다 — 로컬 폼 제출 시험이 안 됩니다.`);
  }
  console.log('✓ 번들 확인 — Turnstile 로컬 테스트 키(제품 페이지)');
}

// ── dotenv 최소 파서 (키=값, 따옴표 벗김) ─────────────────────────────────
const KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
/** 키 이름만 모은다 — 값은 읽지 않는다. */
const keysOf = (path) => existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').map((l) => l.match(KEY_RE)?.[1]).filter(Boolean)
  : [];
/**
 * 로컬 전용 파일(local.vars·.dev.vars)의 값 읽기.
 * 값의 앞뒤 공백(윈도우 줄 끝 \r 포함)을 먼저 지우고 나서 따옴표("…" · '…')를 벗긴다
 * — 예전에는 순서가 반대라 `KEY="값" ` 처럼 닫는 따옴표 뒤에 공백이 있으면 따옴표가 값에 남았다.
 */
function readVars(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=([^\n]*)$/); // [^\n] — 줄 끝 \r 도 값으로 받아 아래에서 지운다
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// ④ 로컬 전용 비밀값 — 운영 비밀번호를 재사용하지 않는다.
let created = false;
if (!existsSync(LOCAL_VARS)) {
  const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const pw = Array.from({ length: 24 }, () => ABC[randomInt(ABC.length)]).join('');
  writeFileSync(LOCAL_VARS,
    `# npm run local 전용 (맥미니 로컬 관리자). 운영 값과 무관 — 저장소에 넣지 않는다.\n` +
    `ADMIN_PASSWORD="${pw}"\nSESSION_SECRET="${randomBytes(32).toString('base64')}"\n`, { mode: 0o600 });
  created = true;
}
chmodSync(LOCAL_VARS, 0o600);
const local = readVars(LOCAL_VARS);
if (!(local.ADMIN_PASSWORD?.length >= 16) || !(local.SESSION_SECRET?.length >= 16)) {
  die(`${LOCAL_VARS} 의 ADMIN_PASSWORD·SESSION_SECRET 이 16자 미만입니다. 파일을 지우면 새로 만듭니다.`);
}

// ⑤ .dev.vars 를 새로 쓴다. 어댑터가 .env 에서 복사한 것을 덮는다.
//    모든 키를 "" 로 적는 이유: 번들에 남은 import.meta.env 폴백을 cloudflare env 의 "" 로 가리기 위해서다
//    (코드는 cfEnv[k] ?? import.meta.env[k] 순서라 "" 이 있으면 폴백까지 내려가지 않는다).
const keys = [...new Set([...keysOf('.env.example'), ...keysOf('.env')])];
const vars = Object.fromEntries(keys.map((k) => [k, '']));
Object.assign(vars, { ADMIN_PASSWORD: local.ADMIN_PASSWORD, SESSION_SECRET: local.SESSION_SECRET, PAYPAL_ENV: 'sandbox' });
// 확인 메일 시험용 비밀값 — 사용자가 local.vars 에 직접 넣었을 때만 옮긴다(값은 화면에 찍지 않는다).
// 이 빌드는 테스트 모드라 넣어도 @vanam.co.kr 주소로만 나간다(코드에서 막음).
const MAIL_KEYS = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'CF_ACCOUNT_ID', 'CF_BROWSER_TOKEN'];
for (const k of MAIL_KEYS) if (typeof local[k] === 'string' && local[k].trim()) vars[k] = local[k].trim();
writeFileSync(DEV_VARS,
  '# npm run local 이 매번 새로 쓴다 — 로컬 전용 값만. (.env 값은 복사하지 않는다)\n' +
  Object.entries(vars).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n', { mode: 0o600 });
const check = readVars(DEV_VARS);
for (const k of ['GOOGLE_CHAT_WEBHOOK', 'PAYPAL_CLIENT_ID', 'PAYPAL_SECRET']) {
  if (check[k] !== '') die(`${DEV_VARS} 의 ${k} 가 빈 값이 아닙니다.`);
}
if (readFileSync(DEV_VARS, 'utf8').includes(WEBHOOK_HOST)) die(`${DEV_VARS} 에 웹훅 주소가 남아 있습니다.`);
console.log(`✓ ${DEV_VARS} — 키 ${keys.length}개 빈 값 · 로컬 관리자 비밀값 · PAYPAL_ENV=sandbox`);
{
  const set = (...ks) => ks.every((k) => Boolean(vars[k]));
  console.log(`✓ 확인 메일 — 테스트 모드(@vanam.co.kr 주소로만) · Gmail ${set('GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN') ? '설정 있음' : '설정 없음(보내지 않음)'}` +
    ` · PDF ${set('CF_ACCOUNT_ID', 'CF_BROWSER_TOKEN') ? '설정 있음' : '설정 없음(조회 링크만)'}`);
}

// ⑦ 접속 안내 (서버 로그에 묻히지 않게 먼저 찍는다)
console.log(`
────────────────────────────────────────────────────────────
 로컬 서버: http://${HOST}:${PORT}  (이 맥미니 안에서만 열린다)
 노트북에서 보려면 PowerShell 에서 터널을 연다:
   ssh -N -L ${PORT}:127.0.0.1:${PORT} elon@192.168.0.132
 그다음 브라우저: http://localhost:${PORT}/admin/quote
 (관리자 쿠키가 Secure 라 http://192.168.0.132 로는 로그인이 유지되지 않는다)
 로컬 관리자 비밀번호: ${LOCAL_VARS} 의 ADMIN_PASSWORD
 확인 메일 시험: 견적 요청서의 이메일 칸에 @vanam.co.kr 주소를 넣는다(다른 주소는 보내지 않는다)
 종료: Ctrl+C
────────────────────────────────────────────────────────────`);
if (created) console.log(`\n★ 로컬 관리자 비밀번호를 새로 만들었습니다(이번 한 번만 표시): ${local.ADMIN_PASSWORD}\n`);

// ⑥ wrangler dev — 127.0.0.1 에만 연다(사내망 다른 PC 접근 차단 — 원가 화면이 있다).
//    별도 프로세스 그룹(detached)으로 띄운다: npx 만 죽이면 자식 workerd 가 남아 8787 을 계속 잡는다.
//    종료할 때는 그룹 전체(-pgid)에 신호를 보낸다.
const child = spawn('npx', ['wrangler', 'dev', '--config', join(DIST, 'wrangler.json'), '--local',
  '--persist-to', '.wrangler/state', '--ip', HOST, '--port', String(PORT)], {
  stdio: 'inherit',
  detached: true,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* 이미 끝남 */ } };

/** 포트가 빌 때까지 최대 ms 동안 기다린다. */
const waitPortFree = async (ms) => {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (await portFree()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return portFree();
};

let stopping = false;
const stop = async (sig) => {
  if (stopping) return;
  stopping = true;
  console.log(`\n▶ ${sig} — wrangler·workerd 프로세스 그룹(${child.pid}) 종료 중…`);
  killGroup('SIGTERM');
  // 5초 안에 포트가 비지 않으면 그룹을 강제 종료한다.
  let free = await waitPortFree(5000);
  if (!free) { killGroup('SIGKILL'); free = await waitPortFree(3000); }
  console.log(free ? `✓ ${HOST}:${PORT} 비어 있음 — 로컬 서버 종료 완료`
    : `✗ ${HOST}:${PORT} 가 아직 사용 중 — lsof -nP -iTCP:${PORT} -sTCP:LISTEN 으로 PID 를 확인하세요`);
  process.exit(free ? 0 : 1);
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(sig));
// wrangler 가 스스로 끝나면(오류 등) 남은 자식도 함께 정리하고 같은 코드로 끝낸다.
child.on('exit', (code, signal) => {
  if (stopping) return;
  killGroup('SIGTERM');
  process.exit(code ?? (signal ? 0 : 1));
});
