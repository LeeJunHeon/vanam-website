// 프론트가 PayPal SDK 로드에 쓰는 공개 설정. Secret 은 절대 내보내지 않는다.
import type { APIRoute } from 'astro';
import { paypalCfg } from '../../../lib/paypal';
import { db } from '../../../lib/db';
import { getRate, pickWaitUntil } from '../../../lib/fx';
import company from '../../../data/company.json';

const FALLBACK_RATE = Number(company.usdRate) || 1380;

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  // Astro v6 부터 locals.runtime.env 는 접근만 해도 예외를 던진다(어댑터가 그렇게 정의).
  // 실제 env 는 lib/paypal 의 cloudflare:workers import 로 이미 읽으므로 여기서는 시도하지 않는다.
  const lenv: Record<string, unknown> | undefined = undefined;
  const { clientId, mode, enabled } = paypalCfg(lenv);

  // 환율은 이 응답의 부가 정보일 뿐이다. 여기서 실패해도 clientId 는 반드시 내려가야 한다.
  // (이 엔드포인트가 죽으면 PayPal SDK 가 로드되지 않아 결제 전체가 멈춘다)
  let fx: { rate: number; updatedAt: string | null } = { rate: 0, updatedAt: null };
  try {
    fx = await getRate(await db(), pickWaitUntil(locals));
  } catch (e) {
    console.error('[config] 환율 조회 실패 — 폴백 사용:', e);
  }
  const rate = fx.rate > 0 ? fx.rate : FALLBACK_RATE;
  const body: Record<string, unknown> = {
    ok: true,
    enabled,
    clientId: enabled ? clientId : null,
    mode,
    currency: 'USD',
    usdRate: rate,
    usdRateUpdatedAt: fx.updatedAt,
  };
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
