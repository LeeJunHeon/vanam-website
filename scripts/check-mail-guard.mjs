// scripts/check-mail-guard.mjs — 고객 메일(접수 확인 메일) 빌드 게이트
//
// 왜 있는가: 맥미니에서 테스트하다 실제 고객에게 메일이 나가면 안 된다(구글챗 사고와 같은 길을 미리 막는다).
// 운영/테스트는 빌드 종류가 정한다(src/lib/mail-mode.js). 이 게이트는 그 약속이 지켜졌는지 본다.
//
//   (a) 소스: Gmail 비밀값 이름·Gmail 주소는 mail-send.ts 에만 · PDF 비밀값·주소는 doc-pdf.ts 에만 ·
//       원문 조립(buildMime)은 mail-send.ts 에서만 부른다(발송 통로 하나) ·
//       빌드 표식 상수(__VANAM_MAIL_MODE__)는 mail-send.ts 에만 · 운영 표식 문자열은 mail-mode.js 에만 ·
//       메일 경로 파일에는 빌드 환경 변수 문자열(import.meta + .env)을 주석으로도 두지 않는다
//       (Astro 6 은 원문에서 그 글자를 찾으면 그 파일이 이름을 부르는 .env 키 값을 번들에 넣을 준비를 한다)
//   (b) 번들: dist/server 안의 메일 표식이 정확히 하나이고, 이 환경에서 기대하는 값과 같다
//       → Cloudflare main 빌드가 테스트 모드로 배포되는 것도, 로컬 빌드가 운영 모드가 되는 것도 막는다.
//   (c) 번들: dist/server 에 비밀값 0건 — Google 비밀값 모양(새로고침 토큰 1//… · 클라이언트 비밀 GOCSPX-…)과
//       Cloudflare 토큰 모양(2026 새 형식 cfut_… 사용자 · cfat_… 계정 · cfk_… 전역 키 — 접두어 + 40자 + 검사값)과
//       메일 비밀값 이름에 값이 붙은 모양(GMAIL_…: "…" · CF_BROWSER_TOKEN: "…")
//
// ⚠️ (b)(c) 는 dist/server/.dev.vars 를 보지 않는다(wrangler dev 전용 비밀값 파일 — 배포되지 않는다).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mailModeAtBuild } from '../src/lib/mail-mode.js';

const MARKER_RE = /MAIL_MODE_(?:LIVE|TEST)/g;
// 표식·주소·비밀값 이름도 조립해서 쓴다 — 이 파일 자체가 검사에 걸리지 않게(src 밖이지만 같은 규칙).
const LIVE = ['MAIL', 'MODE', 'LIVE'].join('_');
export const GMAIL_HOSTS = [['gmail', 'googleapis', 'com'].join('.'), ['oauth2', 'googleapis', 'com'].join('.')];
export const PDF_PATHS = [['browser', 'rendering'].join('-') + '/pdf', ['browser', 'run'].join('-') + '/pdf'];
const DEFINE = ['__VANAM', 'MAIL', 'MODE__'].join('_');
const GMAIL_KEYS = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
const PDF_KEYS = ['CF_BROWSER_TOKEN', 'CF_ACCOUNT_ID'];
// Google 비밀값 모양 — 새로고침 토큰은 '1//', 클라이언트 비밀은 'GOCSPX-' 로 시작한다.
// Cloudflare 토큰 모양 — 2026 새 형식은 'cfut_'(사용자) · 'cfat_'(계정) · 'cfk_'(전역 키) + 40자 + 검사값(예전 40자 토큰은 모양으로 가릴 수 없다).
// 그리고 비밀값 이름에 값이 붙은 모양(빌드가 .env 값을 객체로 박아 넣은 흔적)
export const SECRET_RES = [
  /\b1\/\/0[0-9A-Za-z_-]{20,}/,
  /GOCSPX-[0-9A-Za-z_-]{10,}/,
  /\bcf(?:ut|at|k)_[0-9A-Za-z_-]{40,}/,
  /\b(?:GMAIL_CLIENT_ID|GMAIL_CLIENT_SECRET|GMAIL_REFRESH_TOKEN|CF_ACCOUNT_ID|CF_BROWSER_TOKEN)["']?\s*:\s*["'`][^"'`\s]+["'`]/,
];
// 메일 경로 파일 — 빌드 환경 변수 문자열을 두지 않는다
const MAIL_PATH_FILES = ['lib/mail-send.ts', 'lib/doc-pdf.ts', 'lib/quote-ack-run.ts', 'lib/mail-mime.js', 'lib/quote-ack.js',
  'lib/mail-mode.js', 'pages/api/admin/quote-mail.ts'];
const IMPORT_META_ENV = ['import', 'meta', 'env'].join('.');
const DEV_VARS = '.dev.vars';

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** (a) 소스 검사. @param {string} srcDir @returns {string[]} 위반 목록 */
export function checkSource(srcDir) {
  const errs = [];
  for (const f of walk(srcDir)) {
    const rel = relative(srcDir, f).split(sep).join('/');
    const text = readFileSync(f, 'utf8');
    for (const k of GMAIL_KEYS) {
      if (text.includes(k) && rel !== 'lib/mail-send.ts') errs.push(`src/${rel}: ${k} 는 src/lib/mail-send.ts 에서만 읽는다`);
    }
    for (const h of GMAIL_HOSTS) {
      if (text.includes(h) && rel !== 'lib/mail-send.ts') errs.push(`src/${rel}: ${h} 주소는 src/lib/mail-send.ts 에만 — 메일은 그 통로로만 보낸다`);
    }
    for (const k of PDF_KEYS) {
      if (text.includes(k) && rel !== 'lib/doc-pdf.ts') errs.push(`src/${rel}: ${k} 는 src/lib/doc-pdf.ts 에서만 읽는다`);
    }
    for (const pp of PDF_PATHS) {
      if (text.includes(pp) && rel !== 'lib/doc-pdf.ts') errs.push(`src/${rel}: PDF 만들기 주소(${pp})는 src/lib/doc-pdf.ts 에만`);
    }
    if (/\bbuildMime\b/.test(text) && rel !== 'lib/mail-send.ts' && rel !== 'lib/mail-mime.js') {
      errs.push(`src/${rel}: 메일 원문(buildMime)은 src/lib/mail-send.ts 에서만 만든다 — 발송 통로는 하나`);
    }
    if (MAIL_PATH_FILES.includes(rel) && text.includes(IMPORT_META_ENV)) {
      errs.push(`src/${rel}: 메일 경로 파일에 ${IMPORT_META_ENV} 글자가 있다(주석 포함) — 비밀값이 번들에 박히는 길`);
    }
    if (text.includes(DEFINE) && rel !== 'lib/mail-send.ts') errs.push(`src/${rel}: ${DEFINE} 는 src/lib/mail-send.ts 에서만 — 번들 표식이 둘이 되면 판정할 수 없다`);
    if (text.includes(LIVE) && rel !== 'lib/mail-mode.js') errs.push(`src/${rel}: 운영 표식(${LIVE})은 src/lib/mail-mode.js 에만`);
    for (const re of SECRET_RES) if (re.test(text)) errs.push(`src/${rel}: 비밀값(Google·Cloudflare) 모양의 문자열이 소스에 있다`);
  }
  return errs;
}

/** dist/server 를 훑는다(.dev.vars 제외). @param {string} dir */
export function scanDist(dir) {
  const markers = [];
  const secretFiles = [];
  for (const f of walk(dir)) {
    if (f.endsWith(sep + DEV_VARS) || f === DEV_VARS) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(MARKER_RE)) markers.push({ file: relative(dir, f), value: m[0] });
    if (SECRET_RES.some((re) => re.test(text))) secretFiles.push(relative(dir, f));
  }
  return { markers, secretFiles };
}

/**
 * (b)(c) 판정. @param {ReturnType<typeof scanDist>} scan
 * @param {Record<string, string|undefined>} env @returns {string[]} 위반 목록
 */
export function judgeDist(scan, env) {
  const errs = [];
  const expected = mailModeAtBuild(env);
  const ctx = `기대값 ${expected} · WORKERS_CI=${env.WORKERS_CI ?? '(없음)'} · WORKERS_CI_BRANCH=${env.WORKERS_CI_BRANCH ?? '(없음)'}`;
  if (scan.markers.length !== 1) {
    errs.push(`dist/server 의 메일 표식이 ${scan.markers.length}개다(정확히 1개여야 한다): ` +
      `${scan.markers.map((m) => `${m.file}=${m.value}`).join(', ') || '없음'} — ${ctx}`);
  } else if (scan.markers[0].value !== expected) {
    errs.push(`dist/server 의 메일 표식이 다르다: 실제값 ${scan.markers[0].value} (${scan.markers[0].file}) — ${ctx}`);
  }
  for (const f of scan.secretFiles) errs.push(`dist/server/${f}: 비밀값(Google·Cloudflare) 모양의 문자열이 번들에 박혀 있다 — 비밀값은 런타임 env 로만`);
  return errs;
}

// ── 실행 ────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errs = checkSource('src');
  const DIST = 'dist/server';
  let scan = null;
  if (!existsSync(DIST)) errs.push('dist/server 가 없다 — npm run build 뒤에 실행하세요');
  else {
    scan = scanDist(DIST);
    errs.push(...judgeDist(scan, process.env));
  }
  if (errs.length) {
    for (const e of errs) console.error('  ✗', e);
    console.error(`\n고객 메일 게이트 실패 — ${errs.length}건.`);
    process.exit(1);
  }
  const mode = scan.markers[0].value;
  console.log(`✓ 고객 메일 게이트 — ${mode === LIVE ? '운영(고객 주소로 발송)' : '테스트(@vanam.co.kr 주소로만)'}(${mode}) · 번들 표식 1개 · 비밀값 0건 · 소스 발송 경로 1곳`);
}
