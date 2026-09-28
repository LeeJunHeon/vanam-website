// 견적 테스트 모드 전용: 고객 견적 폼의 "예상 견적 보기" API.
//
// ⚠️ 운영 전환 시 debug 는 통째로 제거한다. (debug 에는 품목·층·원가 내역·장비/레시피/기판 ID 가 들어 있다)
// ⚠️ 테스트 모드가 꺼진 빌드(일반·Cloudflare 빌드)에서는 GET·POST 모두 404 다.
//    켜짐은 npm run local 빌드뿐이다(src/lib/quote-test-mode.js).
//
//   GET  → 로컬 가격 DB 가져오기 기록만(화면 표시용).
//   POST → { ok, customer, debug }
//          customer: 고객에게 보일 것만 — estimate(합계·USD·유효기간) / manual(담당자 확인 항목) / invalid(입력 오류).
//                    단가·공급가액·세액·원가·ID 는 넣지 않는다(src/lib/quote-customer.js).
//          debug:    내부 확인용(계산 입력·엔진 결과·산정 제외·예상 견적서 HTML·flags).
//   계산은 항상 서버에서 한다. 환율은 웨이퍼와 같은 저장값(readRate)을 쓴다.
import type { APIRoute } from 'astro';
import { db } from '../../lib/db';
import { rateLimit, tooMany } from '../../lib/rate-limit';
import { readRate } from '../../lib/fx';
import { formatUsd } from '../../lib/price';
import { computeQuote } from '../../lib/quote-engine.js';
import { QuoteMapError } from '../../lib/quote-map.js';
import { estimateForCustomer } from '../../lib/quote-customer.js';
import { buildQuoteDoc, telKr } from '../../lib/quote-doc';
import company from '../../data/company.json';

export const prerender = false;

declare const __VANAM_QUOTE_TEST__: string;
// 비교 대상 문자열을 적지 않는다 — 번들 안의 표식은 빌드가 넣은 값뿐이어야 게이트가 판정할 수 있다.
const QUOTE_TEST: boolean = __VANAM_QUOTE_TEST__.endsWith('_ON');

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
const NOT_FOUND = () => new Response('Not Found', { status: 404 });
const MAX_BODY = 65_536; // 64KB — 공정 수십 단계를 넉넉히 담는 크기
const EMPTY = { ok: false, error: 'price_db_empty', hint: '로컬 가격 DB 가 비어 있습니다. npm run price:import 를 먼저 실행하세요.' };

type D1 = NonNullable<Awaited<ReturnType<typeof db>>>;
const all = async <T = Record<string, unknown>>(d: D1, sql: string) =>
  (await d.prepare(sql).all<T>()).results ?? [];

export const GET: APIRoute = async () => {
  if (!QUOTE_TEST) return NOT_FOUND();
  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);
  const log = (await all<{ imported_at: string; rules_version: string; source_sha256: string }>(d,
    `SELECT imported_at, rules_version, source_sha256
    FROM price_import_log ORDER BY id DESC LIMIT 1`))[0] ?? null;
  return json({
    ok: true,
    importLog: log && { imported_at: log.imported_at, rules_version: log.rules_version, sha256: String(log.source_sha256 ?? '').slice(0, 12) },
  });
};

export const POST: APIRoute = async ({ request }) => {
  if (!QUOTE_TEST) return NOT_FOUND();
  const d = await db();
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
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  const priceDb = {
    policy: await all(d, `SELECT key, value, vtype FROM price_policy`),
    recipes: await all(d, `SELECT recipe_id, material_name, process_type, equipment_id, method,
      material_cost_per_nm, growth_nm_per_min, default_temp_c,
      loading_override_min, plasma_override_min, setup_override_min,
      legacy_min_charge, active
      FROM price_recipe`),
    equipment: await all(d, `SELECT equipment_id, equipment_name, process_type, rate_per_min,
      default_loading_min, default_plasma_min, default_setup_min, active
      FROM price_equipment`),
    substrates: await all(d, `SELECT catalog_id, item_name, category, unit, cost_per_unit, size_inch, oxide_nm, active
      FROM price_substrate`),
  };
  if (priceDb.policy.length === 0 || priceDb.recipes.length === 0) return json(EMPTY, 503);

  const fx = await readRate(d);
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); // 한국 날짜
  let out;
  try {
    out = estimateForCustomer({ form, priceDb, computeQuote, formatUsd, usdRate: fx.rate, today });
  } catch (e) {
    if (e instanceof QuoteMapError) return json({ ok: false, error: e.code, message: e.message }, 400);
    throw e;
  }
  const { customer, debug } = out as { customer: any; debug: any };

  // 예상 견적서(엑셀 '견적서' 탭 배치) — 내부 확인용. 엔진이 정상일 때만.
  let docHtml: string | null = null;
  const result = debug.result;
  if (result?.status === '정상') {
    const pv = (k: string) => (priceDb.policy as { key: string; value: string | null }[]).find((p) => p.key === k)?.value ?? '';
    const items = debug.input.items;
    docHtml = buildQuoteDoc({
      info: {
        customer: [body?.doc?.company, body?.doc?.name].map((v: unknown) => String(v ?? '').trim()).filter(Boolean).join(' '),
        ref: '', title: String(body?.doc?.productName ?? ''), date: today, quoteNo: `TEST-${today.replace(/-/g, '')}`,
        manager: '', contact: telKr(company.tel), delivery: pv('default_delivery_due'), validDays: pv('quote_valid_days'), payment: '',
      },
      items: result.items.map((it: any, i: number) => it.status !== '정상' ? null : {
        name: String(items[i]?.name ?? ''), spec: it.spec, qty: items[i]?.qty, unit: items[i]?.unit,
        unitPrice: it.unitPrice, supply: it.supply, vat: it.vat,
      }),
      supply: result.supply, vat: result.vat, total: result.total, totalKorean: result.totalKorean,
      logoUrl: new URL('/logo.png', request.url).href,
    });
  }

  return json({ ok: true, customer, debug: { ...debug, docHtml, fx: { rate: fx.rate, source: fx.source } } });
};
