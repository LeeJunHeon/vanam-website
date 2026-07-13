import type { APIRoute } from 'astro';

// 서버에서 온디맨드 실행 (정적 생성 금지)
export const prerender = false;

type Payload = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const MAX = 2000; // 필드당 최대 길이 (남용 방지)

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const POST: APIRoute = async ({ request, locals }) => {
  let body: Payload;
  try {
    body = (await request.json()) as Payload;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // 1) 허니팟: 봇이 채웠으면 조용히 성공 응답 (알림은 보내지 않음)
  if (str(body.vanam_hp_email) !== '') {
    return json({ ok: true, delivered: false, spam: true });
  }

  // 2) 공통 필수: 담당자명 · 이메일 · 개인정보 동의
  const type = str(body.type) === 'general' ? 'general' : 'quote';
  const name = str(body.name).slice(0, MAX);
  const email = str(body.email).slice(0, MAX);

  if (!name || !email || str(body.privacy) !== 'agreed') {
    return json({ ok: false, error: 'missing_required' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: 'invalid_email' }, 400);
  }

  // 3) 유형별 필수
  //    견적(스토어 상품에서만 접수) → 상품 + 소재
  //    기타 문의 → 문의 내용
  const material = str(body.material).slice(0, MAX);
  const message = str(body.message).slice(0, MAX);
  const product = str(body.product).slice(0, MAX);
  const productName = str(body.productName).slice(0, MAX) || product;
  if (type === 'quote' && !product) {
    return json({ ok: false, error: 'missing_product' }, 400);
  }
  if (type === 'quote' && !material) {
    return json({ ok: false, error: 'missing_material' }, 400);
  }
  if (type === 'general' && !message) {
    return json({ ok: false, error: 'missing_message' }, 400);
  }

  // 4) 선택 항목
  const phone = str(body.phone).slice(0, MAX);
  const company = str(body.company).slice(0, MAX);
  const locale = str(body.locale) === 'ko' ? 'ko' : 'en';

  const dash = '—';
  const who = `담당: ${name}${company ? ` (${company})` : ''} · ${email}${phone ? ` · ${phone}` : ''}`;
  const meta = `(언어: ${locale} · 접수: ${new Date().toISOString()})`;

  let text: string;
  if (type === 'quote') {
    const method = str(body.method).slice(0, MAX);
    const substrate = str(body.substrate).slice(0, MAX);
    const thickness = str(body.thickness).slice(0, MAX);
    const quantity = str(body.quantity).slice(0, MAX);
    const deadline = str(body.deadline).slice(0, MAX);
    const details = str(body.details).slice(0, MAX);
    text = [
      '📩 *새 견적 요청*',
      `상품: ${productName} (${product})`,
      who,
      `소재: ${material} | 방식: ${method || dash} | 기판: ${substrate || dash}`,
      `두께: ${thickness || dash} | 수량: ${quantity || dash} | 납기: ${deadline || dash}`,
      `요청: ${details || dash}`,
      meta,
    ].join('\n');
  } else {
    text = ['✉️ *새 문의*', who, `내용: ${message}`, meta].join('\n');
  }

  // 5) Google Chat 웹훅 전송
  //    - Cloudflare 런타임: locals.runtime.env
  //    - dev(Node): .env 파일 → import.meta.env
  const runtimeEnv = (locals as { runtime?: { env?: Record<string, string> } })?.runtime?.env;
  const webhook = runtimeEnv?.GOOGLE_CHAT_WEBHOOK ?? import.meta.env.GOOGLE_CHAT_WEBHOOK ?? '';

  if (!webhook) {
    // 웹훅 미설정: 전송하지 않고 서버 로그로만 확인 (로컬 테스트 경로)
    console.log('[inquiry] GOOGLE_CHAT_WEBHOOK not set. Payload:\n' + text);
    return json({ ok: true, delivered: false });
  }

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error('[inquiry] webhook failed:', res.status, await res.text().catch(() => ''));
      return json({ ok: false, error: 'webhook_failed' }, 502);
    }
  } catch (err) {
    console.error('[inquiry] webhook error:', err);
    return json({ ok: false, error: 'webhook_error' }, 502);
  }

  return json({ ok: true, delivered: true, type });
};
