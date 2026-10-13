// 운영 설정(관리자 설정 탭 '운영 설정' 카드) — 순수 모듈(브라우저·워커·node 공용, SQL 없음).
//
// 왜 있는가(10-12 사용자 결정): 개발자 없이 관리자 페이지에서 바꿀 수 있어야 하는 '동적인 값'.
//   겉에 보이는 문구·그림은 Keystatic, 그보다 동적인 운영 값은 관리자 페이지(D1 settings 표)에서 고친다.
//   저장 즉시 반영된다(재배포 없음).
//
// ⚠️ 예민한 값은 여기 넣지 않는다 — 비밀값·발송 차단·남용 방지(접수 횟수·입력 길이)·환율 허용 범위·저장 코드값·계산 수식.
// ⚠️ 모든 값은 정수이고 [min, max] 안에서만 저장된다(서버가 다시 검사한다).
//    확인 메일 상한은 '낮추기만' — 최댓값이 지금 코드 기본값이다(관리자 계정이 털려도 회사 메일이 스팸 통로가 되지 않게).
// ⚠️ DB 값이 없거나 범위를 벗어났으면(손으로 고친 값 등) 기본값을 쓴다 — 이상한 값으로 동작하지 않게.
// settings.value 는 REAL 이라 숫자만 담는다(텍스트 설정은 여기 넣지 않는다).
// ⚠️ 이 모듈은 서버·관리자 화면 전용 — 공개 화면 스크립트에서 import 하지 않는다(상한 값이 번들에 실린다). 화면은 reply-days.js.
import { REPLY_DAYS } from './reply-days.js';

/**
 * @typedef {{ key: string, group: string, label: string, help: string, unit: string,
 *   def: number, min: number, max: number }} SettingSpec
 */

/** @type {SettingSpec[]} */
export const SETTINGS = [
  {
    key: 'reply_business_days', group: '안내 문구',
    label: '회신 기한 (영업일)', unit: '일',
    help: '견적 요청 완료 화면·접수 확인 메일·주문 요청 안내의 "영업일 기준 N일 이내 회신"',
    def: REPLY_DAYS.def, min: REPLY_DAYS.min, max: REPLY_DAYS.max,
  },
  {
    key: 'quote_sample_manual_min', group: '자동 견적',
    label: '담당자 확인 샘플 수량 (이상)', unit: '개',
    help: '샘플 수량이 이 값 이상이면 자동 금액을 내지 않고 "담당자 확인"으로 둡니다',
    def: 10, min: 1, max: 1000,
  },
  {
    key: 'quote_auto_max_nm', group: '자동 견적',
    label: '자동 계산 최대 두께', unit: 'nm',
    help: '이보다 두꺼운 단계는 자동 금액을 내지 않고 "담당자 확인"으로 둡니다(오타·장난 입력 방어)',
    def: 10000, min: 1, max: 100000,
  },
  {
    key: 'quote_auto_max_min', group: '자동 견적',
    label: '자동 계산 최대 시간', unit: '분',
    help: '플라즈마·열처리 단계가 이보다 길면 자동 금액을 내지 않고 "담당자 확인"으로 둡니다',
    def: 1440, min: 1, max: 10080,
  },
  {
    key: 'ack_recipient_daily_max', group: '접수 확인 메일',
    label: '같은 주소 하루 상한', unit: '통',
    help: '같은 받는 주소로 하루(24시간)에 자동으로 보내는 최대 수 — 낮추기만 가능, 0 이면 자동 발송 안 함',
    def: 3, min: 0, max: 3,
  },
  {
    key: 'ack_global_daily_max', group: '접수 확인 메일',
    label: '하루 전체 상한', unit: '통',
    help: '하루(24시간)에 자동으로 보내는 전체 최대 수 — 낮추기만 가능, 0 이면 자동 발송 안 함',
    def: 50, min: 0, max: 50,
  },
];

/** 키 목록(고정 순서) */
export const SETTING_KEYS = SETTINGS.map((s) => s.key);
const SPEC = Object.fromEntries(SETTINGS.map((s) => [s.key, s]));

/** @param {string} key */
export const settingSpec = (key) => SPEC[key] ?? null;

/** 기본값 모음 @returns {Record<string, number>} */
export function settingDefaults() {
  return Object.fromEntries(SETTINGS.map((s) => [s.key, s.def]));
}

/**
 * 저장하려는 값 검사 — 정수 · [min, max].
 * @param {unknown} key @param {unknown} value
 * @returns {{ ok: true, key: string, value: number } | { ok: false, error: 'unknown_key' | 'not_integer' | 'out_of_range', min?: number, max?: number }}
 */
export function checkSetting(key, value) {
  const spec = typeof key === 'string' ? SPEC[key] : null;
  if (!spec) return { ok: false, error: 'unknown_key' };
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) return { ok: false, error: 'not_integer', min: spec.min, max: spec.max };
  if (n < spec.min || n > spec.max) return { ok: false, error: 'out_of_range', min: spec.min, max: spec.max };
  return { ok: true, key: spec.key, value: n };
}

/**
 * DB 행 → 설정값(없거나 이상하면 기본값).
 * @param {{ key?: unknown, value?: unknown }[] | null | undefined} rows settings 표에서 읽은 행
 * @returns {Record<string, number>}
 */
export function settingsFromRows(rows) {
  const out = settingDefaults();
  for (const r of Array.isArray(rows) ? rows : []) {
    const c = checkSetting(r?.key, typeof r?.value === 'string' ? Number(r.value) : r?.value);
    if (c.ok) out[c.key] = c.value;
  }
  return out;
}

/**
 * 자동 견적 판정 한도(quote-customer.js estimateForCustomer 의 limits).
 * @param {Record<string, number>} s settingsFromRows 결과
 */
export function quoteLimitsOf(s) {
  const d = settingDefaults();
  return {
    sampleManualMin: s?.quote_sample_manual_min ?? d.quote_sample_manual_min,
    maxNm: s?.quote_auto_max_nm ?? d.quote_auto_max_nm,
    maxMin: s?.quote_auto_max_min ?? d.quote_auto_max_min,
  };
}

// 화면은 reply-days.js 를 직접 쓴다(이 모듈의 운영 값·상한이 공개 번들에 들어가지 않게). 서버 쪽 편의로 다시 내보낸다.
export { fillDays } from './reply-days.js';
