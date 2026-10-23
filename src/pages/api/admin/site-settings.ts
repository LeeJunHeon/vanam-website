// 관리자 전용: 운영 설정(설정 탭 '운영 설정' 카드).
//   GET                      → 항목마다 { key, group, label, help, unit, kind, value, def, min, max, updated_at }  (kind 'toggle' = 켬/끔 0/1 · 'number')
//   POST { key, value }      → 범위 검사 후 저장(즉시 반영)
// 규칙(항목·범위)은 src/lib/site-settings.js 한 곳. 예민한 값(비밀값·발송 차단·남용 방지)은 여기서 바꿀 수 없다.
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db } from '../../../lib/db';
import { SETTINGS, settingsFromRows } from '../../../lib/site-settings.js';
import { readSettingRows, writeSiteSetting } from '../../../lib/site-settings-db';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function view(d: NonNullable<Awaited<ReturnType<typeof db>>>) {
  const rows = await readSettingRows(d);
  const values = settingsFromRows(rows);
  return SETTINGS.map((s) => ({
    key: s.key, group: s.group, label: s.label, help: s.help, unit: s.unit, kind: s.kind ?? 'number',
    value: values[s.key], def: s.def, min: s.min, max: s.max,
    updated_at: rows.find((r) => r.key === s.key)?.updated_at ?? null,
  }));
}

export const GET: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);
  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);
  try {
    return json({ ok: true, settings: await view(d) });
  } catch (e) {
    console.error('[admin/site-settings] 읽기 실패:', (e as Error)?.name ?? 'Error');
    return json({ ok: false, error: 'db_error' }, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);
  try {
    const r = await writeSiteSetting(d, body?.key, body?.value);
    if (!r.ok) return json(r, 400);
    console.log(`[admin/site-settings] ${r.key} 저장`);
    return json({ ok: true, settings: await view(d) });
  } catch (e) {
    console.error('[admin/site-settings] 저장 실패:', (e as Error)?.name ?? 'Error');
    return json({ ok: false, error: 'db_error' }, 500);
  }
};
