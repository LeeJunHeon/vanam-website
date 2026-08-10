// 폼 검증 안내 공통 모듈 (0227).
//   ⚠ 레이아웃 불변이 핵심 요건이다. 문서 흐름에 요소를 끼워 넣으면 버튼이 밀리고 행 높이가
//     바뀌므로, 항상 position:fixed 오버레이 한 장만 띄운다.
//   ⚠ 브라우저 기본 말풍선(reportValidity)은 스크롤 중 자동으로 닫혀 "안 보이거나 깜빡"인다.
//     그래서 쓰지 않고, 스크롤이 끝난 뒤 이 말풍선을 띄운다.
//   견적 폼과 주문(Checkout)이 같은 모양·같은 동작을 쓰도록 여기 하나로 모았다.
//   모양: 대상 필드를 가리키는 꼬리(caret) 달린 말풍선. 색은 사이트 토큰(--v-ink/--v-canvas)을
//   그대로 써서 다크·라이트 테마와 톤을 맞춘다.

let hintEl: HTMLDivElement | null = null;
let caretEl: HTMLDivElement | null = null;
let hideTimer = 0;
let anchorEl: HTMLElement | null = null;
let bound = false;
let flipped = false;

const BUBBLE = [
  'position:fixed',
  'z-index:60',
  'max-width:min(20rem,calc(100vw - 2rem))',
  'padding:9px 13px',
  'border-radius:10px',
  'background:color-mix(in srgb, var(--v-ink) 92%, transparent)',
  'color:var(--v-canvas)',
  'font-size:13px',
  'font-weight:500',
  'line-height:1.45',
  'letter-spacing:-0.01em',
  'box-shadow:0 8px 24px -8px rgb(0 0 0 / 0.35)',
  'opacity:0',
  'transform:translateY(-2px)',
  'transition:opacity .16s ease, transform .16s ease',
  'pointer-events:none',
].join(';');

const CARET = [
  'position:fixed',
  'z-index:59',
  'width:10px',
  'height:10px',
  'background:color-mix(in srgb, var(--v-ink) 92%, transparent)',
  'transform:rotate(45deg)',
  'border-radius:2px',
  'opacity:0',
  'transition:opacity .16s ease',
  'pointer-events:none',
].join(';');

function ensure(): HTMLDivElement {
  if (hintEl && hintEl.isConnected) return hintEl;
  caretEl = document.createElement('div');
  caretEl.style.cssText = CARET;
  document.body.appendChild(caretEl);
  const el = document.createElement('div');
  el.setAttribute('role', 'alert');
  el.style.cssText = BUBBLE;
  document.body.appendChild(el);
  hintEl = el;
  return el;
}

function place(): void {
  if (!hintEl || !anchorEl) return;
  const r = anchorEl.getBoundingClientRect();
  const h = hintEl.offsetHeight || 38;
  const w = hintEl.offsetWidth || 200;
  const gap = 10;
  // 기본은 필드 아래. 아래 공간이 부족하면 위로 뒤집는다.
  flipped = r.bottom + gap + h > window.innerHeight - 8;
  const top = flipped ? Math.max(8, r.top - gap - h) : r.bottom + gap;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  hintEl.style.top = `${Math.round(top)}px`;
  hintEl.style.left = `${Math.round(left)}px`;
  if (caretEl) {
    // 꼬리는 말풍선 가장자리에 반쯤 걸치게 두어 대상 필드를 가리킨다
    const cx = Math.min(Math.max(r.left + 18, left + 12), left + w - 22);
    caretEl.style.left = `${Math.round(cx)}px`;
    caretEl.style.top = `${Math.round(flipped ? top + h - 5 : top - 5)}px`;
  }
}

function bind(): void {
  if (bound) return;
  bound = true;
  const reposition = () => { if (hintEl && anchorEl) place(); };
  addEventListener('scroll', reposition, { passive: true, capture: true });
  addEventListener('resize', reposition, { passive: true });
}

export function hideHint(): void {
  window.clearTimeout(hideTimer);
  if (hintEl) { hintEl.style.opacity = '0'; hintEl.style.transform = 'translateY(-2px)'; }
  if (caretEl) caretEl.style.opacity = '0';
  anchorEl = null;
}

/** 대상으로 스크롤한 뒤 그 옆에 말풍선을 띄운다. 항상 1개만 존재하며 레이아웃에 영향이 없다. */
export function showHint(target: HTMLElement | null, message: string, focusEl?: HTMLElement | null): void {
  if (!target || !message) return;
  bind();
  const el = ensure();
  anchorEl = target;
  el.textContent = message;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const focusable = focusEl ?? target;
  if (focusable && typeof (focusable as HTMLInputElement).focus === 'function') {
    try { (focusable as HTMLInputElement).focus({ preventScroll: true }); } catch { /* noop */ }
  }
  place();
  // 부드러운 스크롤이 끝난 뒤 최종 위치에서 나타난다
  window.setTimeout(() => {
    place();
    if (hintEl) { hintEl.style.opacity = '1'; hintEl.style.transform = 'translateY(0)'; }
    if (caretEl) caretEl.style.opacity = '1';
  }, 220);
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hideHint, 5000);
  const dismiss = () => hideHint();
  target.addEventListener('input', dismiss, { once: true });
  target.addEventListener('change', dismiss, { once: true });
}
