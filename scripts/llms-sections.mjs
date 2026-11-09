// llms.txt · llms-full.txt 의 생성 섹션을 빌드 결과(dist/client)에 채운다. npm run build 가 astro build 뒤에 실행한다.
//   node scripts/llms-sections.mjs [--dist <dir>]     (기본 dist/client)
//
// public/llms.txt · public/llms-full.txt 의 아래 섹션은 자리만 잡아 둔 것이다(안내 한 줄). 이 스크립트가 데이터에서 만든 내용으로 바꾼다:
//   "## FAQ"              llms.txt      — 답 원문이 llms-full.txt 에 있다는 안내 + 색인 주소 + EN 질문 38개와 답 위치 주소
//                         llms-full.txt — 38개 항목의 ID · 답 위치(EN·KO) · EN 질문·답 · KO 질문·답 원문 (src/data/faq.json, 한 글자도 바꾸지 않는다)
//   "## Materials library" llms-full.txt — 소재 57종의 이름·화학식·분류·증착 방식·EN·KO 주소와 상세 페이지에 보이는 사양 줄 (src/content/materials/*.json)
// 섹션 밖의 내용은 한 글자도 건드리지 않는다. 결과가 데이터와 같은지는 scripts/check-llms.mjs · scripts/check-structured-data.mjs 가 검사한다.
import fs from 'node:fs';
import path from 'node:path';
import { loadFaq, llmsFaqSection, replaceSection, FAQ_HEADING } from './lib/faq-data.mjs';
import { loadMaterials, llmsMaterialsSection, MATERIALS_HEADING } from './lib/materials-data.mjs';

const i = process.argv.indexOf('--dist');
const dist = i >= 0 ? process.argv[i + 1] : 'dist/client';
const faq = loadFaq();
const mats = loadMaterials();
const jobs = [
  ['llms.txt', [[FAQ_HEADING, llmsFaqSection('llms', faq)]]],
  ['llms-full.txt', [[FAQ_HEADING, llmsFaqSection('full', faq)], [MATERIALS_HEADING, llmsMaterialsSection(mats)]]],
];
for (const [file, sections] of jobs) {
  const f = path.join(dist, file);
  if (!fs.existsSync(f)) { console.error(`llms-sections: ${f} 가 없다 — astro build 뒤에 실행한다`); process.exit(1); }
  let text = fs.readFileSync(f, 'utf8');
  for (const [heading, section] of sections) {
    try { text = replaceSection(text, heading, section); }
    catch (e) { console.error(`llms-sections: ${f} — ${e.message}`); process.exit(1); }
  }
  fs.writeFileSync(f, text);
}
console.log(`llms-sections: llms.txt(FAQ EN ${faq.items.length}개) · llms-full.txt(FAQ EN·KO ${faq.items.length}개 답 포함 · 소재 ${mats.length}종)`);
