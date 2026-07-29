// 가격 표시 환율 동기화 (클라이언트).
//
// 왜 필요한가:
//  - 제품 목록·상세 등은 정적 페이지라 환율이 빌드 시점 값으로 HTML 에 박힌다.
//  - 주문서는 SSR 이지만 HTML 이 캐시되면 역시 옛 환율이 그대로 보인다.
//  → 어느 경우든 "화면 가격 ≠ 실제 청구액" 이 되므로, 페이지가 열릴 때 현재 환율을 받아
//    가격 표시만 다시 계산한다. 레이아웃은 건드리지 않고 숫자만 교체한다.
//
// 사용법(둘 중 아무거나):
//  1) 정적 표기:  <span data-krw="510000">$318.75</span>
//  2) 스크립트:   const rate = await liveRate(fallback); ... 직접 렌더
export const FX_ENDPOINT = '/api/paypal/config';

let cached: number | null = null;
let inflight: Promise<number | null> | null = null;

/** 서버가 저장한 현재 환율. 실패하면 null. 한 페이지에서 한 번만 호출된다. */
export function fetchRate(): Promise<number | null> {
  if (cached !== null) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetch(FX_ENDPOINT, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { usdRate?: number } | null) => {
      const n = Number(j?.usdRate);
      // 상식 범위를 벗어난 값은 쓰지 않는다(잘못된 값이 가격에 반영되는 것이 최악).
      cached = Number.isFinite(n) && n >= 500 && n <= 5000 ? n : null;
      return cached;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 현재 환율을 얻되, 실패 시 넘겨준 폴백을 그대로 쓴다. */
export async function liveRate(fallback: number): Promise<number> {
  const r = await fetchRate();
  return r ?? fallback;
}

const fmt = (usd: number) =>
  '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * `data-krw` 가 붙은 요소의 텍스트를 현재 환율 기준 USD 로 갱신한다.
 * 환율 조회에 실패하면 아무것도 하지 않는다(기존 표시 유지).
 */
export async function syncPriceTags(root: ParentNode = document): Promise<void> {
  const els = Array.from(root.querySelectorAll<HTMLElement>('[data-krw]'));
  if (els.length === 0) return;
  const rate = await fetchRate();
  if (!rate) return;
  for (const el of els) {
    const krw = Number(el.dataset.krw);
    if (!Number.isFinite(krw) || krw <= 0) continue;
    const suffix = el.dataset.krwSuffix ?? '';
    el.textContent = fmt(krw / rate) + suffix;
  }
}

// 정적 표기(1번 방식)는 자동으로 처리한다.
if (typeof document !== 'undefined') {
  const run = () => void syncPriceTags();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
}
