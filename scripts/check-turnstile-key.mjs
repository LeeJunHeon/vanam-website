// scripts/check-turnstile-key.mjs — Turnstile 사이트 키 게이트
//
// 로컬 테스트 키(항상 통과)가 운영에 나가면 로봇 확인이 사실상 꺼진다. 이 게이트는:
//   (a) 소스: 두 키 문자열은 src/lib/turnstile-key.js 에만
//   (b) 산출물: 이 실행 환경의 기대 키(turnstileSitekeyAtBuild(process.env))가 제품 페이지 10개·문의 페이지 2개에 있고,
//       다른 키는 dist/client·dist/server 전체에서 0건
//   (c) turnstileSitekeyAtBuild 단위 사례
// check-chat-guard 처럼 실행 환경의 기대값으로 판정한다(Cloudflare 빌드는 운영 키, npm run local 은 테스트 키).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { TURNSTILE_SITEKEY_PROD, TURNSTILE_SITEKEY_TEST, turnstileSitekeyAtBuild } from '../src/lib/turnstile-key.js';

const errs = [];
const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const KEYS = [TURNSTILE_SITEKEY_PROD, TURNSTILE_SITEKEY_TEST];

// (a) 소스
for (const f of walk('src')) {
  const rel = relative('src', f).split(sep).join('/');
  if (rel === 'lib/turnstile-key.js') continue;
  const t = readFileSync(f, 'utf8');
  for (const k of KEYS) if (t.includes(k)) errs.push(`src/${rel}: Turnstile 키 문자열이 있다 — src/lib/turnstile-key.js 에만 둔다`);
}

// (c) 단위 사례
const tryKey = (env) => { try { return turnstileSitekeyAtBuild(env); } catch { return 'THROW'; } };
const CASES = [
  ['CI + 설정(test) → 예외', { WORKERS_CI: '1', VANAM_LOCAL_TURNSTILE: 'test' }, 'THROW'],
  ['CI + 빈 값 → 예외', { WORKERS_CI: '1', VANAM_LOCAL_TURNSTILE: '' }, 'THROW'],
  ['CI → 운영 키', { WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main' }, TURNSTILE_SITEKEY_PROD],
  ["로컬 + 'test' → 테스트 키", { VANAM_LOCAL_TURNSTILE: 'test' }, TURNSTILE_SITEKEY_TEST],
  ['로컬 → 운영 키', {}, TURNSTILE_SITEKEY_PROD],
  ["로컬 + '1' → 운영 키", { VANAM_LOCAL_TURNSTILE: '1' }, TURNSTILE_SITEKEY_PROD],
];
for (const [label, env, want] of CASES) if (tryKey(env) !== want) errs.push(`단위 사례 실패: ${label}`);

// (b) 산출물
let expected = null;
try { expected = turnstileSitekeyAtBuild(process.env); } catch (e) { errs.push(`이 환경의 기대 키를 정할 수 없다: ${e.message}`); }
const PAGES = [];
for (const p of ['metals', 'multilayers', 'nitrides', 'oxides', 'wafers']) PAGES.push(`product/${p}/index.html`, `ko/product/${p}/index.html`);
PAGES.push('contact/index.html', 'ko/contact/index.html');
if (!existsSync('dist/client') || !existsSync('dist/server')) errs.push('dist 가 없다 — npm run build 뒤에 실행하세요');
else if (expected) {
  const other = KEYS.find((k) => k !== expected);
  for (const p of PAGES) {
    const f = join('dist', 'client', p);
    if (!existsSync(f)) { errs.push(`dist/client/${p} 없음`); continue; }
    if (!readFileSync(f, 'utf8').includes(`data-sitekey="${expected}"`)) errs.push(`dist/client/${p}: 기대 키가 없다`);
  }
  for (const root of ['dist/client', 'dist/server']) {
    for (const f of walk(root)) {
      if (f.endsWith(`${sep}.dev.vars`)) continue;
      if (readFileSync(f).includes(other)) errs.push(`${f}: 다른 Turnstile 키가 들어 있다`);
    }
  }
}

if (errs.length) {
  for (const e of errs) console.error('  ✗', e);
  console.error(`\nTurnstile 키 게이트 실패 — ${errs.length}건.`);
  process.exit(1);
}
console.log(`✓ Turnstile 키 게이트 — ${expected === TURNSTILE_SITEKEY_TEST ? '로컬 테스트 키' : '운영 키'} · 페이지 ${PAGES.length}개 · 다른 키 0건 · 단위 ${CASES.length}건`);
