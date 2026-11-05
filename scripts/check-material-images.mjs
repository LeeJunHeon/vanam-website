// scripts/check-material-images.mjs — 소재 이미지 색·밝기 보존 게이트
//
// 왜 있는가: 소재 그림(src/assets/materials/**)은 PPT 렌더를 그대로 담은 파일인데, 화면 코드가 getImage(webp, quality 88)
// 처럼 손실 재인코딩을 한 번 더 걸면 순빨강·순파랑 곡선이 어두운 색으로 번지고 전체가 어두워진다(실측: m05/fig-3 의
// 순빨강 원본 80% → 배포본 0.2%). 빌드 산출물(dist)이 저장소 원본과 같은 모양인지 빌드 뒤에 못 박는다.
//
// 검사: 소재마다(영문·한글 상세 페이지 모두) 저장소 원본 이미지 한 장 한 장에 대해
//   ① 페이지가 내보낸 /_astro/ 이미지 중 같은 가로세로비의 것이 있고
//   ② 그 평균 밝기가 원본과 1% 이내, ③ 순빨강(R≥240,G·B≤20)·순파랑 비율이 원본과 같다(상대 10% 또는 절대 0.0002 이내).
// 사용: npm run build 뒤에 node scripts/check-material-images.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = join(ROOT, 'src/assets/materials');
const DIST = join(ROOT, 'dist/client');
if (!existsSync(DIST)) { console.error('dist/client 가 없다 — npm run build 먼저'); process.exit(1); }

let bad = 0;
const fail = (m) => { console.error('  ✗', m); bad++; };
const cache = new Map();
async function stats(buf, key) {
  if (key && cache.has(key)) return cache.get(key);
  const { data, info } = await sharp(buf).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height; let sum = 0, r = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const R = data[i * 3], G = data[i * 3 + 1], B = data[i * 3 + 2];
    sum += R + G + B;
    if (R >= 240 && G <= 20 && B <= 20) r++;
    if (B >= 240 && R <= 20 && G <= 20) b++;
  }
  const s = { w: info.width, h: info.height, mean: sum / (n * 3) / 255, red: r / n, blue: b / n };
  if (key) cache.set(key, s);
  return s;
}
const ratioOk = (a, o) => Math.abs(a - o) <= Math.max(0.0002, o * 0.1);

console.log('· 소재 이미지 색·밝기 게이트 (dist ↔ 저장소 원본)');
const ids = readdirSync(ASSETS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
let checked = 0, worst = 0, files = 0;
for (const id of ids) {
  const originals = readdirSync(join(ASSETS, id)).filter((f) => /\.(webp|png|jpe?g|avif)$/i.test(extname(f)));
  files += originals.length;
  for (const lang of ['', 'ko/']) {
    const page = join(DIST, lang, 'materials', id, 'index.html');
    if (!existsSync(page)) { if (originals.length) fail(`${lang}materials/${id}/ 페이지가 dist 에 없다`); continue; }
    const html = readFileSync(page, 'utf8');
    const srcs = [...new Set([...html.matchAll(/<img[^>]+src="(\/_astro\/[^"]+)"/g)].map((m) => m[1]))];
    const cands = [];
    for (const s of srcs) {
      const p = join(DIST, s.replace(/^\//, ''));
      if (!existsSync(p)) continue;
      try { cands.push({ s, st: await stats(readFileSync(p), p) }); } catch { /* 이미지 아님 */ }
    }
    for (const f of originals) {
      const o = await stats(readFileSync(join(ASSETS, id, f)), join(ASSETS, id, f));
      // 같은 가로세로비(2% 이내)이면서 밝기가 가장 가까운 산출물 이미지를 짝으로 본다.
      const pool = cands.filter((c) => Math.abs(c.st.w / c.st.h - o.w / o.h) / (o.w / o.h) < 0.02);
      if (!pool.length) { fail(`${lang}${id}/${f}: 페이지에서 짝이 되는 이미지를 찾지 못함 (원본 ${o.w}×${o.h})`); continue; }
      const best = pool.reduce((a, c) => (Math.abs(c.st.mean - o.mean) < Math.abs(a.st.mean - o.mean) ? c : a));
      const d = Math.abs(best.st.mean - o.mean); worst = Math.max(worst, d); checked++;
      if (d > 0.01) fail(`${lang}${id}/${f}: 평균 밝기 차 ${(d * 100).toFixed(2)}% (>1%) — ${best.s}`);
      if (!ratioOk(best.st.red, o.red)) fail(`${lang}${id}/${f}: 순빨강 비율 ${best.st.red.toFixed(5)} ≠ 원본 ${o.red.toFixed(5)} — ${best.s}`);
      if (!ratioOk(best.st.blue, o.blue)) fail(`${lang}${id}/${f}: 순파랑 비율 ${best.st.blue.toFixed(5)} ≠ 원본 ${o.blue.toFixed(5)} — ${best.s}`);
    }
  }
}
if (bad) { console.error(`\n소재 이미지 게이트 실패: ${bad}건 — 화면 코드가 이미지를 손실 재인코딩하고 있다(src/lib/material-image.ts 참고).`); process.exit(1); }
console.log(`  ✓ 원본 ${files}장 × 페이지(영·한) 대조 ${checked}건 — 평균 밝기 차 최대 ${(worst * 100).toFixed(3)}% · 순빨강/순파랑 비율 유지`);
console.log('· 소재 이미지 게이트 통과');
