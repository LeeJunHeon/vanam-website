// 레이트리밋 (D1 기반).
//
// 목적: 무차별 대입·스팸을 IP 단위로 차단한다.
//   /api/admin/login 의 700ms 지연은 병렬 요청에 무력하다.
//   워커는 요청을 동시 처리하므로, 100개를 동시에 쏘면 700ms 만에 100회가 끝난다.
//   → "동시 요청 수"가 아니라 "일정 시간 안의 시도 횟수"를 세어 막아야 한다.
//
// ⚠️ 원자성이 핵심이다.
//   "읽고 → +1 하고 → 쓰기"를 세 문장으로 나누면, 병렬 요청 사이에 경쟁 조건이 생겨
//   여러 요청이 같은 값을 읽고 각자 +1 해서 카운트가 실제보다 적게 잡힌다(= 우회 가능).
//   그래서 INSERT ... ON CONFLICT DO UPDATE 한 문장으로 원자적으로 처리한다.
//   (SQLite/D1은 이 UPSERT를 단일 원자 연산으로 실행한다)
//
// ⚠️ 가용성 우선.
//   DB가 없거나(dev) 오류가 나면 "통과"시킨다. 레이트리밋 인프라 장애가
//   서비스 전체를 멈추게 해서는 안 된다. (보안 < 가용성인 지점)
//
// ⚠️ 신뢰 가능한 IP만 쓴다.
//   CF-Connecting-IP 는 Cloudflare 엣지가 직접 세팅하므로 클라이언트가 위조할 수 없다.
//   X-Forwarded-For 는 클라이언트가 임의로 넣을 수 있어 신뢰하지 않는다.
import type { D1 } from './db';

/** 레이트리밋 규칙. limit = 허용 횟수, windowSec = 창 길이(초). */
export type RateRule = { limit: number; windowSec: number };

/** 엔드포인트별 버킷 규칙. key 접두사로도 쓰인다. */
export const RATE_RULES = {
  // 관리자 로그인: 무차별 대입 차단이 가장 급하다. 사람이 15분에 5번 이상 틀릴 일은 드물다.
  login: { limit: 5, windowSec: 15 * 60 },
  // 주문 조회: 주문번호 대입 차단. 정상 사용자는 몇 번이면 끝난다.
  lookup: { limit: 10, windowSec: 60 },
  // 문의·견적: 스팸 반복 제출 차단.
  inquiry: { limit: 5, windowSec: 10 * 60 },
  // 주문 생성: 정상적으로 시간당 10건을 넘기기 어렵다.
  order: { limit: 10, windowSec: 60 * 60 },
  // PayPal 결제: 주문 생성·캡처 남용 차단. 정상 결제는 각 1~2회면 끝난다.
  paypalCreate: { limit: 10, windowSec: 10 * 60 },
  paypalCapture: { limit: 10, windowSec: 10 * 60 },
} satisfies Record<string, RateRule>;

// 청소 기준: 가장 긴 창(현재 order = 1시간)의 2배를 지난 행은 어떤 규칙 판정에도 관여할 수 없다.
const MAX_WINDOW_MS = Math.max(...Object.values(RATE_RULES).map((r) => r.windowSec)) * 1000;

export type RateBucket = keyof typeof RATE_RULES;

export type RateResult = {
  ok: boolean; // true = 허용, false = 차단
  remaining: number; // 남은 허용 횟수 (차단 시 0)
  retryAfterSec: number; // 차단 해제까지 남은 초 (허용 시 0)
};

/**
 * 요청자의 실제 IP. Cloudflare 엣지가 세팅하는 CF-Connecting-IP 만 신뢰한다.
 * (X-Forwarded-For 는 클라이언트가 위조 가능하므로 쓰지 않는다)
 * 헤더가 없으면(로컬 등) 'unknown' 으로 묶는다.
 */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
}

/**
 * IP 단위 레이트리밋. 한 문장 UPSERT 로 원자적으로 카운트한다.
 *
 * 동작:
 *  - 같은 (bucket, ip) 의 창이 아직 살아있으면 hits + 1
 *  - 창이 만료됐으면 hits = 1 로 리셋하고 window_start 를 now 로 갱신
 *  - 갱신된 hits 가 limit 를 넘으면 차단
 *
 * DB 가 없거나 오류면 통과(ok=true). 가용성 우선.
 */
export async function rateLimit(
  db: D1 | null,
  bucket: RateBucket,
  request: Request,
): Promise<RateResult> {
  const _rule = RATE_RULES[bucket as RateBucket];
  if (!_rule) {
    console.warn(`[rate-limit] 정의되지 않은 버킷: ${String(bucket)} — 통과 처리(규칙을 RATE_RULES에 추가하세요)`);
    return { ok: true } as RateResult;
  }
  const rule = RATE_RULES[bucket];
  // DB 없음 → 통과 (레이트리밋 없이도 서비스는 동작해야 함)
  if (!db) return { ok: true, remaining: rule.limit, retryAfterSec: 0 };

  const ip = clientIp(request);
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const windowMs = rule.windowSec * 1000;

  // 오래된 버킷 청소 (0251): rate_limits 는 지금까지 삭제 로직이 없어 배포 이래 계속 쌓였다.
  // 요청 1% 확률로만 수행해 비용을 상수화하고, 실패해도 본 판정에는 영향을 주지 않는다(가용성 우선).
  if (Math.random() < 0.01) {
    try {
      await db.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(now - MAX_WINDOW_MS * 2).run();
    } catch { /* 청소 실패는 무시 — 다음 1% 요청이 다시 시도한다 */ }
  }

  try {
    // 한 문장 원자 UPSERT.
    //  - 새 키: hits=1, window_start=now
    //  - 기존 키, 창 살아있음(now - window_start < windowMs): hits = hits + 1  (window_start 유지)
    //  - 기존 키, 창 만료: hits = 1, window_start = now  (리셋)
    // RETURNING 으로 갱신 결과를 즉시 돌려받아 추가 SELECT 없이 판정한다.
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (key, hits, window_start)
           VALUES (?1, 1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           hits = CASE
                    WHEN ?2 - rate_limits.window_start >= ?3 THEN 1
                    ELSE rate_limits.hits + 1
                  END,
           window_start = CASE
                    WHEN ?2 - rate_limits.window_start >= ?3 THEN ?2
                    ELSE rate_limits.window_start
                  END
         RETURNING hits, window_start`,
      )
      .bind(key, now, windowMs)
      .first<{ hits: number; window_start: number }>();

    if (!row) {
      // RETURNING 이 비는 건 정상 경로에선 없다. 안전하게 통과.
      return { ok: true, remaining: rule.limit, retryAfterSec: 0 };
    }

    const hits = Number(row.hits);
    const windowStart = Number(row.window_start);
    const resetInSec = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));

    if (hits > rule.limit) {
      return { ok: false, remaining: 0, retryAfterSec: resetInSec };
    }
    return { ok: true, remaining: Math.max(0, rule.limit - hits), retryAfterSec: 0 };
  } catch (e) {
    // 오류 시 통과(가용성 우선). 단, 로그에는 남긴다.
    console.error('[rate-limit] 카운트 실패 (통과 처리):', e);
    return { ok: true, remaining: rule.limit, retryAfterSec: 0 };
  }
}

/** 429 Too Many Requests 응답. Retry-After 헤더 포함. */
export function tooMany(retryAfterSec: number): Response {
  return new Response(JSON.stringify({ ok: false, error: 'rate_limited', retryAfterSec }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.max(1, retryAfterSec)),
    },
  });
}
