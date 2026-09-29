// 운영 스위치 '자동 견적' — settings 키 'quote_auto' (value 1 = 켜짐, 0·없음 = 꺼짐).
//
// 기본은 꺼짐이다. 켜고 끄는 곳은 관리자 API(/api/admin/quote-auto) 하나뿐이다.
// 켜져 있어도 가격 DB 가 비어 있으면 자동 견적은 동작하지 않는다(quoteAutoEnabled).
// 조회 오류는 꺼짐으로 본다 — 스위치 장애가 고객에게 잘못된 금액을 보여주는 쪽으로 가면 안 된다.
import type { D1 } from './db';
import { priceDbReady } from './price-db';

/** 스위치 값만 읽는다(가격 DB 준비 여부는 보지 않는다). */
export async function readQuoteAuto(d: D1 | null): Promise<boolean> {
  if (!d) return false;
  try {
    const row = await d
      .prepare(`SELECT value FROM settings WHERE key = 'quote_auto'`)
      .first<{ value: number | string }>();
    return String(row?.value ?? '') === '1';
  } catch {
    return false;
  }
}

/** 스위치 저장 — fx.ts 의 fx_mode 와 같은 UPSERT. */
export async function writeQuoteAuto(d: D1, on: boolean): Promise<void> {
  await d
    .prepare(
      `INSERT INTO settings (key, value, updated_at, source) VALUES ('quote_auto', ?, ?, 'admin')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, source = excluded.source`,
    )
    .bind(on ? 1 : 0, new Date().toISOString())
    .run();
}

/** 자동 견적을 실제로 쓸 수 있는가 = 스위치 켜짐 && 가격 DB 있음. 오류면 false. */
export async function quoteAutoEnabled(d: D1 | null): Promise<boolean> {
  if (!d) return false;
  try {
    return (await readQuoteAuto(d)) && (await priceDbReady(d));
  } catch {
    return false;
  }
}
