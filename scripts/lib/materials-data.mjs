// 소재 데이터(src/content/materials/*.json) — node 스크립트용 읽기·llms 소재 목록 생성.
//   쓰는 곳: scripts/llms-sections.mjs(빌드 뒤 llms-full.txt 의 "## Materials library" 생성) · scripts/check-llms.mjs(게이트)
//   사이트 쪽(Astro)은 같은 파일들을 content collection 'materials' 로 읽는다(src/content.config.ts).
//
// ⚠️ 여기 싣는 값은 소재 상세 페이지(src/components/pages/MaterialDetail.astro) 화면에 보이는 것만이다:
//    이름·화학식·분류·증착 방식과 사양 줄(filmSpecs · band2Specs). 구조화 데이터 Dataset 과 같은 원칙이다.
//    PPT 원본이나 화면에 그리지 않는 필드(figs·image 경로 등)는 넣지 않는다. 사양 줄 문구는 그대로 쓴다(가공하지 않는다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from './faq-data.mjs';

const DIR = fileURLToPath(new URL('../../src/content/materials/', import.meta.url));

/** 상세 페이지와 같은 표기 (MaterialDetail.astro 의 sysLabel · catLabel) */
export const SYSTEM_LABEL = { sputter: 'PVD — Sputter & Evaporator', ald: 'ALD' };
export const CATEGORY_ORDER = ['Oxide', 'Nitride', 'Metal', 'Semiconductor', 'Multilayer'];

/** [{ id, system, category, formula, aka, order, name, name_ko, filmSpecs, band2Title, band2Specs }] — id 순 */
export function loadMaterials() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    return { id: path.basename(f, '.json'), ...d };
  });
}

export const materialPath = (m, loc) => `${loc === 'ko' ? '/ko' : ''}/materials/${m.id}/`;
export const materialUrl = (m, loc) => SITE + materialPath(m, loc);

/** 상세 페이지 제목과 같은 표시 이름 — name(정식명)이 없으면 화학식 */
const displayName = (m) => m.name ?? m.formula;

/**
 * 화면에 보이는 사양 묶음 — [{ title, rows }] (MaterialDetail.astro 의 ldSections 와 같은 규칙).
 *   filmSpecs → 'Thin-Film Specifications', band2Specs → band2Title(기본 'Target Specifications'). 비어 있는 묶음은 뺀다.
 */
export function visibleSpecs(m) {
  return [
    { title: 'Thin-Film Specifications', rows: m.filmSpecs ?? [] },
    { title: m.band2Title ?? 'Target Specifications', rows: m.band2Specs ?? [] },
  ].filter((s) => s.rows.length > 0);
}

export const MATERIALS_HEADING = '## Materials library';
export const NO_DATA = 'detailed data in preparation';

/**
 * llms-full.txt 의 "## Materials library" 섹션(제목 줄부터, 끝에 빈 줄 하나).
 * 순서: 증착 방식(PVD → ALD) → 분류(Oxide → Nitride → Metal → Semiconductor → Multilayer) → order.
 */
export function llmsMaterialsSection(mats = loadMaterials()) {
  const sorted = [...mats].sort((a, b) =>
    (a.system === 'ald') - (b.system === 'ald')
    || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    || a.order - b.order
    || a.id.localeCompare(b.id));
  const withSpecs = sorted.filter((m) => visibleSpecs(m).length > 0).length;
  const lines = [
    MATERIALS_HEADING,
    `${sorted.length} materials, each with a detail page (EN · KO). Only values shown on that page are listed here; ${sorted.length - withSpecs} entries are marked "${NO_DATA}" because their page has no specification data yet.`,
  ];
  for (const m of sorted) {
    const names = [displayName(m), m.name_ko].filter(Boolean).join(' / ');
    const aka = m.aka?.length ? ` (also: ${m.aka.join(', ')})` : '';
    lines.push(`- ${names} — ${m.formula}${aka} · ${m.category} · ${SYSTEM_LABEL[m.system]} · ${materialUrl(m, 'en')} · ${materialUrl(m, 'ko')}`);
    const specs = visibleSpecs(m);
    if (!specs.length) { lines.push(`  - ${NO_DATA}`); continue; }
    for (const s of specs) lines.push(`  - ${s.title}: ${s.rows.join('; ')}`);
  }
  return lines.join('\n') + '\n\n';
}
