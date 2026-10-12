// scripts/check-quote-ui.mjs — 견적 폼 산출물 게이트 (npm run build 뒤)
//
// 운영 스위치 '자동 견적'이 꺼진 기본 화면 = 지금 화면(+ 숨은 요소)임을 산출물로 보장한다.
// 제품 페이지 10개(ko 포함)에서:
//   · [예상 견적 보기](#quote-estimate-run) 있음·hidden · 결과 상자(#quote-estimate-result) hidden
//   · name="estimateSeenKrw" 정확히 1개
//   · [견적 요청서 다운로드](#quote-print) 있음·hidden 아님 · 다운로드 안내(#q-download-hint) 있음·hidden 아님
//   · 확인 메일 안내(#q-ack-hint — 스위치가 켜졌을 때만 보임) 있음·hidden
//   · 기판 등급 칸: #q-grade disabled · #q-grade-wrap hidden · 옵션 = SUBSTRATE_GRADES
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SUBSTRATE_GRADES } from '../src/lib/quote-fields.js';

const PAGES = [];
for (const p of ['metals', 'multilayers', 'nitrides', 'oxides', 'wafers']) PAGES.push(`product/${p}/index.html`, `ko/product/${p}/index.html`);

const errs = [];
/** id 로 여는 태그를 찾는다 */
const openTag = (html, id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`, 'i').exec(html)?.[0] ?? null;
const hasAttr = (tag, name) => new RegExp(`\\s${name}(?=[\\s>=/])`, 'i').test(tag);

for (const p of PAGES) {
  const f = join('dist', 'client', p);
  if (!existsSync(f)) { errs.push(`${p}: 파일 없음 — npm run build 뒤에 실행하세요`); continue; }
  const h = readFileSync(f, 'utf8');
  const need = (id, cond, why) => {
    const t = openTag(h, id);
    if (!t) errs.push(`${p}: #${id} 없음`);
    else if (!cond(t)) errs.push(`${p}: #${id} ${why}`);
  };
  need('quote-estimate-run', (t) => hasAttr(t, 'hidden'), '가 hidden 이 아니다');
  need('quote-estimate-result', (t) => hasAttr(t, 'hidden'), '가 hidden 이 아니다');
  need('quote-print', (t) => !hasAttr(t, 'hidden'), '가 hidden 이다(스위치 꺼짐 기본 화면에서는 보여야 한다)');
  need('q-download-hint', (t) => !hasAttr(t, 'hidden'), '가 hidden 이다(스위치 꺼짐 기본 화면에서는 보여야 한다)');
  need('q-ack-hint', (t) => hasAttr(t, 'hidden'), '가 hidden 이 아니다(스위치가 켜졌을 때만 보여야 한다)');
  need('q-grade', (t) => hasAttr(t, 'disabled'), '가 disabled 가 아니다');
  need('q-grade-wrap', (t) => hasAttr(t, 'hidden'), '가 hidden 이 아니다');
  const seen = (h.match(/name="estimateSeenKrw"/g) ?? []).length;
  if (seen !== 1) errs.push(`${p}: name="estimateSeenKrw" 가 ${seen}개(정확히 1개여야 한다)`);
  const sel = /<select\b[^>]*\bid="q-grade"[^>]*>([\s\S]*?)<\/select>/.exec(h)?.[1] ?? '';
  const opts = [...sel.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  if (JSON.stringify(opts) !== JSON.stringify(SUBSTRATE_GRADES)) errs.push(`${p}: 등급 옵션 ${JSON.stringify(opts)} ≠ ${JSON.stringify(SUBSTRATE_GRADES)}`);
}

if (errs.length) {
  for (const e of errs) console.error('  ✗', e);
  console.error(`\n견적 폼 UI 게이트 실패 — ${errs.length}건.`);
  process.exit(1);
}
console.log(`✓ 견적 폼 UI 게이트 — 제품 페이지 ${PAGES.length}개 · 예상 견적 숨김 · 다운로드 버튼·안내 유지 · 확인 메일 안내 숨김 · 등급 칸 숨김/비활성 · 옵션 ${SUBSTRATE_GRADES.join('/')}`);
