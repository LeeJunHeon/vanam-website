// 관리자 전용: 운영 스위치 '자동 견적' 조회·변경.
//
//   GET  → { ok, on, priceDb: { ready, counts, importLog, fingerprint } } — 스위치 값과 가격 DB 준비 상태
//          fingerprint = 지금 가격 DB 의 데이터 지문(sha256 64자, price-sheet.js) — 비었으면 null
//   POST → { on: true | false } 저장 후 { ok, on }
//
// 스위치를 켜고 끄는 곳은 여기 하나뿐이다(기본 꺼짐). 켜져 있어도 가격 DB 가 비어 있으면
// 자동 견적은 동작하지 않는다(quoteAutoEnabled).
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db } from '../../../lib/db';
import { readQuoteAuto, writeQuoteAuto } from '../../../lib/quote-auto';
import { priceDbReady, latestImport, readPriceTables } from '../../../lib/price-db';
import { priceRowsForDb, priceFingerprint } from '../../../lib/price-sheet.js';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

type D1 = NonNullable<Awaited<ReturnType<typeof db>>>;
const count = async (d: D1, sql: string) => Number((await d.prepare(sql).first<{ n: number }>())?.n ?? 0);

export const GET: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);
  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  const log = await latestImport(d);
  const ready = await priceDbReady(d);
  const tables = await readPriceTables(d);
  const fingerprint = ready ? await priceFingerprint(priceRowsForDb(tables)) : null;
  return json({
    ok: true,
    on: await readQuoteAuto(d),
    priceDb: {
      ready,
      counts: {
        policy: await count(d, `SELECT count(*) AS n FROM price_policy`),
        recipes: await count(d, `SELECT count(*) AS n FROM price_recipe`),
        equipment: await count(d, `SELECT count(*) AS n FROM price_equipment`),
        substrates: await count(d, `SELECT count(*) AS n FROM price_substrate`),
        aliases: tables.price_alias.length,
      },
      fingerprint,
      importLog: log && {
        imported_at: log.imported_at,
        rules_version: log.rules_version,
        sha256: String(log.source_sha256 ?? '').slice(0, 12),
      },
    },
  });
};

export const POST: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  if (typeof body?.on !== 'boolean') return json({ ok: false, error: 'on_must_be_boolean' }, 400);
  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);
  await writeQuoteAuto(d, body.on);
  return json({ ok: true, on: await readQuoteAuto(d) });
};
