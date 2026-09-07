// scripts/check-material-values.mjs — 견적 폼 소재 value 불변 게이트 (0907b, 재발 방지 가드레일)
//
// 왜 있는가: 견적 폼의 Sputter/ALD 소재 목록은 이제 손으로 적지 않고 소재 라이브러리
// (src/content/materials/*.json)의 formula 에서 파생한다(src/lib/processes.ts).
// 그런데 그 value 문자열은 이미 제출 payload·D1(inquiries)·구글챗 알림·조회 화면에
// 그대로 저장돼 있다. 파생 규칙이 한 글자라도 다르게 만들면
//   ① 과거 데이터와 새 데이터의 소재 표기가 갈리고
//   ② 라이브러리 CTA → 견적 폼 프리필이 "조용히 무시"로 끝난다(증상 없이 기능만 사라짐).
// 대표 사례: SiNₓ 는 정규화하면 "SiNx" 지만 기존 value 는 "SiN" 이다.
// → 파생 규칙(material-value.js)이 기존 value 를 전부 그대로 재현하는지 빌드 전에 못 박는다.
//
// 검사 4종:
//   ① BASELINE(개편 직전 하드코딩 목록)의 모든 value 가 파생 결과에 바이트 단위로 존재
//   ② 라이브러리 소재 중 옵션에 못 들어간 것 0
//   ③ 파생 value 중복 없음 (같은 방식 안에서)
//   ④ VALUE_EXCEPTIONS 에 죽은 항목 없음 (정규화만으로 충분한데 예외로 적어둔 것)
// 사용: node scripts/check-material-values.mjs [--dump]   (--dump = 파생 옵션 전수 표 출력)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// 파생에 쓰는 함수 그대로 가져온다 — 검증이 별도 규칙을 다시 구현하면 게이트가 아니라 사본이 된다.
import { materialValue, materialSortKey, VALUE_EXCEPTIONS } from '../src/lib/material-value.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAT_DIR = join(ROOT, 'src/content/materials');

let bad = 0;
const fail = (msg) => { console.error('  ✗', msg); bad++; };

// ── BASELINE: 0907b 개편 직전 processes.ts 에 손으로 적혀 있던 증착 물질 목록 ──────
// (커밋 2aa08ef 기준. 파생이 이 목록을 100% 재현해야 한다. 줄이지도 바꾸지도 말 것 —
//  이 배열은 "이미 세상에 나간 문자열"의 기록이다.)
const BASELINE = {
  Sputter: [
    'Al', 'AlN', 'AlScN', 'Au', 'Bi', 'Cr', 'Hf', 'HfO2', 'IGZO', 'ITO',
    'Mo', 'Pt', 'Sc', 'Si', 'SiN', 'SiO2', 'Ta2O5', 'Ti', 'TiN', 'TiO2',
    'VO2', 'W', 'ZnO',
  ],
  ALD: ['Al2O3', 'HfO2', 'TiO2'],
};
// 폼 공정 이름 ↔ 라이브러리 system (processes.ts 의 SYSTEM_TO_PROCESS 와 같은 대응)
const SYSTEMS = { Sputter: 'sputter', ALD: 'ald' };

// ── 라이브러리 적재 (Astro 없이 파일에서 직접) ────────────────────────────
const library = readdirSync(MAT_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ id: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(MAT_DIR, f), 'utf8')) }));

// processes.ts 의 fromLibrary() 와 같은 순서·중복 규칙
function derive(system) {
  const seen = new Set();
  const out = [];
  for (const m of library) {
    if (m.system !== system) continue;
    const value = materialValue(m.formula);
    if (seen.has(value)) { out.push({ id: m.id, formula: m.formula, value, category: m.category, dup: true }); continue; }
    seen.add(value);
    out.push({ id: m.id, formula: m.formula, value, category: m.category, dup: false });
  }
  out.sort((a, b) => materialSortKey(a.value).localeCompare(materialSortKey(b.value), 'en'));
  return out;
}

const derived = Object.fromEntries(Object.entries(SYSTEMS).map(([proc, sys]) => [proc, derive(sys)]));

console.log('· 견적 폼 소재 value 게이트');

// ① 기존 value 전수 일치
for (const [proc, values] of Object.entries(BASELINE)) {
  const have = new Set(derived[proc].filter((m) => !m.dup).map((m) => m.value));
  const missing = values.filter((v) => !have.has(v));
  if (missing.length) {
    fail(`${proc}: 기존 value 가 파생되지 않음 → ${missing.join(', ')}`
      + ` (material-value.js 의 VALUE_EXCEPTIONS 를 확인할 것)`);
  } else {
    console.log(`  ✓ ${proc}: 기존 value ${values.length}종 전부 일치`);
  }
}

// ② 라이브러리 소재 중 옵션 누락
const optioned = new Set(Object.values(derived).flat().filter((m) => !m.dup).map((m) => m.id));
// 폼에 대응 공정이 없는 system 이 라이브러리에 생기면(예: evaporator 를 별도 system 으로 추가) 여기서 멈춘다.
const orphanSystems = [...new Set(library.map((m) => m.system))].filter((s) => !Object.values(SYSTEMS).includes(s));
if (orphanSystems.length) fail(`라이브러리에 대응 폼 공정이 없는 system: ${orphanSystems.join(', ')}`);
const notInOptions = library.filter((m) => !optioned.has(m.id));
if (notInOptions.length) {
  fail(`옵션에 없는 라이브러리 소재 ${notInOptions.length}종: `
    + notInOptions.map((m) => `${m.id}/${m.formula}`).join(', '));
} else {
  console.log(`  ✓ 라이브러리 ${library.length}종 전부 옵션에 포함 (누락 0)`);
}

// ③ 같은 방식 안 중복
for (const [proc, list] of Object.entries(derived)) {
  const dups = list.filter((m) => m.dup);
  if (dups.length) fail(`${proc}: 화학식 중복 → ${dups.map((m) => `${m.id}/${m.formula}`).join(', ')}`);
}

// ④ 죽은 예외 (라이브러리 어디에서도 그 정규화 결과가 나오지 않는 예외 항목)
const normalized = new Set(library.map((m) => m.formula.replace(/[₀-₉ₓ]/g, (c) =>
  ({ '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', 'ₓ': 'x' })[c] ?? c)));
const deadExceptions = Object.keys(VALUE_EXCEPTIONS).filter((k) => !normalized.has(k));
for (const key of deadExceptions) fail(`쓰이지 않는 예외: VALUE_EXCEPTIONS['${key}'] — 대응 소재가 라이브러리에 없다`);
if (!deadExceptions.length) console.log(`  ✓ 예외표 ${Object.keys(VALUE_EXCEPTIONS).length}건 전부 실제 사용`);

// ── --dump: 파생 옵션 전수 표 ────────────────────────────────────
if (process.argv.includes('--dump')) {
  for (const [proc, list] of Object.entries(derived)) {
    const byCat = {};
    for (const m of list) (byCat[m.category] ??= []).push(m);
    console.log(`\n[${proc}] ${list.length}종`);
    for (const [cat, items] of Object.entries(byCat)) {
      console.log(`  ${cat} (${items.length}): ${items.map((m) => m.value).join(', ')}`);
    }
    const changed = list.filter((m) => m.value !== m.formula);
    console.log(`  정규화로 표기가 바뀐 것 ${changed.length}종: `
      + changed.map((m) => `${m.formula}→${m.value}`).join(', '));
    const added = list.filter((m) => !(BASELINE[proc] ?? []).includes(m.value));
    console.log(`  기존 목록에 없던 신규 ${added.length}종: ${added.map((m) => m.value).join(', ')}`);
  }
}

if (bad) {
  console.error(`\n소재 value 게이트 실패: ${bad}건 — 파생 규칙이 기존 value 를 바꾸고 있다. 멈춘다.`);
  process.exit(1);
}
console.log('· 소재 value 게이트 통과');
