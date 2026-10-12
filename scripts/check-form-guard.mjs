// scripts/check-form-guard.mjs — 고객 폼 검사 재발 방지 점검 (2026-10-12 운영 사고 후)
//
// 사고: 견적 폼에서 기판 전달 '택배'를 골랐다가 다른 방식으로 바꾸면 [견적 요청하기]가 영영 막혔다.
//   setCustomValidity 로 붙인 '틀림 표시'가 숨은 칸에 남았고(1초마다 checkValidity 가 다시 붙임),
//   제출 검사가 숨은 칸을 골라 화면 구석에 말풍선을 띄웠다. 결제 페이지는 숨겼다 다시 보인 칸이 잠긴 채 남았다.
//   규칙은 src/lib/form-check.ts 한 곳에 모았다. 이 점검은 그 규칙을 우회하는 코드가 다시 들어오는 것을 막는다.
//
//   1) checkValidity()/reportValidity() 호출 금지 — invalid 이벤트가 표시를 다시 붙인다(판정은 form-check 의 fieldIssue)
//   2) setCustomValidity 는 form-check.ts · BaseLayout.astro 에서만
//   3) 모든 <form> 에 method="post" — 스크립트가 못 뜬 채 제출돼도 개인정보가 주소창(GET)에 실리지 않게
//   4) 전화 제출값은 applyTelValues 로만 — 옛 normalizeTelInputs(입력칸을 바꾸고 번호를 무조건 +82 로 바꿈) 금지
//   5) 서버 이메일 검사는 email-rule.js 로만 — api 파일에 이메일 정규식을 직접 쓰지 않는다(화면과 어긋나지 않게)
//   6) 견적·주문·문의 폼은 form-check 를 쓴다
//   7) 결제 페이지의 숨김 잠금은 다시 보일 때 풀린다(data-auto-disabled 를 붙이고 푸는 코드가 있다)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const bad = [];
let checked = 0;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(astro|ts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

/** 주석을 뺀 코드 줄(대략) — 줄 머리 주석과 줄 끝 ' // ' 주석을 뺀다(주소 속 // 는 남긴다) */
function codeLines(text) {
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) return '';
    const i = line.search(/(^|[^:])\/\/\s/);
    return i >= 0 ? line.slice(0, i + 1) : line;
  });
}

const files = walk(SRC);
for (const f of files) {
  const rel = relative(ROOT, f);
  const text = readFileSync(f, 'utf8');
  const lines = codeLines(text);
  lines.forEach((l, i) => {
    if (/\.(checkValidity|reportValidity)\s*\(/.test(l)) bad.push(`${rel}:${i + 1} checkValidity/reportValidity 호출 — form-check 의 fieldIssue/firstFieldIssue 를 쓴다`);
    if (/setCustomValidity\s*\(/.test(l) && !/src\/lib\/form-check\.ts$|src\/layouts\/BaseLayout\.astro$/.test(rel))
      bad.push(`${rel}:${i + 1} setCustomValidity — form-check.ts·BaseLayout.astro 밖에서 쓰지 않는다`);
    if (/normalizeTelInputs/.test(l)) bad.push(`${rel}:${i + 1} normalizeTelInputs — applyTelValues 로 바꾼다`);
    const m = l.match(/<form\b[^>]*>/);
    if (m && !/\bmethod="post"/.test(m[0])) bad.push(`${rel}:${i + 1} <form> 에 method="post" 가 없다`);
  });
  checked++;
}

// 5) 서버 이메일 규칙
for (const api of ['src/pages/api/inquiry.ts', 'src/pages/api/order.ts']) {
  const t = readFileSync(join(ROOT, api), 'utf8');
  if (!/from '\.\.\/\.\.\/lib\/email-rule\.js'/.test(t)) bad.push(`${api} — email-rule.js 를 import 하지 않는다`);
  if (/\[\^\\s@\]\+@/.test(codeLines(t).join('\n'))) bad.push(`${api} — 이메일 정규식을 직접 쓴다(email-rule.js 의 isEmail 로)`);
}

// 6) 폼이 공통 규칙을 쓴다
for (const comp of ['src/components/QuoteForm.astro', 'src/components/pages/Checkout.astro', 'src/components/pages/Contact.astro']) {
  const t = readFileSync(join(ROOT, comp), 'utf8');
  if (!/from '(\.\.\/)+lib\/form-check'/.test(t)) bad.push(`${comp} — form-check 를 쓰지 않는다`);
}

// 7) 결제 페이지 숨김 잠금 해제
{
  const t = readFileSync(join(ROOT, 'src/components/pages/Checkout.astro'), 'utf8');
  if (!/dataset\.autoDisabled\s*=\s*'1'/.test(t)) bad.push('Checkout.astro — 숨긴 칸을 잠글 때 data-auto-disabled 를 붙이지 않는다(다시 보일 때 못 푼다)');
  if (!/autoDisabled === '1'\) \{ f\.disabled = false/.test(t)) bad.push('Checkout.astro — 다시 보인 칸의 잠금을 푸는 코드가 없다');
  const calls = (t.match(/syncHiddenRequired\(\)/g) ?? []).length;
  if (calls < 4) bad.push(`Checkout.astro — syncHiddenRequired() 호출이 ${calls}곳뿐(국가·수령인·세금계산서·제출에서 불러야 한다)`);
}

if (bad.length) {
  console.error('✗ 폼 검사 재발 방지 점검 실패:');
  for (const b of bad) console.error('  - ' + b);
  process.exit(1);
}
console.log(`✓ 폼 검사 재발 방지 점검 — 파일 ${checked}개, 위반 0`);
