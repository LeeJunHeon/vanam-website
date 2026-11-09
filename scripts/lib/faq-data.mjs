// FAQ 데이터(src/data/faq.json) — node 스크립트용 읽기·llms FAQ 섹션 생성·섹션 치환 도구.
//   쓰는 곳: scripts/llms-sections.mjs(빌드 뒤 llms 의 FAQ·소재 섹션 생성) · scripts/check-structured-data.mjs · scripts/check-llms.mjs(게이트)
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
export const FAQ_HEADING = HEADING;
export const LLMS_FULL_URL = `${SITE}/llms-full.txt`;
// 마크다운 링크 글자 안의 대괄호만 이스케이프한다(질문 글자 자체는 그대로).
const mdText = (s) => s.replace(/([\[\]])/g, '\\$1');

/** llms-full.txt 의 항목 한 건이 쓰는 줄 머리 — 게이트(scripts/check-llms.mjs)가 같은 머리로 다시 읽어 데이터와 비교한다. */
export const FULL_KEYS = { page: '- Page: ', qEn: '- Q (EN): ', aEn: '- A (EN): ', qKo: '- Q (KO): ', aKo: '- A (KO): ' };

/**
 * llms 파일의 FAQ 섹션(제목 줄부터, 끝에 빈 줄 하나).
 *   kind 'llms' → llms.txt: 답 원문이 llms-full.txt 에 있다는 안내 + 색인 주소 + EN 질문 38개와 답 위치
 *   kind 'full' → llms-full.txt: 색인 주소 + 항목마다 ID · 답 위치(EN·KO) · EN 질문·답 · KO 질문·답 (문구는 데이터 그대로, 한 글자도 바꾸지 않는다)
 */
export function llmsFaqSection(kind, data = loadFaq()) {
  const n = data.items.length;
  const lines = [HEADING];
  if (kind === 'llms') {
    lines.push(`Full answers (EN · KO) for all ${n} questions are in ${LLMS_FULL_URL}. Below: each question with the page section that holds its answer.`);
    lines.push(`- [FAQ index](${SITE}${faqIndexPath('en')}) · [한국어](${SITE}${faqIndexPath('ko')})`);
    for (const it of data.items) lines.push(`- [${mdText(it.en.q)}](${faqUrl(it, 'en')})`);
    return lines.join('\n') + '\n\n';
  }
  lines.push(`All ${n} questions with their full answers, English and Korean, exactly as published on the site. "Page" is where each answer lives (EN · KO).`);
  lines.push(`- [FAQ index](${SITE}${faqIndexPath('en')}) · [한국어](${SITE}${faqIndexPath('ko')})`);
  for (const it of data.items) {
    lines.push('', `### ${it.id}`);
    lines.push(`${FULL_KEYS.page}${faqUrl(it, 'en')} · ${faqUrl(it, 'ko')}`);
    lines.push(`${FULL_KEYS.qEn}${it.en.q}`);
    lines.push(`${FULL_KEYS.aEn}${it.en.a}`);
    lines.push(`${FULL_KEYS.qKo}${it.ko.q}`);
    lines.push(`${FULL_KEYS.aKo}${it.ko.a}`);
  }
  return lines.join('\n') + '\n\n';
}

/**
 * llms-full.txt 의 FAQ 섹션을 다시 읽는다 → [{ id, page, qEn, aEn, qKo, aKo }].
 * 생성 형식(위 llmsFaqSection('full'))을 그대로 뒤집은 것이라, 답 문구에 줄바꿈이 없어야 한다(데이터가 그렇다).
 */
export function parseFullFaqSection(sectionText) {
  const out = [];
  let cur = null;
  for (const line of sectionText.split('\n')) {
    const h = /^### (\S+)$/.exec(line);
    if (h) { cur = { id: h[1] }; out.push(cur); continue; }
    if (!cur) continue;
    for (const [k, head] of Object.entries(FULL_KEYS)) if (line.startsWith(head)) cur[k] = line.slice(head.length);
  }
  return out;
}

/** 글에서 "## 제목" 섹션의 범위 — 제목 줄부터 다음 "## " 줄 앞(또는 글 끝)까지. 섹션이 정확히 하나여야 한다. ("### " 소제목은 섹션을 끊지 않는다) */
export function sectionRange(text, heading) {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const starts = [...text.matchAll(new RegExp(`^${esc}[ \\t]*$`, 'gm'))];
  if (starts.length !== 1) throw new Error(`"${heading}" 제목 줄이 ${starts.length}개다(정확히 1개여야 한다)`);
  const start = starts[0].index;
  const next = /^## /m.exec(text.slice(start + heading.length));
  const end = next ? start + heading.length + next.index : text.length;
  return { start, end };
}
export const faqSectionRange = (text) => sectionRange(text, HEADING);

/** 글의 한 섹션만 바꾼다(section 은 제목 줄로 시작). 나머지는 한 글자도 건드리지 않는다. */
export function replaceSection(text, heading, section) {
  const { start, end } = sectionRange(text, heading);
  const tail = text.slice(end);
  return text.slice(0, start) + (tail ? section : section.replace(/\n+$/, '\n')) + tail;
}
export const replaceFaqSection = (text, section) => replaceSection(text, HEADING, section);
