// PayPal Orders v2 연동 헬퍼.
// - 금액은 절대 클라이언트를 믿지 않는다: create-order 가 D1 에서 재조회/재계산한 값만 쓴다.
// - KRW 미지원 → 전부 USD. 한국 판매자↔한국 구매자 거래는 PayPal 정책상 차단(해외 고객 전용).
// - 키는 Cloudflare 환경변수: PAYPAL_CLIENT_ID / PAYPAL_SECRET / PAYPAL_ENV(sandbox|live)
import { env as cfEnv } from 'cloudflare:workers';

const E = (k: string): string => {
  const raw = (cfEnv as Record<string, unknown> | undefined)?.[k] ?? (import.meta.env as Record<string, unknown>)[k] ?? '';
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
};

export const paypalCfg = () => {
  const clientId = E('PAYPAL_CLIENT_ID');
  const secret = E('PAYPAL_SECRET');
  const mode = E('PAYPAL_ENV') === 'live' ? 'live' : 'sandbox';
  const base = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  return { clientId, secret, mode, base, enabled: Boolean(clientId && secret) };
};

async function ppToken(): Promise<string> {
  const { clientId, secret, base, enabled } = paypalCfg();
  if (!enabled) throw new Error('paypal_disabled');
  const r = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${clientId}:${secret}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`paypal_auth_${r.status}`);
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new Error('paypal_auth_no_token');
  return j.access_token;
}

export async function ppCreateOrder(valueUsd: string, ref: string, description: string) {
  const { base } = paypalCfg();
  const token = await ppToken();
  const r = await fetch(`${base}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        { reference_id: ref, custom_id: ref, description, amount: { currency_code: 'USD', value: valueUsd } },
      ],
    }),
  });
  const j = (await r.json()) as { id?: string };
  if (!r.ok || !j.id) {
    console.error('[paypal] 주문 생성 실패:', r.status, JSON.stringify(j).slice(0, 400));
    throw new Error('paypal_create_failed');
  }
  return j as { id: string };
}

export async function ppCapture(orderId: string) {
  const { base } = paypalCfg();
  const token = await ppToken();
  const r = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const j = (await r.json()) as Record<string, unknown>;
  return { httpOk: r.ok, body: j };
}

export async function notifyChat(text: string) {
  const webhook = E('GOOGLE_CHAT_WEBHOOK');
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error('[paypal] 구글챗 알림 실패:', e);
  }
}
