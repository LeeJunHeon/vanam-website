// 장바구니 저장소 — 단일 창구.
//
// 왜 필요한가:
//   같은 로직(읽기 · 형식 정리 · 수량 1~99 강제 · 헤더 배지 갱신)이
//   Shop · ProductDetail · WaferList · WaferDetail · Cart · Checkout **여섯 곳**에
//   각각 복사돼 있었다. 저장 형식을 바꾸거나 규칙을 하나 고치려면 여섯 곳을 다 찾아야 하고,
//   한 곳만 빠뜨리면 오류 없이 조용히 어긋난다. (같은 부류의 사고를 여러 번 겪었다)
//
//   → 앞으로 localStorage/sessionStorage 를 직접 만지는 코드는 두지 않는다.
//     저장소 접근은 전부 이 파일을 통하고, 화면은 여기서 받은 값만 그린다.
//
// 저장 형식(localStorage `vanam_cart`): CartItem[] — { sku, qty } 뿐이다.
// ⚠️ 장바구니에는 **결제 가능한 품목만** 담는다. 견적은 장바구니를 거치지 않고
//    견적 폼에서 바로 요청하거나 요청서를 내려받는 흐름이다(0182 에서 정리).
//
// ⚠️ 저장소는 사용자가 마음대로 고칠 수 있다. 읽을 때 항상 형식을 정리하고,
//    금액은 **절대** 저장하지 않는다(가격은 카탈로그·서버에서만 조회).

export type CartItem = {
  sku: string;
  qty: number;
};

export const CART_KEY = 'vanam_cart';
export const BUYNOW_KEY = 'vanam_buynow';

/** 수량은 어떤 경로로 들어오든 1~99 정수로 강제한다. */
export const clampQty = (v: unknown): number =>
  Math.max(1, Math.min(99, Math.floor(Number(v)) || 1));

/** 한 줄을 구분하는 키. 지금은 sku 와 같다 — 화면 코드가 이 함수만 쓰도록 창구를 하나로 둔다. */
export const itemKey = (i: CartItem): string => i.sku;

/** 배지에 쓰는 총 수량. */
export const countItems = (items: CartItem[]): number =>
  items.reduce((s, i) => s + clampQty(i.qty), 0);

/** 알 수 없는 값을 CartItem[] 로 정리한다. 형식이 깨진 항목은 버린다. */
export const sanitize = (raw: unknown): CartItem[] => {
  if (!Array.isArray(raw)) return [];
  const out: CartItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.sku !== 'string' || !o.sku) continue;
    out.push({ sku: o.sku, qty: clampQty(o.qty) });
  }
  return out;
};

/** 헤더·페이지의 `.cart-count` 배지를 갱신한다. 저장소가 막혀 있어도 안전하다. */
export function paintCount(items?: CartItem[]): void {
  const n = countItems(items ?? readCart());
  document.querySelectorAll('.cart-count').forEach((el) => {
    el.textContent = String(n);
  });
}

export function readCart(): CartItem[] {
  try {
    return sanitize(JSON.parse(localStorage.getItem(CART_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

/** 저장 + 배지 갱신을 한 번에 한다. 배지만 따로 갱신하는 코드를 남기지 않기 위함. */
export function writeCart(items: CartItem[]): CartItem[] {
  const clean = sanitize(items);
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(clean));
  } catch {
    /* 저장소 접근 불가(시크릿 모드 등) — 화면 갱신은 그대로 진행한다 */
  }
  paintCount(clean);
  return clean;
}

/** 일반 상품 담기 — 같은 sku 가 있으면 수량을 더한다(최대 99). */
export function addToCart(sku: string, qty: unknown = 1): CartItem[] {
  const items = readCart();
  const add = clampQty(qty);
  const hit = items.find((i) => i.sku === sku);
  if (hit) hit.qty = Math.min(99, hit.qty + add);
  else items.push({ sku, qty: add });
  return writeCart(items);
}

/** 지정한 줄만 제거한다(키는 itemKey). 결제 완료 후 '주문한 품목만' 빼는 데 쓴다. */
export function removeKeys(keys: Iterable<string>): CartItem[] {
  const drop = new Set(keys);
  return writeCart(readCart().filter((i) => !drop.has(itemKey(i))));
}

// ── 즉시 구매(세션 한정) ────────────────────────────────────────────────
// 장바구니에 담으면 결제 없이 이탈했을 때 항목이 남아 다음 주문에 딸려간다.
// 그래서 이번 건만 sessionStorage 에 두고, 주문서에는 ?buynow=1 로 소스를 '선언'해 이동한다.

export function readBuyNow(): CartItem[] {
  try {
    return sanitize(JSON.parse(sessionStorage.getItem(BUYNOW_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

/** 성공하면 true. 세션 저장이 막힌 환경에서는 false 를 돌려주어 호출부가 폴백하게 한다. */
export function writeBuyNow(items: CartItem[]): boolean {
  try {
    sessionStorage.setItem(BUYNOW_KEY, JSON.stringify(sanitize(items)));
    return true;
  } catch {
    return false;
  }
}

export function clearBuyNow(): void {
  try {
    sessionStorage.removeItem(BUYNOW_KEY);
  } catch {
    /* 접근 불가 시 무시 */
  }
}
