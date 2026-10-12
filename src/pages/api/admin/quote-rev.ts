// 관리자 전용: 문의별 견적 편집 API (/admin/quote?id=INQ-… 화면이 부른다).
//
//   GET  ?id=INQ-…[&rev=N] → 문의 · 개정 목록 · 불러올 개정(input·info) · 고객 화면 미리보기(view)
//   POST { id, baseRev, items, layers, info, note, confirm }
//        → 서버에서 다시 계산(computeQuote) → '정상'일 때만 새 개정(source 'admin')으로 저장.
//          화면의 계산 결과는 미리보기일 뿐 저장값의 근거가 아니다.
//        → 저장과 문의 행 갱신(확정 금액·상태)은 D1 batch 하나로 — 한쪽만 남지 않는다.
//        → 같은 기준 개정으로 두 곳이 저장하면 UNIQUE(inquiry_id, rev) 위반으로 한쪽이 409 conflict.
//
// ⚠️ 담당자 저장·확정은 구글챗 알림을 보내지 않는다.
// ⚠️ 로그에는 접수번호·오류 종류만 남긴다(이름·이메일·금액 금지).
// ⚠️ SELECT·UPDATE 는 컬럼 이름을 적는다(scripts/check-schema.mjs). 문의 행만 SELECT * — 조회 API 와 같은 이유
//    (quote_currency·paid_at 컬럼이 늦게 추가된 DB 에서도 동작해야 한다).
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db, nowIso } from '../../../lib/db';
import { computeQuote } from '../../../lib/quote-engine.js';
import { loadPriceDbCached, latestImport } from '../../../lib/price-db';
import {
  latestRevision, getRevision, listRevisions, revisionInsertStatement, isUniqueViolation,
  type RevisionRow,
} from '../../../lib/quote-store';
import { buildAutoRevision, buildDoc, contactFor, customerQuoteView, defaultDocInfo, formFromDetails } from '../../../lib/quote-revision.js';
import { manualLabelAdmin } from '../../../lib/quote-customer.js';
import { sanitizeDocInfo, planInquirySync, summarizeRevisions } from '../../../lib/quote-admin.js';
import { readRate } from '../../../lib/fx';
import { formatUsd } from '../../../lib/price';
import company from '../../../data/company.json';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const ID_RE = /^INQ-\d{8}-[A-Z0-9]{4}$/;
const MAX_ITEMS = 15;     // 엑셀 V3_견적입력 15~29행 (quote-calc 와 같음)
const MAX_LAYERS = 100;   // 엑셀 V3_박막공정 2~101행
const MAX_BODY = 200_000;
const MAX_NOTE = 500;

type D1 = NonNullable<Awaited<ReturnType<typeof db>>>;
type Inq = Record<string, unknown>;

const kstToday = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const isObj = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (s: unknown) => {
  if (s === null || s === undefined || s === '') return null;
  try { return JSON.parse(String(s)); } catch { return null; }
};
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function readInquiry(d: D1, id: string): Promise<Inq | null> {
  return (await d.prepare(`SELECT * FROM inquiries WHERE id = ?`).bind(id).first<Inq>()) ?? null;
}

/** customerQuoteView 에 넘길 문의 값 */
const inquiryForView = (q: Inq) => ({
  quoted_amount: numOrNull(q.quoted_amount),
  quote_currency: (q.quote_currency as string | null) ?? null,
  paid_at: (q.paid_at as string | null) ?? null,
});

async function viewOf(d: D1, revision: RevisionRow | null, q: Inq) {
  if (!revision) return null;
  const fx = await readRate(d);
  return customerQuoteView({ revision, inquiry: inquiryForView(q), locale: 'ko', usdRate: fx.rate, formatUsd });
}

const manualAdminOf = (s: string | null) => {
  const v = parse(s);
  return Array.isArray(v) ? v.map(manualLabelAdmin) : [];
};

export const GET: APIRoute = async ({ request, url }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);
  const id = String(url.searchParams.get('id') ?? '').trim().toUpperCase();
  if (!ID_RE.test(id)) return json({ ok: false, error: 'bad_id' }, 400);
  const revParam = url.searchParams.get('rev');
  let wantRev: number | null = null;
  if (revParam !== null) {
    wantRev = Number(revParam);
    if (!Number.isInteger(wantRev) || wantRev < 1) return json({ ok: false, error: 'bad_rev' }, 400);
  }

  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  try {
    const q = await readInquiry(d, id);
    if (!q) return json({ ok: false, error: 'not_found' }, 404);
    if (q.type !== 'quote') return json({ ok: false, error: 'not_quote' }, 400);

    const locale = q.locale === 'en' ? 'en' : 'ko';
    const revisions = await listRevisions(d, id);
    const latest = await latestRevision(d, id);
    const cur = wantRev === null ? latest : await getRevision(d, id, wantRev);
    if (wantRev !== null && !cur) return json({ ok: false, error: 'rev_not_found' }, 404);

    // 접수 시 자동 견적(가장 앞 auto 개정) — 담당자 확인 사유·폼에서 본 금액 비교용
    const firstAutoRev = revisions.find((r) => r.source === 'auto')?.rev;
    const firstAutoRow = firstAutoRev ? await getRevision(d, id, firstAutoRev) : null;
    const firstAuto = firstAutoRow ? summarizeRevisions([firstAutoRow]).first : null;

    const priceDb = await loadPriceDbCached(d);
    const ready = priceDb.policy.length > 0 && priceDb.recipes.length > 0;
    const imp = ready ? await latestImport(d) : null;
    const today = kstToday();

    const current = cur && {
      rev: cur.rev,
      source: cur.source,
      kind: cur.kind,
      total: cur.total,
      input: parse(cur.input_json),
      info: isObj(parse(cur.doc_json)?.info) ? parse(cur.doc_json).info : null,
      manualAdmin: manualAdminOf(cur.manual_json),
      note: cur.note,
      price_sha: cur.price_sha,
      created_at: cur.created_at,
    };

    const infoDefault = defaultDocInfo({
      inquiry: { id, name: q.name as string, company: q.company as string, productName: q.product_name as string },
      policy: priceDb.policy, today, contact: contactFor(locale, company.tel), locale,
    });

    // 불러올 입력이 없을 때만 — 접수 구조화 사본으로 자동 견적과 같은 입력을 만든다(저장하지 않는다)
    // ⚠️ 여기서 실패해도 편집기는 열려야 한다 — prefill 만 null.
    let prefill: { input: unknown; manualAdmin: string[] } | null = null;
    if ((!current || current.input === null) && ready) {
      try {
        const dj = parse(q.details_json);
        if (formFromDetails(dj, locale)) {
          const auto = buildAutoRevision({ details: dj, locale, priceDb, computeQuote, today, info: infoDefault });
          if (auto) prefill = { input: auto.input, manualAdmin: (auto.manual ?? []).map(manualLabelAdmin) };
        }
      } catch (e) {
        console.error('[admin/quote-rev] prefill 계산 실패(편집기는 연다):', id, (e as Error)?.name ?? 'Error');
        prefill = null;
      }
    }

    return json({
      ok: true,
      inquiry: {
        id: q.id, status: q.status, name: q.name, company: q.company ?? null, email: q.email, phone: q.phone ?? null,
        locale, product_name: q.product_name ?? null, details: q.details ?? null,
        quoted_amount: numOrNull(q.quoted_amount), quote_currency: q.quote_currency ?? null,
        paid_at: q.paid_at ?? null, created_at: q.created_at,
      },
      revisions,
      current,
      latestRev: latest?.rev ?? 0,
      firstAuto,
      prefill,
      defaultInfo: infoDefault,
      priceDb: { ready, sha12: imp ? String(imp.source_sha256 ?? '').slice(0, 12) : null },
      view: await viewOf(d, latest, q),
    });
  } catch (e) {
    console.error('[admin/quote-rev] 읽기 실패:', id, (e as Error)?.name ?? 'Error');
    return json({ ok: false, error: 'db_error' }, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 400);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  if (!isObj(body)) return json({ ok: false, error: 'bad_shape' }, 400);

  const id = typeof body.id === 'string' ? body.id.trim().toUpperCase() : '';
  if (!ID_RE.test(id)) return json({ ok: false, error: 'bad_id' }, 400);
  const baseRev = body.baseRev;
  if (typeof baseRev !== 'number' || !Number.isInteger(baseRev) || baseRev < 0) return json({ ok: false, error: 'bad_base_rev' }, 400);
  if (typeof body.confirm !== 'boolean') return json({ ok: false, error: 'bad_confirm' }, 400);
  const confirm = body.confirm;
  const items = body.items;
  const layers = body.layers;
  if (!Array.isArray(items) || !Array.isArray(layers) || !items.every(isObj) || !layers.every(isObj)) {
    return json({ ok: false, error: 'bad_shape' }, 400);
  }
  if (items.length > MAX_ITEMS) return json({ ok: false, error: 'too_many_items', max: MAX_ITEMS }, 400);
  if (layers.length > MAX_LAYERS) return json({ ok: false, error: 'too_many_layers', max: MAX_LAYERS }, 400);
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return json({ ok: false, error: 'bad_note' }, 400);
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > MAX_NOTE) return json({ ok: false, error: 'note_too_long', max: MAX_NOTE }, 400);
  if (body.info !== undefined && body.info !== null && !isObj(body.info)) return json({ ok: false, error: 'bad_info' }, 400);

  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  try {
    const q = await readInquiry(d, id);
    if (!q) return json({ ok: false, error: 'not_found' }, 404);
    if (q.type !== 'quote') return json({ ok: false, error: 'not_quote' }, 400);
    // 결제된 견적은 고치지 않는다(결제 사실이 최우선) — planInquirySync 와 같은 판정을 먼저 한 번
    if (q.paid_at) return json({ ok: false, error: 'already_paid' }, 409);

    // 기준 개정이 최신이 아니면 저장하지 않는다(번호 건너뛰기·덮어쓰기 방지). 동시 저장은 아래 UNIQUE 가 막는다.
    const latestBefore = await latestRevision(d, id);
    const latestRev = latestBefore?.rev ?? 0;
    if (baseRev !== latestRev) return json({ ok: false, error: 'conflict', latestRev }, 409);

    const priceDb = await loadPriceDbCached(d);
    if (priceDb.policy.length === 0 || priceDb.recipes.length === 0) return json({ ok: false, error: 'price_db_empty' }, 503);

    const result = computeQuote(priceDb, { items, layers });
    if (result.status !== '정상') return json({ ok: false, error: 'engine', status: result.status, result }, 400);

    const info = sanitizeDocInfo(body.info, { today: kstToday() });
    const doc = buildDoc({ input: { items }, result, info });
    const plan = planInquirySync({ inquiry: inquiryForView(q), total: result.total, confirm }) as
      { error?: string; update?: Record<string, unknown> | null; warning?: string };
    if (plan.error === 'already_paid') return json({ ok: false, error: 'already_paid' }, 409);
    if (plan.error) return json({ ok: false, error: plan.error }, 400);

    const imp = await latestImport(d);
    const { rev, stmt } = revisionInsertStatement(d, id, baseRev, {
      source: 'admin', kind: 'estimate', total: result.total,
      input: { items, layers }, result, doc, manual: [], seenTotal: null,
      priceSha: imp?.source_sha256 ?? null, note: note || null,
    });
    const stmts: unknown[] = [stmt];
    const u = plan.update;
    if (u && 'status' in u) {
      stmts.push(d.prepare(`UPDATE inquiries SET quoted_amount = ?, quote_currency = ?, status = ?, updated_at = ? WHERE id = ? AND paid_at IS NULL`)
        .bind(u.quoted_amount, u.quote_currency, u.status, nowIso(), id));
    } else if (u) {
      stmts.push(d.prepare(`UPDATE inquiries SET quoted_amount = ?, updated_at = ? WHERE id = ? AND paid_at IS NULL`)
        .bind(u.quoted_amount, nowIso(), id));
    }

    try {
      await d.batch(stmts);
    } catch (e) {
      if (isUniqueViolation(e)) {
        const again = await latestRevision(d, id);
        console.warn('[admin/quote-rev] 저장 충돌:', id);
        return json({ ok: false, error: 'conflict', latestRev: again?.rev ?? 0 }, 409);
      }
      throw e;
    }

    // 여기부터는 이미 저장된 상태 — 확인 읽기가 실패해도 저장 실패(db_error)로 답하면 안 된다.
    const head = { ok: true, rev, total: result.total, ...(plan.warning ? { warning: plan.warning } : {}) };
    try {
      const q2 = (await readInquiry(d, id)) ?? q;
      const saved = await getRevision(d, id, rev);
      return json({
        ...head,
        inquiry: { status: q2.status, quoted_amount: numOrNull(q2.quoted_amount), quote_currency: q2.quote_currency ?? null },
        view: await viewOf(d, saved, q2),
      });
    } catch (e) {
      console.error('[admin/quote-rev] 저장 뒤 확인 읽기 실패(저장은 됨):', id, (e as Error)?.name ?? 'Error');
      return json({ ...head, unverified: true, inquiry: null, view: null });
    }
  } catch (e) {
    console.error('[admin/quote-rev] 저장 실패:', id, (e as Error)?.name ?? 'Error');
    return json({ ok: false, error: 'db_error' }, 500);
  }
};
