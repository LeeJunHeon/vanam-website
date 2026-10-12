// scripts/test-mail-guard.mjs — 고객 메일 게이트의 판정 로직 단위 테스트
//
// 게이트가 "통과"만 하고 실제로는 아무것도 못 잡으면 의미가 없다(구글챗 게이트 테스트와 같은 방식).
// 진리표와 임시 폴더로 (a)(b)(c) 가 각각 걸리는지, 발송 허용 판정(mailAllowed)이 맞는지 확인한다.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mailModeAtBuild } from '../src/lib/mail-mode.js';
import { mailAllowed } from '../src/lib/quote-ack.js';
import { isSafeAddress } from '../src/lib/mail-mime.js';
import { checkSource, scanDist, judgeDist, GMAIL_HOSTS, PDF_PATHS } from './check-mail-guard.mjs';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}
// 표식·비밀값 모양을 소스에 그대로 적지 않는다(게이트 규칙과 같은 이유).
const LIVE = ['MAIL', 'MODE', 'LIVE'].join('_');
const TEST = ['MAIL', 'MODE', 'TEST'].join('_');
const FAKE_REFRESH = ['1', '', '0'].join('/') + 'gAbCdEfGhIjKlMnOpQrStUvWxYz012345';
const FAKE_CLIENT_SECRET = ['GOCSPX', 'aBcDeFgHiJkLmNoP'].join('-');
// Cloudflare 2026 새 형식 토큰 모양(접두어 + 40자 + 검사값 8자 = 53자) — 가짜
const FAKE_CF_TOKEN = ['cfut', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0' + 'abcdefgh'].join('_');
const IME = ['import', 'meta', 'env'].join('.');

// ── mailModeAtBuild 진리표 ──────────────────────────────────────────────
eq('Cloudflare main', mailModeAtBuild({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' }), LIVE);
eq('Cloudflare 다른 브랜치(quote-engine)', mailModeAtBuild({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'quote-engine' }), TEST);
const throws = (env) => { try { mailModeAtBuild(env); return '예외 없음'; } catch (e) { return e.message; } };
const NO_BRANCH = 'Cloudflare 빌드인데 브랜치 정보가 없습니다 — 고객 메일 모드 판정 불가';
eq('Cloudflare 브랜치 없음 → 예외', throws({ WORKERS_CI: '1' }), NO_BRANCH);
eq('Cloudflare 브랜치 공백 → 예외', throws({ WORKERS_CI: '1', WORKERS_CI_BRANCH: '  ' }), NO_BRANCH);
eq('CI 없음 + main(맥미니에서 main 을 빌드해도)', mailModeAtBuild({ WORKERS_CI_BRANCH: 'main' }), TEST);
eq('CI 없음(로컬)', mailModeAtBuild({}), TEST);
eq('WORKERS_CI=true (1 이 아님)', mailModeAtBuild({ WORKERS_CI: 'true', WORKERS_CI_BRANCH: 'main' }), TEST);
eq('브랜치 Main (대소문자 다름)', mailModeAtBuild({ WORKERS_CI: '1', WORKERS_CI_BRANCH: 'Main' }), TEST);
eq('env 없음', mailModeAtBuild(undefined), TEST);

// ── 발송 허용(mailAllowed) — 테스트 빌드는 회사 주소만 ─────────────────────
const allow = (live, to) => mailAllowed(live, to, isSafeAddress);
eq('테스트 빌드 · 회사 주소', allow(false, 'hello@vanam.co.kr'), { ok: true });
eq('테스트 빌드 · 회사 주소(대문자 도메인)', allow(false, 'Hello@VANAM.CO.KR'), { ok: true });
eq('테스트 빌드 · 고객 주소 → 막음', allow(false, 'customer@example.com'), { ok: false, reason: 'blocked_build' });
eq('테스트 빌드 · 비슷한 도메인 → 막음', allow(false, 'a@vanam.co.kr.evil.com'), { ok: false, reason: 'blocked_build' });
eq('테스트 빌드 · 하위 도메인 → 막음', allow(false, 'a@mail.vanam.co.kr'), { ok: false, reason: 'blocked_build' });
eq('운영 빌드 · 고객 주소', allow(true, 'customer@example.com'), { ok: true });
eq('운영 빌드 · 줄바꿈 낀 주소 → 막음', allow(true, 'a@example.com\r\nBcc: x@evil.com'), { ok: false, reason: 'bad_recipient' });
eq('운영 빌드 · 꺾쇠 → 막음', allow(true, '<a@example.com>'), { ok: false, reason: 'bad_recipient' });
eq('운영 빌드 · 빈 값 → 막음', allow(true, ''), { ok: false, reason: 'bad_recipient' });
eq('운영 빌드 · 숫자 → 막음', allow(true, 12), { ok: false, reason: 'bad_recipient' });

// ── 임시 폴더로 (a)(b)(c) 판정 ─────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'mail-guard-'));
const LOCAL = {};
const MAIN = { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' };
/** 폴더를 만든다. @param {Record<string,string>} files */
function tree(name, files) {
  const d = join(root, name);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), body);
  }
  return d;
}
const judge = (d, env) => judgeDist(scanDist(d), env).length;

try {
  const test = tree('test', { 'chunks/mail.mjs': `const MAIL_LIVE = "${TEST}".endsWith("_LIVE");` });
  const live = tree('live', { 'chunks/mail.mjs': `const MAIL_LIVE = "${LIVE}".endsWith("_LIVE");` });
  eq('테스트 번들 + 로컬 → 통과', judge(test, LOCAL), 0);
  eq('운영 번들 + 로컬 → 실패', judge(live, LOCAL), 1);
  eq('운영 번들 + Cloudflare main → 통과', judge(live, MAIN), 0);
  eq('테스트 번들 + Cloudflare main → 실패(테스트 모드로 배포 방지)', judge(test, MAIN), 1);
  const two = tree('two', { 'a.mjs': `"${TEST}"`, 'b.mjs': `"${TEST}"` });
  eq('표식 2개 → 실패', judge(two, LOCAL), 1);
  const none = tree('none', { 'a.mjs': 'export {}' });
  eq('표식 없음 → 실패', judge(none, LOCAL), 1);
  const leak = tree('leak', { 'a.mjs': `"${TEST}"`, 'b.mjs': `const t="${FAKE_REFRESH}"` });
  eq('새로고침 토큰 모양이 번들에 → 실패', judge(leak, LOCAL), 1);
  const leak2 = tree('leak2', { 'a.mjs': `"${TEST}"`, 'b.mjs': `const s="${FAKE_CLIENT_SECRET}"` });
  eq('클라이언트 비밀 모양이 번들에 → 실패', judge(leak2, LOCAL), 1);
  const leak3 = tree('leak3', { 'a.mjs': `"${TEST}"`, 'b.mjs': `const t="${FAKE_CF_TOKEN}"` });
  eq('Cloudflare 새 형식 토큰 모양(cfut_ · 53자)이 번들에 → 실패', [FAKE_CF_TOKEN.length, judge(leak3, LOCAL)], [53, 1]);
  const dv = tree('devvars', { 'a.mjs': `"${TEST}"`, '.dev.vars': `GMAIL_REFRESH_TOKEN="${FAKE_REFRESH}"` });
  eq('.dev.vars 의 비밀값은 보지 않음(배포되지 않는 로컬 파일)', judge(dv, LOCAL), 0);
  const inl = tree('inlined', { 'a.mjs': `"${TEST}"`, 'b.mjs': `Object.assign(x, {"CF_BROWSER_TOKEN":"abc123token","GMAIL_CLIENT_ID":"123.apps"});` });
  eq('빌드가 비밀값을 객체로 박아 넣은 흔적 → 실패', judge(inl, LOCAL), 1);
  const names = tree('names', { 'a.mjs': `"${TEST}"`, 'b.mjs': `secret('CF_BROWSER_TOKEN'); secret("GMAIL_REFRESH_TOKEN"); const o = { GMAIL_CLIENT_ID: "" };` });
  eq('비밀값 이름만(값 없음) → 통과', judge(names, LOCAL), 0);

  // (a) 소스 규칙
  const okSrc = tree('src-ok', {
    'lib/mail-send.ts': `const A = process.env.GMAIL_REFRESH_TOKEN; const U = 'https://${GMAIL_HOSTS[0]}/x'; declare const ${['__VANAM', 'MAIL', 'MODE__'].join('_')}: string;`,
    'lib/doc-pdf.ts': `const T = 'CF_BROWSER_TOKEN'; const P = '${PDF_PATHS[0]}'; const Q = '${PDF_PATHS[1]}';`,
    'lib/mail-mime.js': 'export function buildMime() {}',
    'lib/mail-mode.js': `export const X = '${LIVE}';`,
  });
  eq('규칙대로 둔 소스 → 통과', checkSource(okSrc).length, 0);
  const badSrc = tree('src-bad', {
    'pages/api/x.ts': `fetch('https://${GMAIL_HOSTS[0]}/send'); const k = 'GMAIL_CLIENT_SECRET';`,
    'lib/other.ts': `const m = ${['__VANAM', 'MAIL', 'MODE__'].join('_')}; const l = '${LIVE}'; const p = '${PDF_PATHS[1]}'; const t = 'CF_ACCOUNT_ID';`,
    'lib/secret.ts': `const s = '${FAKE_CLIENT_SECRET}';`,
    'lib/sneaky.ts': `import { buildMime } from './mail-mime.js';`,
    'lib/quote-ack-run.ts': `// ${IME} 를 주석에 적어도 걸린다`,
  });
  eq('규칙 어긴 소스 → 위반 9건(buildMime 다른 곳 · 메일 경로의 빌드 환경 변수 글자 포함)', checkSource(badSrc).length, 9);
  const cfSrc = tree('src-cf', { 'lib/x.ts': `const t = '${FAKE_CF_TOKEN}';` });
  eq('Cloudflare 토큰 모양이 소스에 → 위반 1건', checkSource(cfSrc).length, 1);
  eq('실제 저장소 src → 통과', checkSource('src'), []);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n고객 메일 게이트 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 고객 메일 게이트 단위 테스트 — ${total}건 통과 · 테스트 빌드는 @vanam.co.kr 주소로만`);
