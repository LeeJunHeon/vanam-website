// 고객 견적 폼의 예상 견적 API.
//
//   GET  → { ok, enabled } — 자동 견적을 쓸 수 있는가(운영 스위치 켜짐 && 가격 DB 있음).
//          가져오기 기록·해시 같은 내부 정보는 내보내지 않는다.
//   POST → 스위치가 꺼져 있으면 404. 켜져 있으면 { ok, customer } 만 돌려준다.
//          customer: estimate(합계·USD·유효기간) / manual(담당자 확인 항목) / invalid(입력 오류).
//          단가·공급가액·세액·원가·ID 는 넣지 않는다(src/lib/quote-customer.js).
//
// 계산은 항상 서버에서 한다. 환율은 웨이퍼와 같은 저장값(readRate)을 쓴다.
// 스위치는 관리자 API(/api/admin/quote-auto)에서만 켜고 끈다 — 기본 꺼짐.
import type { APIRoute } from 'astro';
import { db } from '../../lib/db';
import { rateLimit, tooMany } from '../../lib/rate-limit';
import { readRate } from '../../lib/fx';
import { formatUsd } from '../../lib/price';
import { computeQuote } from '../../lib/quote-engine.js';
import { QuoteMapError } from '../../lib/quote-map.js';
import { estimateForCustomer } from '../../lib/quote-customer.js';
import { loadPriceDbCached } from '../../lib/price-db';
import { quoteAutoEnabled } from '../../lib/quote-auto';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
const NOT_FOUND = () => new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
const MAX_BODY = 65_536; // 64KB — 공정 수십 단계를 넉넉히 담는 크기
const MAX_STEPS = 100;
const MAX_MEASUREMENTS = 30;

export const GET: APIRoute = async () => {
  let enabled = false;
  try {
    enabled = await quoteAutoEnabled(await db());
  } catch {
    enabled = false;
  }
  return json({ ok: true, enabled });
};

export const POST: APIRoute = async ({ request }) => {
  const d = await db();
  if (!(await quoteAutoEnabled(d)) || !d) return NOT_FOUND();

  const rl = await rateLimit(d, 'quoteEstimate', request);
  if (!rl.ok) return tooMany(rl.retryAfterSec);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 400);
  let body: Record<string, any>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const form = body?.form;
  if (!form || typeof form !== 'object' || !Array.isArray(form.steps)) return json({ ok: false, error: 'bad_shape' }, 400);
  // 계산 전 상한 — 폼이 만들 수 있는 크기보다 넉넉하다. 넘으면 고객 화면이 "요청사항에 적어 보내 주세요"로 안내한다.
  if (form.steps.length > MAX_STEPS || (Array.isArray(form.measurements) && form.measurements.length > MAX_MEASUREMENTS)) {
    return json({ ok: false, error: 'too_many_steps' }, 400);
  }

  const priceDb = await loadPriceDbCached(d);
  const fx = await readRate(d);
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); // 한국 날짜
  try {
    const { customer } = estimateForCustomer({ form, priceDb, computeQuote, formatUsd, usdRate: fx.rate, today });
    return json({ ok: true, customer });
  } catch (e) {
    if (e instanceof QuoteMapError) return json({ ok: false, error: e.code }, 400);
    throw e;
  }
};
