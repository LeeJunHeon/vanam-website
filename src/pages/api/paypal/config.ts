// 프론트가 PayPal SDK 로드에 쓰는 공개 설정. Secret 은 절대 내보내지 않는다.
import type { APIRoute } from 'astro';
import { paypalCfg } from '../../../lib/paypal';
import company from '../../../data/company.json';

export const prerender = false;

export const GET: APIRoute = async () => {
  const { clientId, mode, enabled } = paypalCfg();
  return new Response(
    JSON.stringify({ ok: true, enabled, clientId: enabled ? clientId : null, mode, currency: 'USD', usdRate: company.usdRate || 1500 }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
};
