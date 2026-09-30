// 조회·완료 화면 공용 견적 상자 — 순수 함수(브라우저·node 테스트가 같이 쓴다).
//
//   renderQuoteBox(view, T, opts) → HTML 문자열 (view 없으면 '')
//   totalLine(T, krw, usd)        → 금액 줄 HTML(큰 금액 + 작은 설명) — 제품 페이지 예상 견적도 같이 쓴다
//   docOptions(view, T, lang)     → buildQuoteDoc 에 넘길 견적서 데이터(logoUrl 은 호출부가 붙인다) · 견적서가 없으면 null
//
// view 는 서버가 준 inquiry.quote(src/lib/quote-revision.js 의 customerQuoteView)다. 금액은 view 값을 그대로 쓴다
// — 화면에서 계산하지 않는다. view 의 허용 키만 읽고, 넣는 값은 전부 이스케이프한다.
// T 는 site.json 의 quote.view 문구(ko/en).
//
// 스타일은 이 모듈의 QV_CSS 를 페이지가 한 번 넣는다(injectQuoteViewStyle) — 공용 CSS 에 새 유틸리티를 만들지 않는다.
// 제품 페이지의 [예상 견적 보기] 결과(QuoteEstimate.astro)도 같은 QV_CSS·같은 클래스를 쓴다 — 고객에게 보이는 견적 상자는 한 모양.
// 모양은 사이트 공통 디자인에 맞춘다(0930 — 주황 굵은 안내 상자가 사이트와 따로 놀았다):
//   상자 = 공정 단계·조회 카드와 같은 테두리·배경(border-ink/10 · bg-ink/[0.02] · rounded-xl · p-5)
//   제목 = 조회·주문완료 카드의 소제목과 같은 작은 대문자 시안(text-xs font-medium uppercase tracking-widest text-accent)
//   금액 = 주문완료 금액과 같은 text-2xl font-bold + 옆에 작은 설명(text-sm, 잉크 60%)
//   안내 = 완료 화면의 '접수번호 보관' 안내처럼 구분선(border-t border-ink/10) 아래 보조 문구 + 시안 (i) 아이콘
//   오류 = danger 테두리·틴트(border-danger/40 · bg-danger/[0.05]). 경고색(주황)은 쓰지 않는다.
//   한글 줄바꿈은 낱말 단위(break-keep) — 좁은 화면에서 '담당/자가'처럼 끊기지 않게.

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

// 안내 앞 작은 (i) 아이콘 — 시안(accent) 한 색. SVG 를 마스크로 써서 테마 색을 그대로 따른다.
const ICON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M12 11v5M12 8h.01'/%3E%3C/svg%3E") center/contain no-repeat`;

export const QV_CSS = `
.qv-box{margin-top:1.25rem;border:1px solid color-mix(in oklab,var(--color-ink) 10%,transparent);border-radius:.75rem;background:color-mix(in oklab,var(--color-ink) 2%,transparent);padding:1.25rem;line-height:1.6;word-break:keep-all}
.qv-box.qv-bad{border-color:color-mix(in oklab,var(--color-danger) 40%,transparent);background:color-mix(in oklab,var(--color-danger) 5%,transparent)}
.qv-label{font-size:.75rem;line-height:1rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--color-accent)}
.qv-bad .qv-label{color:var(--color-danger)}
.qv-total{margin-top:.5rem;display:flex;flex-wrap:wrap;align-items:baseline;column-gap:.5rem;row-gap:.125rem}
.qv-amount{font-size:1.5rem;line-height:2rem;font-weight:700;color:var(--color-ink)}
.qv-meta{font-size:.875rem;color:color-mix(in oklab,var(--color-ink) 60%,transparent)}
.qv-text{margin-top:.5rem;font-size:.875rem;line-height:1.65;color:color-mix(in oklab,var(--color-ink) 80%,transparent)}
.qv-sub{margin-top:.25rem;font-size:.875rem;color:color-mix(in oklab,var(--color-ink) 60%,transparent)}
.qv-label+.qv-sub{margin-top:.5rem}
.qv-notice{position:relative;margin-top:1rem;border-top:1px solid color-mix(in oklab,var(--color-ink) 10%,transparent);padding:1rem 0 0 1.5rem;font-size:.875rem;line-height:1.65;color:color-mix(in oklab,var(--color-ink) 75%,transparent)}
.qv-notice::before{content:"";position:absolute;left:0;top:calc(1rem + .2em);width:1rem;height:1rem;background:var(--color-accent);-webkit-mask:${ICON};mask:${ICON}}
.qv-list{margin-top:.75rem;list-style:none;padding:0;font-size:.875rem;color:color-mix(in oklab,var(--color-ink) 80%,transparent)}
.qv-list li{position:relative;padding-left:1rem}
.qv-list li+li{margin-top:.25rem}
.qv-list li::before{content:"";position:absolute;left:.125rem;top:.6em;width:.375rem;height:.375rem;border-radius:9999px;background:var(--color-accent)}
.qv-bad .qv-list li::before{background:var(--color-danger)}
.qv-list+.qv-sub{margin-top:.75rem}
.qv-actions{margin-top:1rem;display:flex;flex-wrap:wrap;align-items:center;gap:.75rem}
.qv-live{font-size:.8125rem;color:color-mix(in oklab,var(--color-ink) 60%,transparent)}
.qv-msg{margin-top:.5rem;font-size:.875rem;color:var(--color-danger)}
.qv-box>:first-child{margin-top:0}
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
 * 금액 줄 — 큰 금액(totalMain) + 작은 설명(totalMeta). ko 는 원화가, en 은 달러 환산이 앞에 온다(문구가 정한다).
 * @param {Record<string, string>} T @param {unknown} krw @param {unknown} usd
 */
export function totalLine(T, krw, usd) {
  const v = { krw, usd };
  return `<p class="qv-total"><span class="qv-amount">${fill(T.totalMain, v)}</span><span class="qv-meta">${fill(T.totalMeta, v)}</span></p>`;
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
      totalLine(T, view.totalKrwText, view.totalUsdText) +
      (view.validDays && view.validUntil ? `<p class="qv-sub">${fill(T.valid, { days: view.validDays, date: view.validUntil })}</p>` : '') +
      (updated ? `<p class="qv-sub">${fill(T.updated, { date: updated })}</p>` : '') +
      `<div class="qv-notice">${esc(T.notice)}</div>` +
      (docBtn ? `<div class="qv-actions">${docBtn}</div>` : '') +
      `<p class="qv-msg" data-qv-msg hidden></p>` +
      refresh +
      `</div>`;
  }
  if (state === 'reviewing') {
    const items = Array.isArray(view.manual) ? view.manual : [];
    return `<div class="qv-box" data-qv-state="reviewing">` +
      `<p class="qv-label">${esc(T.reviewing)}</p>` +
      `<p class="qv-text">${esc(T.reviewingIntro)}</p>` +
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
