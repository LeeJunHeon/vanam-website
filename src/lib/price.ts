// 원화(KRW) → 달러($) 표시 유틸.
// 환율은 Keystatic '사업자 정보'의 usdRate(원/달러)에서 관리한다 — 기본 1,500원.
// 정수로 떨어지면 "$286", 아니면 "$566.67" 처럼 소수 둘째 자리까지 표시한다.
export function formatUsd(krw: number, rate: number): string {
  const r = rate > 0 ? rate : 1380;
  const usd = krw / r;
  const opts: Intl.NumberFormatOptions = Number.isInteger(Math.round(usd * 100) / 100) && Number.isInteger(usd)
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return '$' + usd.toLocaleString('en-US', opts);
}
