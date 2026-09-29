// 조회·완료 화면 공용 견적 상자 — 순수 함수(브라우저·node 테스트가 같이 쓴다).
//
//   renderQuoteBox(view, T, opts) → HTML 문자열 (view 없으면 '')
//   docOptions(view, T, lang)     → buildQuoteDoc 에 넘길 견적서 데이터(logoUrl 은 호출부가 붙인다) · 견적서가 없으면 null
//
// view 는 서버가 준 inquiry.quote(src/lib/quote-revision.js 의 customerQuoteView)다. 금액은 view 값을 그대로 쓴다
// — 화면에서 계산하지 않는다. view 의 허용 키만 읽고, 넣는 값은 전부 이스케이프한다.
// T 는 site.json 의 quote.view 문구(ko/en).
//
// 스타일은 이 모듈의 QV_CSS 를 페이지가 한 번 넣는다(injectQuoteViewStyle) — 공용 CSS 에 새 유틸리티를 만들지 않는다.

const esc = (v) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** 이스케이프한 문구의 {자리}에 이스케이프한 값을 넣는다 */
const fill = (tpl, vars) => esc(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));

/** ISO 시각 → 한국 시간 'YYYY-MM-DD HH:mm' (형식이 이상하면 빈 문자열) */
export function kstStamp(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '';
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

export const QV_CSS = `
.qv-box{margin-top:1.25rem;border:1px solid color-mix(in srgb,var(--color-ink) 12%,transparent);border-radius:.75rem;padding:1.1rem 1.25rem;line-height:1.65}
.qv-label{font-size:.8125rem;font-weight:600;letter-spacing:.02em;color:color-mix(in srgb,var(--color-ink) 60%,transparent)}
.qv-total{margin-top:.25rem;font-size:1.25rem;font-weight:700;color:var(--color-ink)}
.qv-notice{margin-top:.75rem;border:2px solid var(--color-warn);border-radius:.5rem;padding:.7rem .9rem;background:color-mix(in srgb,var(--color-warn) 12%,transparent);font-weight:700;color:var(--color-ink)}
.qv-sub{margin-top:.5rem;font-size:.875rem;color:color-mix(in srgb,var(--color-ink) 65%,transparent)}
.qv-list{margin:.5rem 0 .5rem 1.25rem;list-style:disc;font-size:.9375rem;color:color-mix(in srgb,var(--color-ink) 80%,transparent)}
.qv-actions{margin-top:.9rem;display:flex;flex-wrap:wrap;align-items:center;gap:.6rem}
.qv-live{font-size:.8125rem;color:color-mix(in srgb,var(--color-ink) 55%,transparent)}
.qv-msg{margin-top:.5rem;font-size:.875rem;color:var(--color-danger)}
`;

/** 페이지에 QV_CSS 를 한 번만 넣는다 @param {Document} doc */
export function injectQuoteViewStyle(doc) {
  if (!doc || doc.getElementById('qv-style')) return;
  const el = doc.createElement('style');
  el.id = 'qv-style';
  el.textContent = QV_CSS;
  doc.head.appendChild(el);
}

/**
 * @param {any} view inquiry.quote
 * @param {Record<string, string>} T site.json quote.view
 * @param {{refresh?: boolean}} [opts] refresh: '최신 견적 다시 보기' 줄 표시(조회 화면)
 * @returns {string}
 */
export function renderQuoteBox(view, T, opts = {}) {
  if (!view || typeof view !== 'object') return '';
  const state = String(view.state ?? '');
  const refresh = opts.refresh
    ? `<div class="qv-actions"><span class="qv-live">${esc(T.liveNote)}</span><button type="button" class="v-btn-ghost-sm" data-qv-refresh>${esc(T.refresh)}</button></div>`
    : '';
  const docBtn = view.doc ? `<button type="button" class="v-btn-ghost-sm" data-qv-doc>${esc(T.docBtn)}</button>` : '';

  if (state === 'estimate') {
    const updated = kstStamp(view.updatedAt);
    return `<div class="qv-box" data-qv-state="estimate">` +
      `<p class="qv-label">${esc(view.byStaff ? T.estimateByStaff : T.estimate)}</p>` +
      `<p class="qv-total">${fill(T.total, { krw: view.totalKrwText, usd: view.totalUsdText })}</p>` +
      `<div class="qv-notice">${esc(T.notice)}</div>` +
      (view.validDays && view.validUntil ? `<p class="qv-sub">${fill(T.valid, { days: view.validDays, date: view.validUntil })}</p>` : '') +
      (updated ? `<p class="qv-sub">${fill(T.updated, { date: updated })}</p>` : '') +
      (docBtn ? `<div class="qv-actions">${docBtn}</div>` : '') +
      `<p class="qv-msg" data-qv-msg hidden></p>` +
      refresh +
      `</div>`;
  }
  if (state === 'reviewing') {
    const items = Array.isArray(view.manual) ? view.manual : [];
    return `<div class="qv-box" data-qv-state="reviewing">` +
      `<p class="qv-label">${esc(T.reviewing)}</p>` +
      `<p class="qv-sub">${esc(T.reviewingIntro)}</p>` +
      (items.length ? `<ul class="qv-list">${items.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '') +
      refresh +
      `</div>`;
  }
  if (state === 'confirmed') {
    return `<div class="qv-box" data-qv-state="confirmed">` +
      `<p class="qv-label">${esc(T.confirmed)}</p>` +
      (docBtn ? `<div class="qv-actions">${docBtn}</div><p class="qv-msg" data-qv-msg hidden></p>` : '') +
      `</div>`;
  }
  return '';
}

/**
 * 견적서 데이터 — buildQuoteDoc 에 넘긴다(logoUrl 은 호출부가 붙인다). 견적서가 없으면 null.
 * @param {any} view inquiry.quote @param {Record<string, string>} T @param {'ko'|'en'} lang
 */
export function docOptions(view, T, lang) {
  const doc = view?.doc;
  if (!doc || typeof doc !== 'object') return null;
  const en = lang === 'en';
  const base = {
    info: doc.info, items: doc.items, supply: doc.supply, vat: doc.vat, total: doc.total, totalKorean: doc.totalKorean,
    lang: en ? 'en' : 'ko',
  };
  if (view.state === 'estimate') {
    return { ...base, stamp: T.docStamp, note: T.docNoteEstimate, fxNote: en && view.totalUsdText ? `${T.approx} ${view.totalUsdText}` : '' };
  }
  if (view.state === 'confirmed') return { ...base, stamp: '', note: T.docNoteConfirmed, fxNote: '' };
  return null;
}
