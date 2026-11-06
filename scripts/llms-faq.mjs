// llms.txt · llms-full.txt 의 FAQ 섹션을 빌드 결과(dist/client)에 채운다. npm run build 가 astro build 뒤에 실행한다.
//   node scripts/llms-faq.mjs [--dist <dir>]     (기본 dist/client)
//
// public/llms.txt · public/llms-full.txt 의 "## FAQ" 섹션은 자리만 잡아 둔 것이다(색인 주소 한 줄).
// 이 스크립트가 그 섹션을 src/data/faq.json(확정 FAQ 38개)에서 만든 목록으로 바꾼다:
//   llms.txt      — 색인 페이지 주소 + EN 질문 38개와 답 위치 주소
//   llms-full.txt — 색인 페이지 주소 + EN·KO 질문 38개씩과 답 위치 주소
// 답은 싣지 않는다(각 질문의 답은 사이트에서 한 곳에만 있다). 섹션 밖의 내용은 한 글자도 건드리지 않는다.
// 목록이 데이터와 같은지는 scripts/check-structured-data.mjs 가 검사한다.
import fs from 'node:fs';
import path from 'node:path';
import { loadFaq, llmsFaqSection, replaceFaqSection } from './lib/faq-data.mjs';

const i = process.argv.indexOf('--dist');
const dist = i >= 0 ? process.argv[i + 1] : 'dist/client';
const data = loadFaq();
for (const [file, kind] of [['llms.txt', 'llms'], ['llms-full.txt', 'full']]) {
  const f = path.join(dist, file);
  if (!fs.existsSync(f)) { console.error(`llms-faq: ${f} 가 없다 — astro build 뒤에 실행한다`); process.exit(1); }
  const before = fs.readFileSync(f, 'utf8');
  let after;
  try { after = replaceFaqSection(before, llmsFaqSection(kind, data)); }
  catch (e) { console.error(`llms-faq: ${f} — ${e.message}`); process.exit(1); }
  fs.writeFileSync(f, after);
}
console.log(`llms-faq: FAQ 섹션 생성 — llms.txt(EN ${data.items.length}개) · llms-full.txt(EN·KO ${data.items.length}개씩)`);
