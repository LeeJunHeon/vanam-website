// 견적 테스트 모드 전용: 고객 견적 폼의 "예상 견적 보기" API.
//
// ⚠️ 테스트 모드가 꺼진 빌드(일반·Cloudflare 빌드)에서는 GET·POST 모두 404 다.
//    켜짐은 npm run local 빌드뿐이다(src/lib/quote-test-mode.js).
//
//   GET  → 레시피 후보·기판 목록 등 선택지 메타만. 원가·요율·마진 숫자는 넣지 않는다.
//   POST → 폼 입력을 엑셀 형식으로 바꾸고(quote-map.js) 로컬 D1 의 price_* 로 computeQuote.
//          테스트용이라 원가 내역(breakdown)까지 전부 돌려준다. 계산은 항상 서버에서 한다.
import type { APIRoute } from 'astro';
import { db } from '../../lib/db';
import { rateLimit, tooMany } from '../../lib/rate-limit';
import { computeQuote } from '../../lib/quote-engine.js';
import { mapFormToQuote, recipeCandidates, QuoteMapError } from '../../lib/quote-map.js';
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

const RECIPE_META = `SELECT recipe_id, material_name, process_type, equipment_id, method, active
  FROM price_recipe`;

export const GET: APIRoute = async () => {
  if (!QUOTE_TEST) return NOT_FOUND();
  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);
  const recipes = await all(d, RECIPE_META);
  if (recipes.length === 0) return json(EMPTY, 503);
  const substrates = await all(d, `SELECT catalog_id, item_name, size_inch, category, active
    FROM price_substrate ORDER BY catalog_id`);
  const equipment = await all(d, `SELECT equipment_id, equipment_name
    FROM price_equipment ORDER BY equipment_id`);
  const log = (await all<{ imported_at: string; rules_version: string; source_sha256: string }>(d,
    `SELECT imported_at, rules_version, source_sha256
    FROM price_import_log ORDER BY id DESC LIMIT 1`))[0] ?? null;
  return json({
    ok: true,
    candidates: recipeCandidates(recipes as any),
    equipment,
    substrates: substrates
      .filter((s) => s.active === 1 || s.active === true)
      .map(({ catalog_id, item_name, size_inch, category }) => ({ catalog_id, item_name, size_inch, category })),
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
    substrates: await all(d, `SELECT catalog_id, item_name, category, unit, cost_per_unit, active
      FROM price_substrate`),
  };
  if (priceDb.policy.length === 0 || priceDb.recipes.length === 0) return json(EMPTY, 503);

  let mapped;
  try {
    mapped = mapFormToQuote(form, priceDb.recipes as any);
  } catch (e) {
    if (e instanceof QuoteMapError) return json({ ok: false, error: e.code, message: e.message }, 400);
    throw e;
  }
  const { items, layers, plan, extras } = mapped;
  const result = computeQuote(priceDb, { items, layers });
  // computed: 엔진 정상 · 제외 단계 없음 / partial: 제외 단계가 있고 나머지는 정상(산정할 품목이 하나도 없으면 금액 없음)
  // error: 엔진 오류
  const status = result.status === '정상' ? (extras.length ? 'partial' : 'computed')
    : items.length === 0 && extras.length ? 'partial' : 'error';

  // 예상 견적서(엑셀 '견적서' 탭 배치) — 엔진이 정상일 때만. 고객 = 폼의 이름·소속, 견적명 = 제품명.
  let docHtml: string | null = null;
  if (result.status === '정상') {
    const pv = (k: string) => (priceDb.policy as { key: string; value: string | null }[]).find((p) => p.key === k)?.value ?? '';
    const doc = body?.doc ?? {};
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    docHtml = buildQuoteDoc({
      info: {
        customer: [doc.company, doc.name].map((v: unknown) => String(v ?? '').trim()).filter(Boolean).join(' '),
        ref: '', title: String(doc.productName ?? ''), date: today, quoteNo: `TEST-${today.replace(/-/g, '')}`,
        manager: '', contact: telKr(company.tel), delivery: pv('default_delivery_due'), validDays: pv('quote_valid_days'), payment: '',
      },
      items: result.items.map((it: any, i: number) => it.status !== '정상' ? null : {
        name: String(items[i]?.name ?? ''), spec: it.spec, qty: items[i]?.qty, unit: items[i]?.unit,
        unitPrice: it.unitPrice, supply: it.supply, vat: it.vat,
      }),
      supply: result.supply as number, vat: result.vat as number, total: result.total as number,
      totalKorean: result.totalKorean as string,
      logoUrl: new URL('/logo.png', request.url).href,
    });
  }

  return json({ ok: true, status, plan, input: { items, layers }, result, extras, docHtml });
};
