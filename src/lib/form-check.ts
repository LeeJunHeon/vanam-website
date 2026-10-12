// 폼 검사 공통 규칙 — 견적·주문(Checkout)·문의 폼이 함께 쓴다 (2026-10-12).
// (브라우저 기본 말풍선 문구를 바꾸는 전역 스크립트 BaseLayout 은 같은 문구 표를 따로 든다 — 아래 MSG 주석)
//
// ── 왜 만들었나 (운영에서 고객이 막힌 사고) ─────────────────────────────────────
//   견적 폼에서 기판 전달 '택배'를 잠깐이라도 골랐다가 다른 방식으로 바꾸면 [견적 요청하기]가 영영
//   되지 않았다. 왼쪽 위 구석에 '입력값을 확인해 주세요.' 말풍선만 뜨고 그 칸으로 이동하지 않았다.
//   원인은 세 겹이었다.
//     ① 문구를 현지화하려고 setCustomValidity(문구)를 걸었는데, 이 표시는 그 칸에 입력이 와야만 지워진다.
//        칸이 숨겨지거나 필수가 풀려도 '틀린 칸'으로 남는다.
//     ② 버튼 게이트가 1초마다 checkValidity() 를 불러 그 표시를 계속 붙였다.
//     ③ 제출 검사는 숨은 칸도 검사했고, 숨은 칸은 위치가 0,0 이라 말풍선이 구석에 떴다.
//   같은 원인을 예전에 개인정보 동의 칸에서 한 번 겪고 그 자리만 고쳤다(QuoteForm 다운로드 주석).
//   그래서 이번에는 규칙을 한 곳에 모은다.
//
// ── 규칙 ───────────────────────────────────────────────────────────────────────
//   1. 판정할 때마다 남은 표시를 먼저 지우고(setCustomValidity('')) **지금의 규칙**으로만 본다.
//   2. checkValidity()/reportValidity() 를 부르지 않는다 — invalid 이벤트가 표시를 다시 붙인다.
//      대신 validity 값을 읽어 문구를 여기서 만든다(nativeMessage).
//   3. 화면에 보이지 않는 칸·비활성 칸은 판정하지 않는다(고객이 고칠 수 없는 칸으로 막지 않는다).
//   4. 말풍선은 화면에 보이는 요소만 가리킨다(anchorOf).
//   5. 사이트 공통 규칙(이메일 모양 · 공백만 입력)은 서버와 같은 규칙을 여기서 함께 본다.
//   ⚠️ 앱 규칙을 setCustomValidity 로 걸지 말 것 — 전역 핸들러가 '남은 표시'로 보고 지운다.
//      (scripts/check-form-guard.mjs 가 막는다)
import { isEmail } from './email-rule.js';

export type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

// ⚠️ src/layouts/BaseLayout.astro 의 V_KO·V_EN 과 글자 그대로 같아야 한다(그쪽은 모든 페이지 성능 때문에
//    import 하지 않고 같은 표를 든다). scripts/test-form-rules.mjs 가 대조한다.
const MSG = {
  ko: {
    required: '필수 항목입니다.',
    checkbox: '계속하려면 동의해 주세요.',
    radio: '항목을 선택해 주세요.',
    select: '항목을 선택해 주세요.',
    email: '올바른 이메일 주소를 입력해 주세요. (예: name@company.com)',
    tel: '올바른 전화번호를 입력해 주세요.',
    number: '올바른 숫자를 입력해 주세요.',
    length: '입력 길이를 확인해 주세요.',
    fallback: '입력값을 확인해 주세요.',
  },
  en: {
    required: 'This field is required.',
    checkbox: 'Please tick this box to continue.',
    radio: 'Please choose an option.',
    select: 'Please choose an option.',
    email: 'Please enter a valid email address (e.g. name@company.com).',
    tel: 'Please enter a valid phone number.',
    number: 'Please enter a valid number.',
    length: 'Please check the length of your entry.',
    fallback: 'Please check this value.',
  },
} as const;

/** 페이지 언어의 문구 묶음 — 브라우저 UI 언어가 아니라 페이지 언어를 따른다 */
export const msgs = () => ((document.documentElement.lang || 'en').startsWith('ko') ? MSG.ko : MSG.en);

export const isField = (el: unknown): el is Field =>
  el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;

/** 화면에 실제로 그려지는가 — hidden 속성·display:none·visibility:hidden(조상 포함)이면 false */
export function isShown(el: Element | null | undefined): boolean {
  if (!el || !el.isConnected) return false;
  const cv = (el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility;
  if (typeof cv === 'function') {
    return cv.call(el, { visibilityProperty: true, checkVisibilityCSS: true });
  }
  if (el.getClientRects().length === 0) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

/** 브라우저 기본 규칙 위반을 페이지 언어 문구로 (validity 를 읽기만 한다 — 이벤트 없음) */
export function nativeMessage(el: Field): string {
  const v = el.validity;
  const m = msgs();
  if (v.valueMissing) {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return m.checkbox;
    if (el instanceof HTMLInputElement && el.type === 'radio') return m.radio;
    if (el instanceof HTMLSelectElement) return m.select;
    return m.required;
  }
  if (v.typeMismatch) {
    if (el instanceof HTMLInputElement && el.type === 'email') return m.email;
    if (el instanceof HTMLInputElement && el.type === 'tel') return m.tel;
    return m.fallback;
  }
  if (v.badInput) return el instanceof HTMLInputElement && el.type === 'number' ? m.number : m.fallback;
  if (v.rangeUnderflow || v.rangeOverflow || v.stepMismatch) return m.number;
  if (v.tooLong || v.tooShort) return m.length;
  return m.fallback;
}

/** 브라우저 기본 규칙 중 실제 위반이 있는가 (남은 표시 customError 는 빼고 본다) */
export function hasNativeFailure(v: ValidityState): boolean {
  return v.valueMissing || v.typeMismatch || v.badInput || v.rangeUnderflow || v.rangeOverflow
    || v.stepMismatch || v.tooLong || v.tooShort || v.patternMismatch;
}

/** 판정 대상인가 — 사용 가능(willValidate)하고 화면에 보이는 입력칸만. 미끼칸은 뺀다 */
export function inScope(el: Element): el is Field {
  if (!isField(el)) return false;
  if (!el.willValidate) return false;           // disabled · type=hidden · readonly 등
  if (el.name === 'vanam_hp_note') return false;
  return isShown(el);
}

const TEXTISH = new Set(['text', 'email', 'tel', 'search', 'url', 'textarea']);

/**
 * 한 칸의 문제 문구('' 이면 문제 없음).
 *   ① 남은 표시를 지우고 ② 브라우저 기본 규칙 ③ 공백만 입력한 필수 칸 ④ 이메일 모양(서버와 같은 규칙)
 */
export function fieldIssue(el: Field): string {
  el.setCustomValidity('');
  if (!el.validity.valid) return nativeMessage(el);
  const type = el instanceof HTMLTextAreaElement ? 'textarea' : (el as HTMLInputElement).type;
  if (TEXTISH.has(type)) {
    const v = el.value;
    if (el.required && !v.trim()) return msgs().required;
    if (type === 'email' && v.trim() && !isEmail(v)) return msgs().email;
  }
  return '';
}

export type Issue = { el: HTMLElement | null; msg?: string };

/**
 * 폼에서 첫 번째(위→아래) 문제 칸. 보이지 않는 칸·비활성 칸은 보지 않는다.
 * @param skip 이번 판정에서 뺄 칸(예: 다운로드는 개인정보 동의를 보지 않는다)
 */
export function firstFieldIssue(form: HTMLFormElement, skip?: (el: Field) => boolean): { el: Field; msg: string } | null {
  for (const raw of Array.from(form.elements)) {
    if (!inScope(raw)) continue;
    if (skip?.(raw)) continue;
    const msg = fieldIssue(raw);
    if (msg) return { el: raw, msg };
  }
  return null;
}

/** 여러 후보 중 문서 순서상 가장 위의 것 */
export function firstInDocument<T extends { el: HTMLElement | null }>(list: T[]): T | null {
  const live = list.filter((x) => x.el && x.el.isConnected);
  live.sort((a, b) => (a.el!.compareDocumentPosition(b.el!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return live[0] ?? null;
}

/**
 * 말풍선을 붙일 요소 — 칸을 감싼 label(보일 때) → 칸 자신(보일 때) → 화면에 보이는 가장 가까운 조상.
 * 숨은 칸을 가리키면 위치가 0,0 이라 말풍선이 화면 구석에 뜬다(이번 사고의 ③).
 */
export function anchorOf(el: HTMLElement): HTMLElement {
  const lab = el.closest('label');
  if (lab && isShown(lab)) return lab as HTMLElement;
  if (isShown(el)) return el;
  let p = el.parentElement;
  while (p && !isShown(p)) p = p.parentElement;
  return p ?? el;
}
