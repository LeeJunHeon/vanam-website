// 보안 확인(Turnstile) 위젯 — 단일 창구.
//
// 왜 필요한가:
//   예전에는 견적 폼·문의 폼·주문서 **세 곳이 각각** 이렇게만 불러왔다.
//     <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer>
//   이 방식은 **한 번 실패하면 그걸로 끝**이다. 실패를 감지하지도, 다시 시도하지도,
//   고객에게 알리지도 않는다. 모바일 네트워크에서 이 요청이 한 번 미끄러지면
//   위젯 자리에 빈 상자만 남고, 토큰이 영원히 안 생겨 **제출 버튼이 계속 잠긴 채로 있다.**
//   고객은 왜 안 되는지 알 방법이 없고, 새로고침해야만 풀렸다. (모바일 실기기에서 실제로 발생)
//
// 그래서 이 파일이 하는 일:
//   ① 명시적 렌더 — 스크립트가 알아서 그리게 두지 않고 우리가 직접 그린다. 실패를 코드로 잡을 수 있다.
//   ② 자동 재시도 — 스크립트 로드 실패 시 3초 간격 최대 2회 재시도. 위젯 오류·시간초과도 자동 초기화.
//   ③ 안내 + 수동 재시도 — 10초 안에 뜨지 않으면 위젯 자리에 사유와 [다시 시도] 버튼을 보여준다.
//
// ⚠️ **위젯이 떴는지 판정하는 기준에 주의할 것.**
//    Turnstile 은 컨테이너 안에 iframe 을 만들지 **않는다.** 실제로 렌더된 위젯의 내용물은
//    `<div>` 하나 + 숨은 input(cf-turnstile-response) 뿐이고 iframe 은 0개다(실측 확인).
//    예전 판정이 "iframe 이 있는가?" 였던 탓에 **정상 동작 중인 위젯을 실패로 오인해
//    안내 문구로 덮어써 버렸다.** 고객이 체크박스를 통과해도 곧바로 다시 안내가 뜨던 원인이다.
//    → 판정은 **render() 가 돌려준 위젯 id** 또는 **숨은 input 의 존재**로 한다.
//
// ⚠️ 스크립트는 페이지당 **한 번만** 붙인다(중복 로드 방지).

type TS = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
};

// 시스템 오류 문구 — 마케팅 카피가 아니라 3곳이 공유하는 장치 문구라 여기서 관리한다.
// (BaseLayout 의 폼 검증 문구와 같은 성격)
const TXT = {
  ko: { failed: '보안 확인을 불러오지 못했습니다.', retry: '다시 시도' },
  en: { failed: 'Could not load the security check.', retry: 'Retry' },
} as const;

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__vnTurnstileReady';
const MAX_LOAD_TRIES = 3;      // 최초 1회 + 재시도 2회
const RETRY_DELAY = 3000;      // 재시도 간격
const SHOW_FALLBACK_AFTER = 12000;  // 이 시간까지 못 뜨면 안내

let loadTries = 0;
let fallbackTimer: number | undefined;

const ts = (): TS | undefined => (window as unknown as { turnstile?: TS }).turnstile;
const txt = () => (document.documentElement.lang === 'ko' ? TXT.ko : TXT.en);

const boxes = () => Array.from(document.querySelectorAll<HTMLElement>('.cf-turnstile'));

/** 위젯이 살아 있는가 — 위젯 id 가 있거나 숨은 응답 input 이 만들어졌으면 정상. */
const isMounted = (box: HTMLElement) =>
  !!box.dataset.vnWidgetId || !!box.querySelector('input[name="cf-turnstile-response"]');

function showFallback(box: HTMLElement) {
  if (isMounted(box) || box.dataset.vnFallback === '1') return;   // 살아 있으면 절대 건드리지 않는다
  box.dataset.vnFallback = '1';
  const t = txt();
  box.innerHTML =
    `<div class="rounded-lg border border-danger/30 bg-danger/[0.06] px-4 py-3 text-sm text-ink/70">` +
    `<span>${t.failed}</span> ` +
    `<button type="button" data-vn-ts-retry class="ml-1 font-semibold text-accent underline underline-offset-2">${t.retry}</button>` +
    `</div>`;
  box.querySelector('[data-vn-ts-retry]')?.addEventListener('click', () => retry(box));
}

function retry(box: HTMLElement) {
  box.dataset.vnFallback = '';
  box.dataset.vnRendered = '';
  box.dataset.vnErrors = '';
  delete box.dataset.vnWidgetId;
  box.innerHTML = '';
  // 스크립트가 이미 있으면 다시 받지 않는다 — 그리기만 다시 한다.
  if (ts()) { renderAll(); armFallback(); }
  else { loadTries = 0; loadScript(); }
}

function armFallback() {
  window.clearTimeout(fallbackTimer);
  fallbackTimer = window.setTimeout(() => boxes().forEach(showFallback), SHOW_FALLBACK_AFTER);
}

function onWidgetError(box: HTMLElement) {
  const n = Number(box.dataset.vnErrors || '0') + 1;
  box.dataset.vnErrors = String(n);
  if (n <= 1) { try { ts()?.reset(box.dataset.vnWidgetId); return; } catch { /* 아래로 */ } }
  delete box.dataset.vnWidgetId;
  box.dataset.vnRendered = '';
  showFallback(box);
}

function loadScript() {
  loadTries += 1;
  const s = document.createElement('script');
  s.src = SRC;
  s.async = true;
  s.defer = true;
  s.onerror = () => {
    s.remove();
    if (loadTries < MAX_LOAD_TRIES) window.setTimeout(loadScript, RETRY_DELAY);
    else boxes().forEach(showFallback);
  };
  document.head.appendChild(s);
}

function renderAll() {
  const api = ts();
  if (!api) return;
  for (const box of boxes()) {
    if (box.dataset.vnRendered === '1' || box.dataset.vnFallback === '1') continue;
    box.dataset.vnRendered = '1';
    try {
      box.dataset.vnWidgetId = api.render(box, {
        sitekey: box.dataset.sitekey,
        theme: box.dataset.theme || 'auto',
        language: box.dataset.language || 'auto',
        // 위젯이 스스로 실패를 알려오면 한 번은 조용히 되살리고, 두 번째부터 안내를 띄운다.
        'error-callback': () => onWidgetError(box),
        'timeout-callback': () => onWidgetError(box),
        'expired-callback': () => { try { api.reset(box.dataset.vnWidgetId); } catch { /* 무시 */ } },
      });
    } catch {
      box.dataset.vnRendered = '';
      showFallback(box);
    }
  }
  // 전부 떴으면 안내 타이머를 끈다 — 살아 있는 위젯을 덮어쓰지 않기 위한 안전장치.
  if (boxes().every(isMounted)) window.clearTimeout(fallbackTimer);
}

function start() {
  if (!boxes().length) return;
  (window as unknown as { __vnTurnstileReady?: () => void }).__vnTurnstileReady = renderAll;
  armFallback();
  if (ts()) renderAll();   // 다른 폼이 이미 스크립트를 올려둔 경우
  else loadScript();
}

/** 폼에서 호출한다. 위젯이 있는 페이지에서만 동작한다. */
export function mountTurnstile(): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

/**
 * 제출 후 토큰을 새로 받기 위해 초기화한다.
 * ⚠️ 명시적 렌더에서는 인자 없는 reset() 이 동작하지 않으므로 위젯 id 를 넘겨야 한다.
 */
export function resetTurnstile(): void {
  const api = ts();
  if (!api) return;
  boxes().forEach((box) => {
    try { api.reset(box.dataset.vnWidgetId); } catch { /* 무시 */ }
  });
}
