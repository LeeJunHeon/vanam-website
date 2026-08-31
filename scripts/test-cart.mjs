// scripts/test-cart.mjs — 장바구니 저장소(src/lib/cart.ts) 회귀 테스트
//
// 왜 있는가: 장바구니 규칙(수량 clamp · 깨진 데이터 방어 · 견적 줄 분리 · 주문분만 제거)은
// 화면을 눌러봐야만 확인되던 부분이라, 조용히 어긋나도 빌드는 그냥 통과했다.
// 이제 `npm run verify` 가 이 테스트를 먼저 돌린다. 실패하면 커밋 전에 막힌다.
//
// 브라우저 API(localStorage·sessionStorage·document)는 최소 셰임으로 대체한다.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  // esbuild 는 Vite 의 의존성이라 보통 있지만, 없으면 테스트만 건너뛴다(빌드를 막지 않는다).
  console.warn('⚠ esbuild 를 찾지 못해 장바구니 테스트를 건너뜁니다.');
  process.exit(0);
}

const src = readFileSync('src/lib/cart.ts', 'utf8');
const out = esbuild.transformSync(src, { loader: 'ts', format: 'esm' }).code;
const tmp = join(tmpdir(), `vanam-cart-${process.pid}.mjs`);
writeFileSync(tmp, out);

const store = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};
globalThis.localStorage = store();
globalThis.sessionStorage = store();
globalThis.document = { querySelectorAll: () => [] };

const c = await import(pathToFileURL(tmp).href);

let fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`  ✗ ${name}\n     실제: ${a}\n     기대: ${b}`);
    fail++;
  } else {
    console.log(`  ✓ ${name}`);
  }
};

// 1) 같은 상품은 수량이 합쳐진다
c.writeCart([]);
c.addToCart('oxides', 2);
c.addToCart('oxides', 3);
eq('같은 상품 합산', c.readCart(), [{ sku: 'oxides', qty: 5, dicing: false }]);

// 2) 수량은 어떤 값이 들어와도 1~99 정수
c.writeCart([{ sku: 'a', qty: '999' }, { sku: 'b', qty: -4 }, { sku: 'c', qty: '2.7' }]);
eq('수량 clamp', c.readCart().map((i) => i.qty), [99, 1, 2]);

// 3) 저장소가 조작·파손돼도 죽지 않는다
localStorage.setItem('vanam_cart', '[{"sku":123},null,"x",{"qty":3},{"sku":"ok","qty":2}]');
eq('깨진 항목 제거', c.readCart(), [{ sku: 'ok', qty: 2, dicing: false }]);
localStorage.setItem('vanam_cart', '{{{ not json');
eq('JSON 파손 방어', c.readCart(), []);

// 4) 장바구니에는 결제 가능한 품목만 담긴다 — 알 수 없는 필드는 저장 단계에서 떨어진다
c.writeCart([]);
localStorage.setItem('vanam_cart', '[{"sku":"oxides","qty":1,"q":{"id":"x"}}]');
eq('알 수 없는 필드 제거', c.readCart(), [{ sku: 'oxides', qty: 1, dicing: false }]);

// 5) 결제 완료 시 '주문한 줄만' 빠진다
c.writeCart([{ sku: 'a', qty: 1 }, { sku: 'b', qty: 2 }, { sku: 'wafer:x', qty: 1 }]);
c.removeKeys(['a', 'wafer:x']);
eq('주문분만 제거', c.readCart().map(c.itemKey), ['b']);

// 6) 즉시 구매는 장바구니와 완전히 분리된 세션 저장소
c.writeBuyNow([{ sku: 'wafer:x', qty: 3 }]);
eq('즉시구매 읽기', c.readBuyNow(), [{ sku: 'wafer:x', qty: 3, dicing: false }]);
c.clearBuyNow();
eq('즉시구매 비우기', c.readBuyNow(), []);
eq('장바구니는 그대로', c.readCart().map(c.itemKey), ['b']);

// ── 다이싱 옵션 (0829) ─────────────────────────────────────────────
// 7) 같은 웨이퍼라도 다이싱 유·무는 **별도 줄**이다 (합치면 어느 쪽에 붙는지 표현 불가)
c.writeCart([]);
c.addToCart('wafer:si4', 1, true);
c.addToCart('wafer:si4', 2, false);
c.addToCart('wafer:si4', 3, true);
eq('다이싱 유·무 분리 + 같은 줄만 합산', c.readCart(), [
  { sku: 'wafer:si4', qty: 4, dicing: true },
  { sku: 'wafer:si4', qty: 2, dicing: false },
]);
eq('줄 키가 서로 다르다', c.readCart().map(c.itemKey), ['wafer:si4#dicing', 'wafer:si4']);

// 8) 다이싱 줄만 골라 제거할 수 있다 (결제 완료 후 '주문한 줄만' 빼는 경로)
c.removeKeys(['wafer:si4#dicing']);
eq('다이싱 줄만 제거', c.readCart(), [{ sku: 'wafer:si4', qty: 2, dicing: false }]);

// 9) 옛 저장분(dicing 필드 없음)은 false 로 읽혀 깨지지 않는다
localStorage.setItem('vanam_cart', '[{"sku":"wafer:si4","qty":2}]');
eq('옛 카트 하위호환', c.readCart(), [{ sku: 'wafer:si4', qty: 2, dicing: false }]);

// 10) dicing 값이 조작돼도 boolean 으로 굳는다 ('false' 문자열은 참으로 새지 않는다)
localStorage.setItem('vanam_cart', '[{"sku":"a","qty":1,"dicing":"false"},{"sku":"b","qty":1,"dicing":1}]');
eq('dicing 값 정규화', c.readCart().map((i) => i.dicing), [false, false]);

// 11) 배지 개수는 다이싱과 무관하게 수량 합계 그대로다
eq('뱃지 개수 유지', c.countItems([{ sku: 'a', qty: 2, dicing: true }, { sku: 'a', qty: 3, dicing: false }]), 5);

if (fail) {
  console.error(`\n장바구니 테스트 실패 — ${fail}건.`);
  process.exit(1);
}
console.log(`✓ cart 테스트 통과 — 15개 항목`);
