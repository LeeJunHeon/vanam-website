// PayPal Orders v2 연동 헬퍼.
// - 금액은 절대 클라이언트를 믿지 않는다: create-order 가 D1 에서 재조회/재계산한 값만 쓴다.
// - KRW 미지원 → 전부 USD. 한국 판매자↔한국 구매자 거래는 PayPal 정책상 차단(해외 고객 전용).
// - 키는 Cloudflare 환경변수: PAYPAL_CLIENT_ID / PAYPAL_SECRET / PAYPAL_ENV(sandbox|live)
import { env as cfEnv } from 'cloudflare:workers';

// env 이중 접근: cloudflare:workers 의 env + (있다면) 어댑터가 주는 locals.runtime.env
const E = (k: string, extra?: Record<string, unknown>): string => {
  const raw =
    (cfEnv as Record<string, unknown> | undefined)?.[k] ??
    extra?.[k] ??
    (import.meta.env as Record<string, unknown>)[k] ??
    '';
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
};

// 진단(값 미노출 — 키 이름만): 어느 통로에 PAYPAL_* 가 보이는지
export const paypalDiag = (extra?: Record<string, unknown>) => {
  const names = (o?: Record<string, unknown>) =>
    Object.keys(o ?? {}).filter((k) => k.startsWith('PAYPAL')).sort();
  return {
    cfPaypalKeys: names(cfEnv as Record<string, unknown> | undefined),
    localsPaypalKeys: names(extra),
    cfHasDB: Boolean((cfEnv as Record<string, unknown> | undefined)?.DB),
    cfHasWebhook: Boolean(E('GOOGLE_CHAT_WEBHOOK')),
  };
};

export const paypalCfg = (extra?: Record<string, unknown>) => {
  const clientId = E('PAYPAL_CLIENT_ID', extra);
  const secret = E('PAYPAL_SECRET', extra);
  const mode = E('PAYPAL_ENV', extra) === 'live' ? 'live' : 'sandbox';
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
