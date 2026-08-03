// scripts/verify-design.mjs — 빌드 산출물 디자인 일관성 검증 (재발 방지 가드레일)
// 사용: npm run verify  (빌드 후 실행)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist/client';
const ZEBRA_PAGES = ['(home)', 'ko', 'technology', 'ko/technology', 'materials', 'ko/materials']; // 0165: About→Home 통합으로 홈이 지브라 페이지

const pages = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name === 'index.html') pages.push(p);
  }
})(DIST);

let errors = 0;
const fail = (msg) => { console.error('  ✗', msg); errors++; };

for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  const rel = file.replace(DIST + '/', '').replace('/index.html', '') || '(home)';

  // 1) viewport 메타 — 모바일 레이아웃 필수
  if (!html.includes('name="viewport"')) fail(`${rel}: viewport 메타 누락`);

  const mainMatch = html.split('<main');
  if (mainMatch.length < 2) continue;
  const main = mainMatch[1].split('</main>')[0];
  const secs = [...main.matchAll(/<section([^>]*)>/g)].map((m) => m[1]);

  // 2) zebra 페이지: v-zebra 클래스 + 섹션 레벨 배경/구분선 하드코딩 금지
  if (ZEBRA_PAGES.includes(rel)) {
    if (!html.includes('v-zebra')) fail(`${rel}: zebra 페이지인데 body에 v-zebra 없음`);
    secs.forEach((attrs, i) => {
      if (attrs.includes('bg-ink/[0.02]') || attrs.includes('border-y border-ink/10'))
        fail(`${rel}: 섹션 ${i + 1}에 배경/구분선 하드코딩 — zebra 규칙 위반`);
    });
  }

  // 3) 모든 페이지: 수동 줄무늬가 연속 같은 회색이 되는 실수 감지
  for (let i = 1; i < secs.length; i++) {
    const g1 = secs[i - 1].includes('bg-ink/[0.02]');
    const g2 = secs[i].includes('bg-ink/[0.02]');
    if (g1 && g2) fail(`${rel}: 섹션 ${i}·${i + 1} 연속 회색 배경`);
  }
}

if (errors) {
  console.error(`\n검증 실패 — ${errors}건. 위 항목을 고친 뒤 다시 빌드하세요.`);
  process.exit(1);
}
console.log(`✓ verify passed — ${pages.length}개 페이지 검증 (viewport · zebra 규칙 · 연속 배경)`);
