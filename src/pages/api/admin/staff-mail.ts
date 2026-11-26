// 관리자: 담당자 알림 메일 (다시) 보내기 — 접수 순간의 자동 발송이 실패했거나, 기록이 없는 옛 접수 건을 담당자 주소로 보낼 때
//
// 고객에게 가는 메일이 아니다 — 받는 주소는 담당자 주소(비밀값)이고 읽기·검사·발송은 접수 때와 같은 통로다(src/lib/staff-notify-run.ts).
// 내용은 저장된 접수 행으로 다시 만든다(src/lib/staff-notify-record.js 의 staffInputFromRow) — 견적 요청·일반 문의·웨이퍼 문의 모두.
//   웨이퍼 문의의 달러 환산은 빠진다(접수 당시 환율이 저장돼 있지 않다). 자동 견적 줄은 접수 시 자동 개정이 있을 때만.
// 테스트 빌드에서는 보내지 않는다(결과 '안 보냄'으로 기록). 실패해도 구글챗 알림은 보내지 않는다 — 화면에 결과가 나온다.
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db } from '../../../lib/db';
import { runStaffNotify } from '../../../lib/staff-notify-run';
import { staffInputFromRow, isStaffPending } from '../../../lib/staff-notify-record.js';

export const prerender = false;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request }) => {
  if (!(await isAdmin(request))) return json({ ok: false, error: 'unauthorized' }, 401);

  const d = await db();
  if (!d) return json({ ok: false, error: 'no_db' }, 503);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!/^INQ-\d{8}-[A-Z0-9]{4}$/.test(id)) return json({ ok: false, error: 'bad_id' }, 400);

  let row: Record<string, unknown> | null;
  try {
    row = await d.prepare(`SELECT * FROM inquiries WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  } catch (e) {
    console.error('[staff-mail] 접수 행 읽기 실패:', id, (e as Error)?.name ?? 'Error');
    return json({ ok: false, error: 'db_error' }, 500);
  }
  if (!row) return json({ ok: false, error: 'not_found' }, 404);
  // 접수 직후 자동 발송(또는 방금 누른 발송)이 아직 도는 중 — 두 번 보내지 않는다(2분 뒤에도 그대로면 '중단됨'으로 보이고 다시 보낼 수 있다)
  if (isStaffPending(row.staff_mail)) return json({ ok: false, error: 'in_progress' }, 409);

  // 접수 시 자동 견적 줄 — 개정을 못 읽으면 그 줄만 빠진다
  let revisions: unknown[] = [];
  if (row.type === 'quote') {
    try {
      const { results } = await d
        .prepare(`SELECT rev, source, kind, total, seen_total, manual_json, created_at
          FROM quote_revisions WHERE inquiry_id = ? ORDER BY rev ASC`)
        .bind(id)
        .all<Record<string, unknown>>();
      revisions = results ?? [];
    } catch (e) {
      console.warn('[staff-mail] 개정 읽기 실패(자동 견적 줄 없이 보냄):', id, (e as Error)?.name ?? 'Error');
    }
  }

  const input = staffInputFromRow(row, { origin: new URL(request.url).origin, revisions });
  const r = await runStaffNotify(input, { d, by: 'admin', prev: row.staff_mail ?? null });
  return json({ ok: r.sent, result: { status: r.status, reason: r.sent ? null : r.reason } });
};
