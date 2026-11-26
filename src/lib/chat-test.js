// 오류 알림 테스트 — 관리자 화면 [테스트 보내기]의 본문 · 결과 구분 · 화면 문구(순수 함수).
//
// 무엇: 메일 오류 알림(alert 채널)이 운영에서 실제로 어느 채팅방으로 가는지 관리자가 버튼으로 확인한다
//   (메일 오류는 일부러 낼 수 없어 다른 확인 방법이 없다). 발송은 api/admin/chat-test.ts 가 chat-send.ts 의 sendChat 으로만 한다.
// 결과 구분(code):
//   alert          별도 채팅방으로 보냄
//   main_unset     별도 설정이 없어 기존 채팅방으로 보냄
//   main_fallback  별도 채팅방 전송이 실패해 기존 채팅방으로 보냄
//   failed         실패(사유)
//   blocked_build  테스트 빌드라 보내지 않음
//
// ⚠️ .js 이고 다른 모듈을 import 하지 않는다 — 서버(API)·화면(관리자 스크립트)·node 테스트(scripts/test-chat-guard.mjs)가 같이 쓴다.
// ⚠️ 웹훅 값·비밀값 이름을 다루지 않는다(결과와 사유만) — 본문에 고객 정보를 넣지 않는다.

/** 로그 태그 — 접수번호가 없는 알림이라 태그만 남는다 */
export const CHAT_TEST_TAG = 'chat-test';

/**
 * 시험 메시지 본문. @param {unknown} kst 보낸 시각(한국 시간 'YYYY-MM-DD HH:mm')
 * @returns {string}
 */
export function chatTestMessage(kst) {
  const at = String(kst ?? '').trim();
  return `🔔 오류 알림 테스트 — 관리자 화면에서 보낸 시험 메시지입니다.${at ? ` (${at} · 한국 시간)` : ''}`;
}

/**
 * sendChat 결과(alert 채널로 한 번 보낸 것) → 결과 구분. 웹훅 값은 들어오지도 나가지도 않는다.
 * @param {{ sent?: boolean, reason?: string, status?: number, channel?: string, fallback?: boolean } | null | undefined} r
 * @returns {{ ok: boolean, code: 'alert' | 'main_unset' | 'main_fallback' | 'failed' | 'blocked_build', reason: string | null, status: number | null }}
 */
export function chatTestOutcome(r) {
  const status = Number.isInteger(r?.status) ? Number(r.status) : null;
  if (r?.reason === 'blocked_build') return { ok: false, code: 'blocked_build', reason: null, status: null };
  if (r?.sent === true) {
    if (r.channel === 'alert') return { ok: true, code: 'alert', reason: null, status };
    return { ok: true, code: r.fallback === true ? 'main_fallback' : 'main_unset', reason: null, status };
  }
  return { ok: false, code: 'failed', reason: String(r?.reason || 'error'), status };
}

/** 실패 사유 → 한글 */
export const CHAT_TEST_REASON_KO = Object.freeze({
  no_webhook: '구글챗 웹훅이 설정돼 있지 않습니다',
  http_error: '구글챗이 요청을 거절했습니다',
  fetch_error: '구글챗 연결 오류',
  error: '처리 중 오류',
});

/**
 * 결과 구분 → 화면 한 줄.
 * @param {{ code?: string, reason?: string | null, status?: number | null } | null | undefined} o chatTestOutcome 의 결과(API 응답의 result)
 * @returns {{ tone: 'ok' | 'warn' | 'bad', text: string }}
 */
export function chatTestLabel(o) {
  switch (o?.code) {
    case 'alert': return { tone: 'ok', text: '별도 채팅방으로 보냈습니다.' };
    case 'main_unset': return { tone: 'warn', text: '별도 설정이 없어 기존 채팅방으로 보냈습니다.' };
    case 'main_fallback': return { tone: 'warn', text: '별도 채팅방 전송이 실패해 기존 채팅방으로 보냈습니다.' };
    case 'blocked_build': return { tone: 'warn', text: '테스트 빌드라 보내지 않았습니다.' };
    default: {
      const reason = String(o?.reason || 'error');
      const why = CHAT_TEST_REASON_KO[reason] ?? reason;
      return { tone: 'bad', text: `실패 — ${why}${Number.isInteger(o?.status) ? ` (HTTP ${o.status})` : ''}` };
    }
  }
}

/**
 * API 응답(HTTP 상태 + 본문) → 화면 한 줄. 결과(result)가 없으면 상태 코드로 안내한다.
 * @param {number} httpStatus @param {any} body
 * @returns {{ tone: 'ok' | 'warn' | 'bad', text: string }}
 */
export function chatTestResponseLabel(httpStatus, body) {
  if (httpStatus === 401) return { tone: 'bad', text: '로그인이 만료되었습니다. 새로고침한 뒤 다시 로그인하세요.' };
  if (httpStatus === 429) {
    const sec = Number(body?.retryAfterSec);
    return { tone: 'bad', text: `너무 자주 눌렀습니다 — ${Number.isFinite(sec) && sec > 0 ? `${Math.ceil(sec)}초 뒤` : '잠시 뒤'} 다시 시도하세요.` };
  }
  if (body && typeof body === 'object' && body.result && typeof body.result === 'object') return chatTestLabel(body.result);
  return { tone: 'bad', text: `실패 — ${String(body?.error ?? httpStatus)}` };
}
