// 관리자 전용: 환율 상태 확인 · 수동 갱신 · 수동 입력.
//
// 환율은 금액에 직결되는데 지연 갱신은 요청에 얹혀 돌기 때문에, 밖에서 상태를 볼 수 없으면
// 문제가 생겼을 때 원인을 좁힐 수 없다. 여기서 저장된 값·갱신 사유·환경 조건을 함께 돌려준다.
// 공개 엔드포인트가 아니라 관리자 인증이 필요하므로 상세 사유를 노출해도 안전하다.
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db } from '../../../lib/db';
import { readRate, refreshRate, pickWaitUntil } from '../../../lib/fx';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

/** 현재 상태 조회 (갱신하지 않는다) */
export const GET: APIRoute = async ({ request, locals }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);

  const d = await db();
  const cur = await readRate(d);

  // settings 테이블이 실제로 만들어졌는지 직접 확인한다(스키마 실패를 구분하기 위해).
  let tableExists: boolean | null = null;
  if (d) {
    try {
      const r = await d
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='settings'`)
        .first<{ name: string }>();
      tableExists = Boolean(r);
    } catch (e) {
      tableExists = null;
    }
  }

  return json({
    ok: true,
    rate: cur.rate,
    updatedAt: cur.updatedAt,
    source: cur.source,
    env: {
      hasDb: Boolean(d),                       // false 면 D1 바인딩·스키마 문제
      hasWaitUntil: Boolean(pickWaitUntil(locals)), // false 면 백그라운드 갱신 불가(부트스트랩 경로로 동작)
      settingsTable: tableExists,              // false 면 테이블 미생성
    },
  });
};

/**
 * POST { action: 'refresh' }        — 외부 API 로 즉시 갱신(사유 반환)
 * POST { action: 'set', rate: 1450 } — 수동 입력(비상용, 이상치 가드 우회)
 */
export const POST: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  const action = String(body.action ?? '');

  if (action === 'refresh') {
    const r = await refreshRate(d);
    const cur = await readRate(d);
    return json({ ok: true, saved: r.saved, reason: r.reason, rate: cur.rate, updatedAt: cur.updatedAt });
  }

  if (action === 'set') {
    const n = Number(body.rate);
    // 수동 입력은 이상치 가드를 우회하지만, 상식 범위는 지킨다.
    if (!Number.isFinite(n) || n < 500 || n > 5000) {
      return json({ ok: false, error: 'out_of_range' }, 400);
    }
    const now = new Date().toISOString();
    await d
      .prepare(
        `INSERT INTO settings (key, value, updated_at, source) VALUES ('usd_rate', ?, ?, 'manual')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, source = excluded.source`,
      )
      .bind(n, now, 'manual')
      .run();
    return json({ ok: true, saved: true, rate: n, updatedAt: now, source: 'manual' });
  }

  return json({ ok: false, error: 'bad_action' }, 400);
};
