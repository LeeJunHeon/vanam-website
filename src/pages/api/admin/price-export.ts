// 관리자 전용: 지금 가격 DB 를 엑셀(.xlsx)로 내려받기 — 관리자 [가격 DB 올리기]가 읽는 모양 그대로(시트·헤더 이름 같음).
//   GET → 파일(VanaM_price_db_YYYYMMDD-HHMM.xlsx, 한국 시간)
// 쓰임: 백업 · 구글 시트와 맞추기 · 크게 정리한 뒤 다시 올리기.
// ⚠️ 원가가 들어 있다 — 관리자 인증 뒤에만. 캐시하지 않는다. 로그에는 행 수도 남기지 않는다.
import type { APIRoute } from 'astro';
import { isAdmin } from '../../../lib/admin-auth';
import { db } from '../../../lib/db';
import { readPriceTables } from '../../../lib/price-db';
import { sheetsForExport } from '../../../lib/price-edit.js';
import { buildXlsx } from '../../../lib/xlsx-write.js';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const fail = (s: number, error: string) =>
    new Response(JSON.stringify({ ok: false, error }), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (!(await isAdmin(request))) return fail(401, 'unauthorized');
  const d = await db();
  if (!d) return fail(503, 'no_db');
  try {
    const bytes = buildXlsx(sheetsForExport(await readPriceTables(d)));
    const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="VanaM_price_db_${stamp}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    console.error('[admin/price-export] 실패:', (e as Error)?.name ?? 'Error');
    return fail(500, 'db_error');
  }
};
