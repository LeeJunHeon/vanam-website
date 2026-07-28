// USD/KRW 환율 관리.
//
// 왜 이런 구조인가:
//  - Astro 어댑터가 Worker 를 자동 생성하므로 scheduled() 핸들러(cron)를 끼워 넣을 자리가 없다.
//    → 요청 처리 중 "오래됐으면 뒤에서 갱신"하는 지연 갱신 방식을 쓴다. 응답은 기다리지 않는다.
//  - 환율은 금액에 직결되므로 실패해도 절대 0/NaN 으로 덮어쓰지 않는다. 항상 마지막 정상값을 지킨다.
//  - 마진은 붙이지 않는다(중간환율 그대로). 정책 변경 시 이 파일 한 곳만 고치면 된다.
import type { D1 } from './db';
import company from '../data/company.json';
import { notifyChat } from './paypal';

/** 최종 폴백. D1·설정 모두 실패했을 때만 쓰인다. */
const HARD_FALLBACK = 1500;
/** 이 시간이 지나면 갱신을 시도한다(ECB 는 하루 1회 발행이므로 20시간이면 충분). */
const STALE_MS = 20 * 60 * 60 * 1000;
/** 직전 값 대비 이 비율을 넘게 변하면 적용하지 않는다(API 오류·소수점 실수 방어). */
const MAX_JUMP = 0.10;
/** 상식 범위를 벗어난 값은 어떤 경우에도 받지 않는다. */
const MIN_RATE = 500;
const MAX_RATE = 5000;

export type FxRate = { rate: number; updatedAt: string | null; source: string };

const cfgRate = () => {
  const n = Number((company as Record<string, unknown>).usdRate);
  return Number.isFinite(n) && n >= MIN_RATE && n <= MAX_RATE ? n : HARD_FALLBACK;
};

/** 값이 환율로 쓸 수 있는 수인지 확인한다. */
const sane = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= MIN_RATE && n <= MAX_RATE;

/** D1 에 저장된 환율을 읽는다. 없거나 이상하면 설정값으로 폴백. */
export async function readRate(d: D1 | null): Promise<FxRate> {
  const fallback: FxRate = { rate: cfgRate(), updatedAt: null, source: 'config' };
  if (!d) return fallback;
  try {
    const row = await d
      .prepare(`SELECT value, updated_at, source FROM settings WHERE key = 'usd_rate'`)
      .first<{ value: number | string; updated_at: string; source: string }>();
    if (!row) return fallback;
    const n = Number(row.value);
    if (!sane(n)) return fallback;
    return { rate: n, updatedAt: String(row.updated_at ?? ''), source: String(row.source ?? 'db') };
  } catch (e) {
    console.error('[fx] 환율 조회 실패:', e);
    return fallback;
  }
}

/** 외부 API 두 곳을 순서대로 시도한다. 둘 다 실패하면 null. */
async function fetchRate(): Promise<{ rate: number; source: string } | null> {
  // 1순위: KRW 를 확실히 제공하고 키가 필요 없다.
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', {
      headers: { Accept: 'application/json' },
    });
    if (r.ok) {
      const j = (await r.json()) as { result?: string; rates?: Record<string, number> };
      const n = Number(j?.rates?.KRW);
      if (j?.result === 'success' && sane(n)) return { rate: n, source: 'er-api' };
    }
  } catch (e) {
    console.warn('[fx] er-api 실패:', e);
  }
  // 2순위: ECB 기반. 한쪽이 죽어도 갱신이 멈추지 않도록 이중화한다.
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW', {
      headers: { Accept: 'application/json' },
    });
    if (r.ok) {
      const j = (await r.json()) as { rates?: Record<string, number> };
      const n = Number(j?.rates?.KRW);
      if (sane(n)) return { rate: n, source: 'frankfurter' };
    }
  } catch (e) {
    console.warn('[fx] frankfurter 실패:', e);
  }
  return null;
}

/**
 * 환율을 갱신한다. 실패하거나 값이 수상하면 **기존 값을 그대로 둔다.**
 * 반환값은 실제로 저장했는지 여부.
 */
export async function refreshRate(d: D1 | null): Promise<boolean> {
  if (!d) return false;
  const cur = await readRate(d);
  const got = await fetchRate();
  if (!got) {
    console.warn('[fx] 모든 환율 소스 실패 — 기존 값 유지:', cur.rate);
    return false;
  }
  // 이상치 차단: 직전 값이 있을 때만 비교한다(최초 저장은 통과시킨다).
  if (cur.updatedAt) {
    const jump = Math.abs(got.rate - cur.rate) / cur.rate;
    if (jump > MAX_JUMP) {
      console.error('[fx] 이상 변동 감지 — 적용 보류:', cur.rate, '→', got.rate);
      await notifyChat(
        `⚠️ [환율 이상] ${cur.rate} → ${got.rate.toFixed(2)} (${(jump * 100).toFixed(1)}% 변동, ${got.source}) · ` +
          `적용하지 않았습니다. 관리자 화면에서 확인해 주세요.`,
      );
      return false;
    }
  }
  const now = new Date().toISOString();
  try {
    await d
      .prepare(
        `INSERT INTO settings (key, value, updated_at, source) VALUES ('usd_rate', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, source = excluded.source`,
      )
      .bind(got.rate, now, got.source)
      .run();
    return true;
  } catch (e) {
    console.error('[fx] 환율 저장 실패:', e);
    return false;
  }
}

/**
 * 현재 환율을 돌려주고, 오래됐으면 **뒤에서** 갱신을 건다.
 * waitUntil 이 있으면 응답을 막지 않는다(없으면 갱신을 건너뛴다 — 절대 응답을 지연시키지 않는다).
 */
export async function getRate(d: D1 | null, waitUntil?: (p: Promise<unknown>) => void): Promise<FxRate> {
  const cur = await readRate(d);
  if (!d || !waitUntil) return cur;
  const age = cur.updatedAt ? Date.now() - Date.parse(cur.updatedAt) : Infinity;
  if (!Number.isFinite(age) || age > STALE_MS) {
    try {
      waitUntil(refreshRate(d).catch((e) => console.error('[fx] 백그라운드 갱신 실패:', e)));
    } catch (e) {
      /* waitUntil 사용 불가 환경 — 다음 요청에서 다시 시도된다 */
    }
  }
  return cur;
}

/** locals 에서 waitUntil 을 안전하게 꺼낸다(어댑터/환경마다 위치가 다를 수 있다). */
export function pickWaitUntil(locals: unknown): ((p: Promise<unknown>) => void) | undefined {
  const ctx = (locals as { runtime?: { ctx?: { waitUntil?: (p: Promise<unknown>) => void } } })?.runtime?.ctx;
  const fn = ctx?.waitUntil;
  return typeof fn === 'function' ? fn.bind(ctx) : undefined;
}
