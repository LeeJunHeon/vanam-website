// 가격 자리 문구 게이트 (GEO 정리 3차 B) — npm run verify 에 포함.
//
//   웨이퍼는 목록 웨이퍼가 고정가로 바로 주문되므로 "Price on request"/"가격 문의"가 맞지 않는다. 웨이퍼 전용 문구(site.json shop.waferPriceNote)를
//   아래 두 곳에만 쓰고, 산화물·질화물·금속·다층 카드와 상세의 "Price on request"/"가격 문의"는 그대로 둔다.
//     · /product/wafers/ · /ko/product/wafers/ 의 h1 아래 가격 자리 — 새 문구 있음, 옛 문구 없음(페이지 전체)
//     · /product/ · /ko/product/ 제품 목록의 웨이퍼 카드 — 카드 안에 새 문구 있음, 옛 문구 없음; 나머지 견적 상품 카드 4개에는 옛 문구 그대로
//     · /product/oxides|nitrides|metals|multilayers/ (EN·KO) — 옛 문구 있음, 새 문구 없음
//   문구 기대값은 site.json 에서 읽는다(화면과 데이터가 같은 출처).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argDist = process.argv.indexOf('--dist');
const DIST = argDist >= 0 ? path.resolve(process.argv[argDist + 1]) : path.join(ROOT, 'dist/client');
const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/site.json'), 'utf8'));
let bad = 0;
const fail = (page, why) => { console.error(`  ✗ ${page} — ${why}`); bad++; };
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&middot;/g, '·');
const read = (p) => { const f = path.join(DIST, p.replace(/^\//, ''), 'index.html'); if (!fs.existsSync(f)) { fail(p, '빌드 결과에 없다'); return null; } return decode(fs.readFileSync(f, 'utf8')); };
const QUOTE_PRODUCTS = ['oxides', 'nitrides', 'metals', 'multilayers'];
let checked = 0;

for (const locale of ['en', 'ko']) {
  const s = site[locale].shop;
  const NEW = s.waferPriceNote; const OLD = s.priceOnRequest;
  if (!NEW || NEW === OLD) { fail(`site.json ${locale}`, 'shop.waferPriceNote 가 없거나 priceOnRequest 와 같다'); continue; }
  const base = locale === 'ko' ? '/ko' : '';
  // 웨이퍼 제품 페이지
  {
    const p = `${base}/product/wafers/`; const html = read(p); if (!html) continue; checked++;
    const main = html.slice(html.indexOf('<main'), html.lastIndexOf('</main'));
    const h1 = main.indexOf('<h1'); const priceBlock = main.slice(h1, main.indexOf('</h1>') + 1200);
    if (!priceBlock.includes(NEW)) fail(p, `h1 아래 가격 자리에 "${NEW}" 가 없다`);
    if (html.includes(OLD)) fail(p, `옛 문구 "${OLD}" 가 남아 있다`);
  }
  // 제품 목록
  {
    const p = `${base}/product/`; const html = read(p); if (!html) continue; checked++;
    const cards = html.split('<article').slice(1);
    // 웨이퍼 카드는 목록(/wafers/)으로 간다 — 카드의 링크 주소로 구분
    const isWafer = (c) => new RegExp(`href="${base}/wafers/"`).test(c);
    const wafer = cards.filter(isWafer); const others = cards.filter((c) => !isWafer(c));
    if (wafer.length !== 1) fail(p, `웨이퍼 카드가 ${wafer.length}개(1개여야 한다)`);
    else { if (!wafer[0].includes(NEW)) fail(p, `웨이퍼 카드에 "${NEW}" 가 없다`); if (wafer[0].includes(OLD)) fail(p, `웨이퍼 카드에 옛 문구 "${OLD}" 가 있다`); }
    const quoteCards = others.filter((c) => QUOTE_PRODUCTS.some((id) => c.includes(`href="${base}/product/${id}/"`)));
    if (quoteCards.length !== QUOTE_PRODUCTS.length) fail(p, `견적 상품 카드가 ${quoteCards.length}개(${QUOTE_PRODUCTS.length}개여야 한다)`);
    for (const c of quoteCards) { if (!c.includes(OLD)) fail(p, `견적 상품 카드에 "${OLD}" 가 없다`); if (c.includes(NEW)) fail(p, '견적 상품 카드에 웨이퍼 문구가 들어갔다'); }
    const oldCount = (html.match(new RegExp(OLD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    if (oldCount !== QUOTE_PRODUCTS.length) fail(p, `옛 문구 "${OLD}" 가 ${oldCount}번(견적 상품 ${QUOTE_PRODUCTS.length}번이어야 한다)`);
  }
  // 견적 상품 상세
  for (const id of QUOTE_PRODUCTS) {
    const p = `${base}/product/${id}/`; const html = read(p); if (!html) continue; checked++;
    if (!html.includes(OLD)) fail(p, `"${OLD}" 가 없다(그대로 둬야 한다)`);
    if (html.includes(NEW)) fail(p, '웨이퍼 문구가 들어갔다');
  }
}

if (bad) { console.error(`\n✗ check-price-labels 실패 — ${bad}건`); process.exit(1); }
console.log(`check-price-labels OK — 페이지 ${checked}개 · 웨이퍼 문구 4곳 · 견적 상품 문구 그대로`);
