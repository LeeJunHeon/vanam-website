import type { APIRoute } from 'astro';
// Astro 6부터 Astro.locals.runtime.env 가 제거되어(접근 시 예외를 던짐)
// Cloudflare 런타임 환경변수는 이 모듈에서 직접 읽는다.
// dev(순수 Node)에서는 astro.config.mjs의 shim이 빈 객체를 돌려주고, .env 로 폴백한다.
import { env as cfEnv } from 'cloudflare:workers';
import { db, newId, nowIso, nowKst } from '../../lib/db';
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
  //    신·구 이름을 모두 검사한다 — 배포 시차 동안 양쪽 폼이 공존할 수 있다.
  if (str(body.vanam_hp_note) !== '' || str(body.vanam_hp_email) !== '') {
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
  const sampleCount = str(body.sampleCount).slice(0, 20);
  // 배송지(0214) — 전달 방식이 배송/택배일 때 폼에서 온다. details 에 합류시켜 챗·admin·D1 에 함께 남긴다.
  const details = str(body.details).slice(0, MAX);
  // 조회 화면에서 보는 언어로 다시 그리기 위한 구조화 사본(라벨 붙이기 전의 값들).
  // ⚠️ 일반 필드 상한(2000자)을 쓰면 공정 12단계 + 분석 다수 + 긴 요청사항인 견적에서 잘려
  //    JSON 이 깨진다. 깨지면 조용히 기존 문장으로 되돌아가 기능만 못 쓰게 된다.
  //    이미 각 항목이 폼에서 제한된 값들을 모아 담은 것이라 상한을 따로 넉넉히 준다.
  const detailsJson = str(body.detailsJson).slice(0, 8000);

  // 접수번호 — 알림과 DB, 관리자 화면에서 같은 값을 쓴다
  const id = newId('INQ');
  const dash = '—';
  const who = `담당: ${name}${company ? ` (${company})` : ''} · ${email}${phone ? ` · ${phone}` : ''}`;
  const meta = `접수번호 ${id} · ${locale} · ${nowKst()} (KST)`;

  let text: string;
  if (type === 'quote') {
    text = [
      '📩 *새 견적 요청*',
      `상품: ${productName} (${product})`,
      who,
      `기판: ${substrate || dash} | 총 샘플: ${sampleCount || dash}`,
      // ⚠️ 예전 견적 폼의 '두께·수량·납기' 줄은 뺐다. 지금 폼에는 그 항목이 없어서
      //    **항상 `두께: — | 수량: — | 납기: —`** 로만 찍혔다(실제 입력값이 아니다).
      //    같은 정보는 아래 요청 본문에 '총 샘플 수량'·'완료 희망일'로 이미 들어 있다.
      `\n${details || dash}`,
      meta,
    ].filter(Boolean).join('\n');
  } else {
    text = ['✉️ *새 문의*', who, `내용: ${message}`, meta].join('\n');
  }

  // 5) D1에 저장 — 알림을 놓쳐도 요청이 사라지지 않도록 남긴다.
  //    DB가 없거나(dev) 실패해도 알림은 나가야 하므로 예외를 삼킨다.
  try {
    const d = await db();
    if (d) {
      const base = [
        id, type, 'new', name, email, phone || null, company || null,
        message || null, product || null, productName || null,
        material || null, method || null, substrate || null, details || null,
        locale, nowIso(),
      ];
      // thickness·quantity·deadline 컬럼은 지금 폼에 없는 항목이라 더 이상 쓰지 않는다.
      // (컬럼 자체는 옛 데이터를 위해 남겨둔다 — 값은 NULL 이 된다)
      const COLS =
        `(id, type, status, name, email, phone, company, message,
          product_sku, product_name, material, method, substrate,
          details, locale, created_at`;
      const VALS = `VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?`;
      try {
        // details_json 컬럼이 있는 정상 경로
        await d
          .prepare(`INSERT INTO inquiries ${COLS}, details_json) ${VALS},?)`)
          .bind(...base, detailsJson || null)
          .run();
      } catch (colErr) {
        // ⚠️ 컬럼 추가(ALTER TABLE) 전에 배포되면 위 INSERT 가 실패한다.
        //    그때 그냥 던지면 **고객 견적이 통째로 사라진다.** 구조화 사본만 포기하고 접수는 반드시 남긴다.
        console.warn('[inquiry] details_json 컬럼 없음 — 구조화 사본 없이 저장합니다:', colErr);
        await d
          .prepare(`INSERT INTO inquiries ${COLS}) ${VALS})`)
          .bind(...base)
          .run();
      }
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
    return json({ ok: true, delivered: false, id });
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

  return json({ ok: true, delivered: true, type, id });
};
