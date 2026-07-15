import type { APIRoute } from 'astro';
// Astro 6부터 Astro.locals.runtime.env 가 제거되어(접근 시 예외를 던짐)
// Cloudflare 런타임 환경변수는 이 모듈에서 직접 읽는다.
// dev(순수 Node)에서는 astro.config.mjs의 shim이 빈 객체를 돌려주고, .env 로 폴백한다.
import { env as cfEnv } from 'cloudflare:workers';
import { db, newId, nowIso } from '../../lib/db';
import { rateLimit, tooMany } from '../../lib/rate-limit';
import { verifyTurnstile } from '../../lib/turnstile';

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

export const POST: APIRoute = async ({ request }) => {
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

  // 1-2) 레이트리밋: IP당 10분에 5회. (허니팟 통과 후에 센다 —
  //      봇은 위에서 조용히 걸러지므로, 여기서는 실제 사람의 반복 제출만 카운트된다)
  const rl = await rateLimit(await db(), 'inquiry', request);
  if (!rl.ok) return tooMany(rl.retryAfterSec);

  // 1-3) Turnstile 캡챠 검증. (허니팟 통과 후 — 봇은 위에서 걸러지고 사람만 검증)
  //      키 미설정/네트워크 오류면 통과(가용성 우선), 토큰 없음/무효면 차단.
  const ts = await verifyTurnstile(str(body['cf-turnstile-response']), request);
  if (!ts.ok) return json({ ok: false, error: 'captcha_failed' }, 400);

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
  //    견적(제품 상품에서만 접수) → 상품 + 소재
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
  const method = str(body.method).slice(0, MAX);
  const substrate = str(body.substrate).slice(0, MAX);
  const thickness = str(body.thickness).slice(0, MAX);
  const quantity = str(body.quantity).slice(0, MAX);
  const deadline = str(body.deadline).slice(0, MAX);
  const details = str(body.details).slice(0, MAX);

  // 접수번호 — 알림과 DB, 관리자 화면에서 같은 값을 쓴다
  const id = newId('INQ');
  const dash = '—';
  const who = `담당: ${name}${company ? ` (${company})` : ''} · ${email}${phone ? ` · ${phone}` : ''}`;
  const meta = `접수번호 ${id} · ${locale} · ${new Date().toISOString()}`;

  let text: string;
  if (type === 'quote') {
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

  // 5) D1에 저장 — 알림을 놓쳐도 요청이 사라지지 않도록 남긴다.
  //    DB가 없거나(dev) 실패해도 알림은 나가야 하므로 예외를 삼킨다.
  try {
    const d = await db();
    if (d) {
      await d
        .prepare(
          `INSERT INTO inquiries
             (id, type, status, name, email, phone, company, message,
              product_sku, product_name, material, method, substrate, thickness,
              quantity, deadline, details, locale, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          id, type, 'new', name, email, phone || null, company || null,
          message || null, product || null, productName || null,
          material || null, method || null, substrate || null, thickness || null,
          quantity || null, deadline || null, details || null,
          locale, nowIso(),
        )
        .run();
    } else {
      console.warn('[inquiry] D1 미연결 — 알림만 발송합니다.');
    }
  } catch (e) {
    console.error('[inquiry] DB 저장 실패 (알림은 계속 진행):', e);
  }

  // 6) Google Chat 웹훅 전송
  //    - 배포(Cloudflare workerd): cloudflare:workers 의 env
  //    - dev(Node): .env 파일 → import.meta.env
  //    대시보드 입력칸이 여러 줄이라 개행·따옴표가 섞여 들어올 수 있어 정리한다.
  const raw =
    (cfEnv as Record<string, unknown> | undefined)?.GOOGLE_CHAT_WEBHOOK ??
    import.meta.env.GOOGLE_CHAT_WEBHOOK ??
    '';
  const webhook = typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';

  if (!webhook) {
    // 웹훅 미설정: 전송하지 않는다.
    // ⚠️ 여기에 payload(text)를 로그로 남기면 이름·이메일·전화·문의내용이 로그에 그대로 쌓인다.
    //    접수번호만 남겨 진단 가능하게 하고, PII 는 로그에 남기지 않는다.
    console.warn('[inquiry] GOOGLE_CHAT_WEBHOOK 미설정 — 알림을 건너뜁니다. 접수번호:', id);
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
