// 문의 페이지 FAQ — 화면(Contact.astro)과 FAQPage 구조화 데이터(FaqSchema.astro)가 함께 쓰는 단일 원본.
//
// 원본 데이터는 src/content/faq/*.json (Keystatic 'FAQ' 컬렉션) 하나다. Keystatic 설정은 그대로다 —
// 분류와 링크를 기존 칸(표시 순서 · 답변)에 담아서, Keystatic 에서 고쳐도 값이 사라지지 않는다.
//   · 파일 ID · question/answer(KO) · question_en/answer_en(EN) · published · order
//   · 분류 = 표시 순서(order)의 백 단위:  0~99 일반 · 100~ 공정 · 200~ 소재 · 300~ 기판·시료 · 400~ 주문·배송 · 500~ 분석 · 600~ 웨이퍼
//     같은 분류 안에서는 order 가 작은 것부터 나온다. (Keystatic 기본값 99 = 일반)
//   · 답 안의 내부 링크(선택) = 답 문장 안에 [어구](/경로/) 로 적는다. 경로는 언어 접두사 없는 사이트 내부 경로.
//     화면에서는 그 어구가 같은 언어 경로의 링크가 되고, 구조화 데이터에는 표기를 뺀 같은 문장이 일반 텍스트로 들어간다.
//   · 자리표시 {materialCount} · {materialList}: 소재 라이브러리(src/content/materials)에서 빌드 때 채운다.
//     소재를 추가하면 답도 따라온다. 분류·순서·표기는 소재 라이브러리 화면과 같다(lib/material-lists.ts).
//   published:false 이거나 answer 가 빈 항목은 화면·구조화 데이터 양쪽에서 빠진다.
// 화면은 parts(문장 조각 + 링크)를 그리고, 구조화 데이터는 answer 를 쓴다 — parts 를 이어 붙인 글자가 answer 다.
import { getCollection } from 'astro:content';
import { getRelativeLocaleUrl } from 'astro:i18n';
import { allMaterialsSorted, groupBySystem, joinFormulas, SYSTEM_LABEL, CATEGORY_LABEL } from './material-lists';

/** 분류와 화면 순서. 'general'(일반)은 소제목 없이 맨 위에 나온다. 배열 순서 = order 의 백 단위(0, 100, 200, …). */
export const FAQ_CATEGORIES = [
  { key: 'general', ko: '일반', en: 'General' },
  { key: 'process', ko: '공정', en: 'Process' },
  { key: 'materials', ko: '소재', en: 'Materials' },
  { key: 'substrates', ko: '기판·시료', en: 'Substrates & samples' },
  { key: 'ordering', ko: '주문·배송', en: 'Ordering & shipping' },
  { key: 'analysis', ko: '분석', en: 'Analysis' },
  { key: 'wafers', ko: '웨이퍼', en: 'Wafers' },
] as const;

/** 분류 한 칸의 order 폭 */
const ORDER_BAND = 100;
const categoryOf = (order: number) =>
  FAQ_CATEGORIES[Math.min(FAQ_CATEGORIES.length - 1, Math.max(0, Math.floor(order / ORDER_BAND)))].key;
/** 답 안의 내부 링크 표기: [어구](/경로/) */
const LINK_RE = /\[([^\]]+)\]\((\/[^)\s]*)\)/g;

export type FaqPart = { text: string; href?: string };
export type FaqItem = {
  id: string;
  question: string;
  /** 답 전체 문장(일반 텍스트) — 구조화 데이터용 */
  answer: string;
  /** 같은 문장을 링크 앞·링크·링크 뒤로 나눈 조각 — 화면용. 이어 붙이면 answer 와 같다. */
  parts: FaqPart[];
};
export type FaqGroup = { key: string; label: string; items: FaqItem[] };

/** 소재 라이브러리 화면과 같은 묶음·순서·표기의 소재 목록 문장. 예: "[ALD] 산화물: Al₂O₃, …. 금속: Pt, Ru." */
async function materialList(loc: 'ko' | 'en'): Promise<{ count: number; list: string }> {
  const all = await allMaterialsSorted();
  const segs: string[] = [];
  for (const system of ['sputter', 'ald']) {
    const groups = Object.entries(groupBySystem(all, system));
    if (!groups.length) continue;
    const cats = groups.map(([cat, items]) => `${CATEGORY_LABEL[loc][cat] ?? cat}: ${joinFormulas(items.map((i) => i.formula))}.`);
    segs.push(`[${SYSTEM_LABEL[system] ?? system}] ${cats.join(' ')}`);
  }
  return { count: all.length, list: segs.join(' ') };
}

/** 분류별 FAQ. 화면 순서 그대로(분류 순서 → 분류 안에서는 order). 항목이 없는 분류는 빠진다. */
export async function faqGroups(locale: string): Promise<FaqGroup[]> {
  const loc: 'ko' | 'en' = locale === 'ko' ? 'ko' : 'en';
  const entries = (await getCollection('faq'))
    .filter((x) => x.data.published && x.data.answer.trim() !== '')
    .sort((a, b) => a.data.order - b.data.order);
  let mat: { count: number; list: string } | null = null;

  const items = new Map<string, FaqItem[]>();
  for (const x of entries) {
    const d = x.data;
    const question = loc === 'en' ? (d.question_en ?? d.question) : d.question;
    let answer = loc === 'en' ? (d.answer_en ?? d.answer) : d.answer;
    if (answer.includes('{materialCount}') || answer.includes('{materialList}')) {
      mat ??= await materialList(loc);
      answer = answer.replaceAll('{materialCount}', String(mat.count)).replaceAll('{materialList}', mat.list);
    }
    // 답 안의 내부 링크 — [어구](/경로/) 를 링크 조각으로 나눈다. answer 는 표기를 뺀 일반 텍스트.
    const parts: FaqPart[] = [];
    let last = 0;
    for (const m of answer.matchAll(LINK_RE)) {
      if (m.index! > last) parts.push({ text: answer.slice(last, m.index) });
      parts.push({ text: m[1], href: getRelativeLocaleUrl(loc, m[2]) });
      last = m.index! + m[0].length;
    }
    if (last < answer.length) parts.push({ text: answer.slice(last) });
    answer = parts.map((p) => p.text).join('');
    const category = categoryOf(d.order);
    const list = items.get(category) ?? [];
    list.push({ id: x.id, question, answer, parts });
    items.set(category, list);
  }
  return FAQ_CATEGORIES
    .filter((c) => items.has(c.key))
    .map((c) => ({ key: c.key, label: c[loc], items: items.get(c.key)! }));
}
