// scripts/check-ui-tokens.mjs — 공통 UI 클래스 재드리프트 방지
//
// 왜 있는가: 같은 역할의 버튼·카드·컨테이너가 파일마다 조금씩 다른 클래스 조합으로
// 적혀 있었다(주 버튼만 rounded-lg/full/md · px-4·5·6·7 혼재, 카드 배경 0.03/0.035 공존).
// global.css 의 .v-btn / .v-btn-sm / .v-btn-ghost / .v-card / .v-wrap / .v-h2 로 통일했으니,
// 새 화면을 만들 때 다시 하드코딩하면 여기서 막는다.
//
// 예외를 둔 곳은 아래 EXEMPT 에 이유와 함께 적는다. 이유 없는 예외는 만들지 않는다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.astro')) files.push(p);
  }
})('src');

// 관리자 화면은 사내 전용이라 공개 페이지와 디자인을 맞출 이유가 없다.
const isAdmin = (f) => f.includes('/pages/admin/');

const RULES = [
  {
    name: '본문 컨테이너',
    re: /mx-auto max-w-6xl px-6/,
    use: 'v-wrap',
    exempt: () => false,
  },
  {
    name: '카드 배경 편차',
    re: /bg-ink\/\[0\.035\]/,
    use: 'v-card (bg-ink/[0.03])',
    exempt: () => false,
  },
  {
    name: '정보 카드',
    re: /rounded-2xl border border-ink\/10 bg-ink\/\[0\.03\]/,
    use: 'v-card',
    exempt: () => false,
  },
  {
    name: '주 버튼',
    re: /rounded-(?:lg|md|full|xl) bg-brand px-/,
    use: 'v-btn / v-btn-sm',
    // 홈 히어로만 예외 — 어두운 영상 위 전용 알약 버튼(본문 버튼과 형태를 맞추면 어색하다).
    exempt: (f) => f.endsWith('/Home.astro'),
  },
  {
    name: '보조(외곽선) 버튼',
    re: /rounded-lg border border-ink\/15 px-\d[^"]*text-ink\/(?:70|80) transition hover:border-/,
    use: 'v-btn-ghost',
    exempt: () => false,
  },
];

let bad = 0;
for (const f of files) {
  if (isAdmin(f)) continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  for (const r of RULES) {
    if (r.exempt(f)) continue;
    lines.forEach((line, i) => {
      if (r.re.test(line)) {
        console.error(`  ✗ ${f}:${i + 1} — ${r.name} 하드코딩. \`${r.use}\` 를 쓰세요.`);
        bad++;
      }
    });
  }
}

if (bad) {
  console.error(`\nUI 클래스 검사 실패 — ${bad}건. global.css 의 공통 클래스를 사용하세요.`);
  process.exit(1);
}
console.log('✓ UI 클래스 검사 통과 — 공통 클래스 사용');
