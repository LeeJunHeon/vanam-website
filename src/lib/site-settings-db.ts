// 운영 설정 읽기·쓰기 — D1 settings 표(src/lib/site-settings.js 의 규칙을 쓴다).
//
// 읽기 실패는 기본값으로 — 설정 장애가 접수·견적을 막으면 안 된다.
// 쓰기는 관리자 API(/api/admin/site-settings) 한 곳뿐이다. 범위 검사를 여기서 다시 한다.
import type { D1 } from './db';
import { SETTING_KEYS, checkSetting, settingDefaults, settingsFromRows } from './site-settings.js';

const READ_SQL = `SELECT key, value, updated_at FROM settings WHERE key IN (${SETTING_KEYS.map(() => '?').join(', ')})`;

export type SettingRow = { key: string; value: number; updated_at: string | null };

/** 운영 설정 전체(없거나 이상한 값은 기본값). 오류면 기본값. */
export async function readSiteSettings(d: D1 | null): Promise<Record<string, number>> {
  if (!d) return settingDefaults();
  try {
    const { results } = await d.prepare(READ_SQL).bind(...SETTING_KEYS).all<SettingRow>();
    return settingsFromRows(results ?? []);
  } catch (e) {
    console.warn('[site-settings] 읽기 실패 — 기본값 사용:', (e as Error)?.name ?? 'Error');
    return settingDefaults();
  }
}

/** 관리자 화면용 — 저장된 행(수정 시각 포함). 오류는 던진다. */
export async function readSettingRows(d: D1): Promise<SettingRow[]> {
  const { results } = await d.prepare(READ_SQL).bind(...SETTING_KEYS).all<SettingRow>();
  return results ?? [];
}

/** 저장 — 범위를 다시 검사하고 UPSERT(fx_mode·quote_auto 와 같은 방식). */
export async function writeSiteSetting(d: D1, key: unknown, value: unknown): Promise<ReturnType<typeof checkSetting>> {
  const c = checkSetting(key, value);
  if (!c.ok) return c;
  await d
    .prepare(
      `INSERT INTO settings (key, value, updated_at, source) VALUES (?, ?, ?, 'admin')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, source = excluded.source`,
    )
    .bind(c.key, c.value, new Date().toISOString())
    .run();
  return c;
}
