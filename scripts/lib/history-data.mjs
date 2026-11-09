// 연혁 데이터(src/content/history/*.json) — node 스크립트용 읽기·llms "## History" 섹션 생성. (GEO 정리 2차)
//   쓰는 곳: scripts/llms-sections.mjs(빌드 뒤 두 llms 파일의 History 생성) · scripts/check-llms.mjs(게이트)
//   사이트 쪽(Astro)은 같은 파일들을 content collection 'history' 로 읽어 홈 화면 연혁을 그린다(src/components/home/AboutBlocks.astro).
//   Keystatic '회사 정보 > 연혁' 에서 고치면 다음 빌드에서 홈 화면과 llms 가 함께 바뀐다. 문구는 그대로 싣는다(가공하지 않는다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../../src/content/history/', import.meta.url));

/** [{ year, order, items[], items_ko[] }] — 홈 화면과 같은 order 순 */
export function loadHistory() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
    .sort((a, b) => a.order - b.order);
}

export const HISTORY_HEADING = '## History';

/**
 * llms 의 "## History" 섹션(제목 줄부터, 끝에 빈 줄 하나). 항목마다 한 줄 — "- {연도} — {영문 항목}".
 *   kind 'full' 은 바로 아래 줄에 "  - KO: {한국어 항목}" 을 더한다(항목 수가 같을 때만 짝을 맞춘다).
 */
export function llmsHistorySection(kind, years = loadHistory()) {
  const lines = [HISTORY_HEADING, 'Same entries as the History section on the home page (https://vanam.co.kr/#history · https://vanam.co.kr/ko/#history).'];
  for (const y of years) {
    y.items.forEach((item, i) => {
      lines.push(`- ${y.year} — ${item}`);
      if (kind === 'full' && y.items_ko?.[i]) lines.push(`  - KO: ${y.items_ko[i]}`);
    });
  }
  return lines.join('\n') + '\n\n';
}

/** 섹션 글을 되읽는다 → [{ year, item }] (영문 줄만) */
export function parseHistorySection(sectionText) {
  const out = [];
  for (const line of sectionText.split('\n')) {
    const m = /^- (\d{4}) — (.+)$/.exec(line);
    if (m) out.push({ year: m[1], item: m[2] });
  }
  return out;
}
