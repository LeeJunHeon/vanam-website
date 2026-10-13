// 공개: 화면 안내에 쓰는 운영 설정 — 회신 기한(영업일)만.
//   GET → { ok, replyDays }
// 견적 완료 화면·주문 요청 안내가 "영업일 기준 N일" 의 N 을 여기서 받는다(페이지는 기본값으로 먼저 그린다).
// ⚠️ 공개 응답에는 화면 안내용 값만 넣는다 — 자동 견적 한도·메일 상한 같은 운영 값은 넣지 않는다.
import type { APIRoute } from 'astro';
import { db } from '../../lib/db';
import { readSiteSettings } from '../../lib/site-settings-db';

export const prerender = false;

export const GET: APIRoute = async () => {
  const s = await readSiteSettings(await db());
  return new Response(JSON.stringify({ ok: true, replyDays: s.reply_business_days }), {
    status: 200,
    // 짧게 캐시 — 관리자가 바꾸면 1분 안에 화면에 반영된다
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  });
};
