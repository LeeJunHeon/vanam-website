// 소재 라이브러리에서 "화면에 보이는 순서 그대로" 화학식 목록을 뽑는 유일한 지점.
//
// 두 소비자가 같은 순서를 봐야 한다:
//   ① 소재 라이브러리 페이지의 칩 그리드 (MaterialsLibrary.astro)
//   ② 검색 스니펫용 메타 설명의 물질 나열 (lib/meta-descriptions.ts)
// 그래서 정렬·핀 규칙을 여기 한 번만 적는다. 예전에는 ①에만 있었고, ②를 만들 때
// 같은 로직을 복사했다면 소재가 추가될 때마다 둘이 조용히 어긋났을 것이다.
//
// ⚠️ 목록을 하드코딩하지 않는다. src/content/materials 에 소재를 추가하면
//    칩 그리드와 메타 설명이 **동시에** 따라온다.
import { getCollection } from 'astro:content';

/** 화학식의 유니코드 아래첨자를 보통 문자로 되돌린 소문자 (Al₂O₃ → al2o3, SiNₓ → sinx) */
const SUBSCRIPTS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', 'ₓ': 'x',
};
export const chipSortKey = (formula: string) =>
  formula.replace(/[₀-₉ₓ]/g, (c) => SUBSCRIPTS[c] ?? c).toLowerCase();

/** 예외 한 건: PVD 산화물의 VO₂(m01)는 대표 소재라 늘 맨 앞. 나머지는 순수 알파벳순. */
const CHIP_PINNED: Record<string, Record<string, string>> = { sputter: { Oxide: 'm01' } };

type Chip = { formula: string; id: string };

/** order 순으로 정렬된 materials 컬렉션 전체 */
export async function allMaterialsSorted() {
  return (await getCollection('materials')).sort((a, b) => a.data.order - b.data.order);
}

/**
 * 한 증착 방식(system)의 category → 칩 배열.
 * 카테고리(키) 순서는 order 기준 첫 등장 순서 그대로 두고, 각 배열 내부만 정렬한다.
 */
export function groupBySystem(
  all: Awaited<ReturnType<typeof allMaterialsSorted>>,
  system: string,
): Record<string, Chip[]> {
  const groups: Record<string, Chip[]> = {};
  for (const m of all) {
    if (m.data.system !== system) continue;
    (groups[m.data.category] ??= []).push({ formula: m.data.formula, id: m.id });
  }
  for (const [category, items] of Object.entries(groups)) {
    const pinned = CHIP_PINNED[system]?.[category];
    items.sort((a, b) => {
      if (a.id === pinned) return -1;
      if (b.id === pinned) return 1;
      return chipSortKey(a.formula).localeCompare(chipSortKey(b.formula), 'en');
    });
  }
  return groups;
}

/** PVD 목록을 먼저 놓고, ALD 에만 있는 것을 뒤에 잇는다(칩 그리드가 PVD 카드 → ALD 카드 순서다). */
function mergeSystems(sputter: Chip[] = [], ald: Chip[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of [...sputter, ...ald]) {
    if (seen.has(c.formula)) continue;
    seen.add(c.formula);
    out.push(c.formula);
  }
  return out;
}

export type MaterialLists = {
  oxides: string[];      // PVD 산화물 ∪ ALD 산화물
  nitrides: string[];    // 질화물
  metals: string[];      // PVD 금속 ∪ ALD 금속 (Si 는 별도)
  semiconductors: string[]; // Si
  total: number;         // 라이브러리 전체 소재 수
};

/** 메타 설명에 쓸 그룹별 화학식 목록. 칩 그리드와 같은 순서·같은 표기(유니코드 아래첨자). */
export async function materialsForDescription(): Promise<MaterialLists> {
  const all = await allMaterialsSorted();
  const s = groupBySystem(all, 'sputter');
  const a = groupBySystem(all, 'ald');
  return {
    oxides: mergeSystems(s.Oxide, a.Oxide),
    nitrides: mergeSystems(s.Nitride, a.Nitride),
    metals: mergeSystems(s.Metal, a.Metal),
    semiconductors: mergeSystems(s.Semiconductor, a.Semiconductor),
    total: all.length,
  };
}

/** 문장에 넣을 때 쓰는 구분자 — 목록이 길어 쉼표 나열이 가장 읽기 쉽다. */
export const joinFormulas = (xs: string[]) => xs.join(', ');
