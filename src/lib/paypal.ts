// PayPal Orders v2 연동 헬퍼.
// - 금액은 절대 클라이언트를 믿지 않는다: create-order 가 D1 에서 재조회/재계산한 값만 쓴다.
// - KRW 미지원 → 전부 USD. 한국 판매자↔한국 구매자 거래는 PayPal 정책상 차단(해외 고객 전용).
// - 키는 Cloudflare 환경변수: PAYPAL_CLIENT_ID / PAYPAL_SECRET / PAYPAL_ENV(sandbox|live)
import { env as cfEnv } from 'cloudflare:workers';
import company from '../data/company.json';

// env 이중 접근: cloudflare:workers 의 env + (있다면) 어댑터가 주는 locals.runtime.env
const E = (k: string, extra?: Record<string, unknown>): string => {
  const raw =
    (cfEnv as Record<string, unknown> | undefined)?.[k] ??
    extra?.[k] ??
    (import.meta.env as Record<string, unknown>)[k] ??
    '';
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
};

// ── 결제 금액 단일 진실원 ──
// 주문 생성(create-order)과 캡처 검증(capture)이 "같은 함수"로 금액을 계산해야
// 두 시점의 기준이 어긋나지 않는다. 문자열(소수 2자리)로 돌려주고 비교는 센트 정수로 한다.
export const toCents = (v: string | number) => Math.round(Number(v) * 100);

/** DB 행에서 청구할 USD 금액을 서버가 단독 계산. 결제 불가면 null. */
export function expectedUsdStr(kind: 'ord' | 'inq', row: Record<string, unknown>): string | null {
  if (kind === 'inq') {
    // 견적: 관리자가 USD 로 확정한 금액만 결제 대상
    const amt = Number(row.quoted_amount ?? 0);
    if (!(amt > 0)) return null;
    if (String(row.quote_currency ?? 'KRW') !== 'USD') return null;
    return amt.toFixed(2);
  }
  // 주문 시점에 확정된 USD 가 있으면 그것이 기준(환율 변동과 무관하게 표시액=청구액)
  const locked = Number(row.amount_usd ?? 0);
  if (locked > 0) return locked.toFixed(2);
  const amount = Number(row.amount ?? 0);
  if (!(amount > 0)) return null;
  const usd = String(row.currency ?? 'KRW') === 'USD' ? amount : amount / (company.usdRate || 1500);
  if (!isFinite(usd) || usd <= 0) return null;
  return usd.toFixed(2);
}

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
  const webhookId = E('PAYPAL_WEBHOOK_ID', extra);
  return { clientId, secret, mode, base, webhookId, enabled: Boolean(clientId && secret) };
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

/**
 * 웹훅 서명 검증.
 * 웹훅 주소는 인터넷에 열려 있어 누구나 "결제 완료" 요청을 위조할 수 있다.
 * PayPal 이 헤더에 담아 보낸 서명을 PayPal 검증 API 에 되물어 진위를 확인한다.
 * SUCCESS 가 아니면 이벤트를 통째로 버린다 — 이 검증이 없으면 무료로 주문을 확정시킬 수 있다.
 */
export async function ppVerifyWebhook(
  headers: Headers,
  event: unknown,
): Promise<{ verified: boolean; reason: string }> {
  const { base, webhookId } = paypalCfg();
  if (!webhookId) return { verified: false, reason: 'no_webhook_id' };

  const h = (k: string) => headers.get(k) ?? '';
  const payload = {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: webhookId,
    webhook_event: event,
  };
  if (!payload.transmission_id || !payload.transmission_sig) {
    return { verified: false, reason: 'missing_headers' };
  }

  try {
    const token = await ppToken();
    const r = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = (await r.json()) as { verification_status?: string };
    if (!r.ok) return { verified: false, reason: `http_${r.status}` };
    return { verified: j.verification_status === 'SUCCESS', reason: j.verification_status ?? 'unknown' };
  } catch (e) {
    console.error('[paypal] 웹훅 검증 오류:', e);
    return { verified: false, reason: 'exception' };
  }
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
