// 프론트가 PayPal SDK 로드에 쓰는 공개 설정. Secret 은 절대 내보내지 않는다.
import type { APIRoute } from 'astro';
import { paypalCfg } from '../../../lib/paypal';
import { db } from '../../../lib/db';
import { getRate, pickWaitUntil } from '../../../lib/fx';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  let lenv: Record<string, unknown> | undefined;
  try {
    lenv = (locals as unknown as { runtime?: { env?: Record<string, unknown> } })?.runtime?.env;
  } catch {
    lenv = undefined;
  }
  const { clientId, mode, enabled } = paypalCfg(lenv);
  // 표시용 환율도 서버가 저장한 라이브 값을 쓴다(오래됐으면 뒤에서 갱신).
  const fx = await getRate(await db(), pickWaitUntil(locals));
  const body: Record<string, unknown> = {
    ok: true,
    enabled,
    clientId: enabled ? clientId : null,
    mode,
    currency: 'USD',
    usdRate: fx.rate,
    usdRateUpdatedAt: fx.updatedAt,
  };
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
