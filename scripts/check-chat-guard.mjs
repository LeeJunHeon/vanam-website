// scripts/check-chat-guard.mjs — 구글챗 알림 빌드 게이트
//
// 왜 있는가: 맥미니에서 빌드한 번들로 로컬 테스트를 하면 실제 채팅방에 알림이 갔다
// (.env 의 웹훅이 import.meta.env 폴백으로 번들에 박히고, 어댑터가 .env 를 .dev.vars 로 복사).
// 이제 켜짐/꺼짐은 빌드 종류가 정한다(src/lib/chat-mode.js). 이 게이트는 그 약속이 지켜졌는지 본다.
//
//   (a) 소스: GOOGLE_CHAT_WEBHOOK 은 chat-send.ts 에만 · 구글챗 웹훅 도메인은 어디에도 없음 ·
//       켜짐 표식 문자열은 chat-mode.js 에만
//   (b) 번들: dist/server 안의 표식이 정확히 하나이고, 이 환경에서 기대하는 값과 같다
//       → Cloudflare main 빌드가 알림 꺼진 채 배포되는 것도, 로컬 빌드가 켜지는 것도 막는다.
//   (c) 번들: dist/server 에 구글챗 웹훅 도메인 0건 (웹훅은 런타임 비밀값으로만)
//
// ⚠️ (b)(c) 는 dist/server/.dev.vars 를 보지 않는다. 그 파일은 어댑터가 로컬 .env 를 복사해 둔
//    wrangler dev 전용 비밀값 파일이라 배포되지 않는다(코드가 아니다). 로컬 실행 때는
//    scripts/local-run.mjs 가 이 파일을 빈 값으로 덮어쓰고 다시 읽어 확인한다.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatModeAtBuild } from '../src/lib/chat-mode.js';

const MARKER_RE = /CHAT_MODE_(?:ON|OFF)/g;
// 도메인도 조립해서 쓴다 — 이 저장소의 추가 줄에 웹훅 주소 조각이 없는지 검사할 때 걸리지 않도록.
export const WEBHOOK_HOST = ['chat', 'googleapis', 'com'].join('.');
const ON = ['CHAT', 'MODE', 'ON'].join('_'); // 이 파일도 src 밖이지만, 표식 문자열을 그대로 적지 않는다
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
    if (text.includes('GOOGLE_CHAT_WEBHOOK') && rel !== 'lib/chat-send.ts')
      errs.push(`src/${rel}: GOOGLE_CHAT_WEBHOOK 은 src/lib/chat-send.ts 에서만 읽는다`);
    if (text.includes(WEBHOOK_HOST))
      errs.push(`src/${rel}: ${WEBHOOK_HOST} 주소가 소스에 있다 — 웹훅은 런타임 비밀값으로만`);
    if (text.includes(ON) && rel !== 'lib/chat-mode.js')
      errs.push(`src/${rel}: 켜짐 표식(${ON})은 src/lib/chat-mode.js 에만 — 런타임 파일에 있으면 번들 판정이 불가능해진다`);
  }
  return errs;
}

/** dist/server 를 훑는다(.dev.vars 제외). @param {string} dir */
export function scanDist(dir) {
  const markers = [];
  const webhookFiles = [];
  for (const f of walk(dir)) {
    if (f.endsWith(sep + DEV_VARS) || f === DEV_VARS) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(MARKER_RE)) markers.push({ file: relative(dir, f), value: m[0] });
    if (text.includes(WEBHOOK_HOST)) webhookFiles.push(relative(dir, f));
  }
  return { markers, webhookFiles };
}

/**
 * (b)(c) 판정. @param {ReturnType<typeof scanDist>} scan
 * @param {Record<string, string|undefined>} env @returns {string[]} 위반 목록
 */
export function judgeDist(scan, env) {
  const errs = [];
  const expected = chatModeAtBuild(env);
  const ctx = `기대값 ${expected} · WORKERS_CI=${env.WORKERS_CI ?? '(없음)'} · WORKERS_CI_BRANCH=${env.WORKERS_CI_BRANCH ?? '(없음)'}`;
  if (scan.markers.length !== 1) {
    errs.push(`dist/server 의 알림 표식이 ${scan.markers.length}개다(정확히 1개여야 한다): ` +
      `${scan.markers.map((m) => `${m.file}=${m.value}`).join(', ') || '없음'} — ${ctx}`);
  } else if (scan.markers[0].value !== expected) {
    errs.push(`dist/server 의 알림 표식이 다르다: 실제값 ${scan.markers[0].value} (${scan.markers[0].file}) — ${ctx}`);
  }
  for (const f of scan.webhookFiles) errs.push(`dist/server/${f}: ${WEBHOOK_HOST} 주소가 번들에 박혀 있다 — 웹훅은 런타임 비밀값으로만`);
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
    console.error(`\n구글챗 알림 게이트 실패 — ${errs.length}건.`);
    process.exit(1);
  }
  const mode = scan.markers[0].value;
  console.log(`✓ 구글챗 알림 게이트 — ${mode === ON ? '켜짐' : '꺼짐'}(${mode}) · 번들 표식 1개 · 웹훅 주소 0건 · 소스 발송 경로 1곳`);
}
