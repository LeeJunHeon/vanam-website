// FAQ 데이터(src/data/faq.json) — node 스크립트용 읽기·llms 목록 생성.
//   쓰는 곳: scripts/llms-faq.mjs(빌드 뒤 llms 의 FAQ 섹션 생성) · scripts/check-structured-data.mjs(게이트)
//   사이트 쪽(Astro)은 src/lib/faq.ts 가 같은 파일을 읽는다. 문구는 확정본이라 어디서도 고치지 않는다.
import fs from 'node:fs';

export const SITE = 'https://vanam.co.kr';
const DATA_FILE = new URL('../../src/data/faq.json', import.meta.url);

/** { source, items: [{ id, en{q,a}, ko{q,a}, page, group, anchor }], related } */
export const loadFaq = () => JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

const prefix = (loc) => (loc === 'ko' ? '/ko' : '');
/** 답 위치의 사이트 내부 경로 — /ko/contact/#faq-e01 */
export const faqPath = (item, loc) => `${prefix(loc)}${item.page}#${item.anchor}`;
/** 답 위치의 전체 주소 */
export const faqUrl = (item, loc) => SITE + faqPath(item, loc);
export const faqIndexPath = (loc) => `${prefix(loc)}/faq/`;

const HEADING = '## FAQ';
// 마크다운 링크 글자 안의 대괄호만 이스케이프한다(질문 글자 자체는 그대로).
const mdText = (s) => s.replace(/([\[\]])/g, '\\$1');

/**
 * llms 파일의 FAQ 섹션(제목 줄부터, 끝에 빈 줄 하나).
 *   kind 'llms' → llms.txt: 색인 주소 + EN 질문 38개와 답 위치
 *   kind 'full' → llms-full.txt: 색인 주소 + EN·KO 질문 38개씩과 답 위치
 */
export function llmsFaqSection(kind, data = loadFaq()) {
  const n = data.items.length;
  const lines = [HEADING];
  lines.push(`- [FAQ index](${SITE}${faqIndexPath('en')}) · [한국어](${SITE}${faqIndexPath('ko')}): all ${n} questions; each links to the page section that holds its answer.`);
  for (const it of data.items) {
    lines.push(`- [${mdText(it.en.q)}](${faqUrl(it, 'en')})`);
    if (kind === 'full') lines.push(`- [${mdText(it.ko.q)}](${faqUrl(it, 'ko')})`);
  }
  return lines.join('\n') + '\n\n';
}

/** 글에서 FAQ 섹션의 범위 — "## FAQ" 줄부터 다음 "## " 줄 앞(또는 글 끝)까지. 섹션이 정확히 하나여야 한다. */
export function faqSectionRange(text) {
  const starts = [...text.matchAll(/^## FAQ[ \t]*$/gm)];
  if (starts.length !== 1) throw new Error(`"${HEADING}" 제목 줄이 ${starts.length}개다(정확히 1개여야 한다)`);
  const start = starts[0].index;
  const next = /^## /m.exec(text.slice(start + HEADING.length));
  const end = next ? start + HEADING.length + next.index : text.length;
  return { start, end };
}

/** 글의 FAQ 섹션만 바꾼다. 나머지는 한 글자도 건드리지 않는다. */
export function replaceFaqSection(text, section) {
  const { start, end } = faqSectionRange(text);
  const tail = text.slice(end);
  return text.slice(0, start) + (tail ? section : section.replace(/\n+$/, '\n')) + tail;
}
