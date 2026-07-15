// Cloudflare Turnstile 서버 검증.
//
// 흐름:
//   ① 브라우저에서 Turnstile 위젯이 "사람인지" 판단 → 토큰 발급 (cf-turnstile-response)
//   ② 폼 제출 시 그 토큰을 함께 전송
//   ③ 서버가 이 토큰을 Cloudflare siteverify 에 보내 진짜인지 확인
//
// ⚠️ 시크릿 키는 워커 Secret(TURNSTILE_SECRET)에만 둔다. 클라이언트에 절대 노출 금지.
//   (사이트 키는 공개해도 되지만, 시크릿 키가 있어야 siteverify 가 통과한다)
//
// ⚠️ 가용성 우선 (fail-open 정책):
//   TURNSTILE_SECRET 이 설정되지 않았으면 검증을 건너뛴다(통과).
//   → 키 미설정 상태에서도 폼이 죽지 않는다(허니팟·레이트리밋은 여전히 동작).
//   siteverify 호출 자체가 네트워크 오류로 실패해도 통과시킨다.
//   (캡챠 인프라 장애가 정상 고객의 문의·주문을 막으면 안 된다 — 봇 차단 < 매출)
//   단, 토큰이 왔는데 "명시적으로 무효"인 경우는 차단한다(봇으로 판정).
import { env as cfEnv } from 'cloudflare:workers';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function readSecret(): string {
  const raw =
    (cfEnv as Record<string, unknown> | undefined)?.TURNSTILE_SECRET ??
    import.meta.env.TURNSTILE_SECRET ??
    '';
  return typeof raw === 'string' ? raw.trim().replace(/^["']|["']$/g, '') : '';
}

/** Turnstile 이 활성화돼 있는지 (시크릿 키가 등록됐는지) */
export const turnstileConfigured = (): boolean => readSecret().length > 0;

export type TurnstileResult =
  | { ok: true; skipped?: boolean }
  | { ok: false; reason: 'missing_token' | 'failed' | 'error' };

/**
 * Turnstile 토큰을 검증한다.
 *
 * @param token   폼이 보낸 cf-turnstile-response 값
 * @param request 원 요청 (사용자 IP 를 remoteip 로 함께 보내 검증 정확도를 높인다)
 *
 * 반환:
 *   { ok: true }            — 사람으로 확인됨 (또는 키 미설정으로 스킵)
 *   { ok: false, reason }   — 봇으로 판정되거나 토큰 없음
 */
export async function verifyTurnstile(
  token: string | undefined | null,
  request: Request,
): Promise<TurnstileResult> {
  const secret = readSecret();

  // 키 미설정 → 검증 스킵(통과). 폼이 죽지 않게. (허니팟·레이트리밋은 계속 동작)
  if (!secret) return { ok: true, skipped: true };

  // 키는 설정됐는데 토큰이 없다 → 위젯을 우회한 것 → 차단
  const t = typeof token === 'string' ? token.trim() : '';
  if (!t) return { ok: false, reason: 'missing_token' };

  try {
    const body = new FormData();
    body.append('secret', secret);
    body.append('response', t);
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) body.append('remoteip', ip);

    const res = await fetch(SITEVERIFY, { method: 'POST', body });
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };

    if (data.success === true) return { ok: true };

    // 명시적으로 무효 → 봇으로 판정, 차단
    console.warn('[turnstile] 검증 실패:', data['error-codes'] ?? '(no codes)');
    return { ok: false, reason: 'failed' };
  } catch (e) {
    // siteverify 호출 자체가 실패(네트워크 등) → 가용성 우선으로 통과
    console.error('[turnstile] siteverify 호출 오류 (통과 처리):', e);
    return { ok: true, skipped: true };
  }
}
