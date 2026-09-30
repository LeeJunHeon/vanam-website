// scripts/test-quote-view.mjs — 조회·완료 화면 견적 상자(src/lib/quote-view-render.js) 테스트
//
// 문구는 실제 site.json(quote.view)을 쓰고, 금액·견적서는 가짜 값만 쓴다.
import { readFileSync } from 'node:fs';
import { renderQuoteBox, docOptions, kstStamp, totalLine, QV_CSS } from '../src/lib/quote-view-render.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}
const site = JSON.parse(readFileSync('src/data/site.json', 'utf8'));
const KO = site.ko.quote.view, EN = site.en.quote.view;

// site.json 키가 빠짐없이 있는지(ko·en)
const VIEW_KEYS = ['estimate', 'estimateByStaff', 'confirmed', 'reviewing', 'reviewingIntro', 'totalMain', 'totalMeta', 'valid', 'notice', 'updated',
  'docBtn', 'refresh', 'liveNote', 'approx', 'docStamp', 'docNoteEstimate', 'docNoteConfirmed', 'popupBlocked'];
const EST_KEYS = ['button', 'calculating', 'title', 'totalMain', 'totalMeta', 'valid', 'notice', 'manualTitle', 'manualIntro', 'manualCta',
  'invalidTitle', 'invalidIntro', 'fail', 'unavailable', 'tooMany'];
for (const loc of ['ko', 'en']) {
  eq(`site.json ${loc} quote.view 키`, VIEW_KEYS.filter((k) => typeof site[loc].quote.view?.[k] !== 'string' || !site[loc].quote.view[k]), []);
  eq(`site.json ${loc} quote.estimate 키`, EST_KEYS.filter((k) => typeof site[loc].quote.estimate?.[k] !== 'string' || !site[loc].quote.estimate[k]), []);
  eq(`site.json ${loc} quote.form 등급 키`, ['grade', 'gradePlaceholder'].filter((k) => !site[loc].quote.form?.[k]), []);
  // 예전 한 줄 금액 문구(total)는 totalMain·totalMeta 로 나뉘었다 — 남아 있으면 어느 쪽을 쓰는지 헷갈린다
  eq(`site.json ${loc} 옛 total 키 없음`, ['view', 'estimate'].filter((b) => 'total' in (site[loc].quote[b] ?? {})), []);
  // 금액 자리: 원화·달러가 금액 줄 어딘가에 한 번씩
  for (const b of ['view', 'estimate']) {
    const t = site[loc].quote[b];
    const both = `${t.totalMain} ${t.totalMeta}`;
    eq(`site.json ${loc} quote.${b} 금액 줄 자리({krw}·{usd} 한 번씩)`, [both.split('{krw}').length - 1, both.split('{usd}').length - 1], [1, 1]);
  }
}
// 금액 줄 — 큰 금액 + 작은 설명, 값은 이스케이프
eq('totalLine', totalLine({ totalMain: '{krw}', totalMeta: 'VAT · {usd}' }, '₩1', '<b>'),
  '<p class="qv-total"><span class="qv-amount">₩1</span><span class="qv-meta">VAT · &lt;b&gt;</span></p>');
// 사이트 디자인과 맞춘 상자(0930): 경고색(주황) 강조 상자를 다시 쓰지 않는다
eq('QV_CSS: 경고색(--color-warn) 없음', QV_CSS.includes('--color-warn'), false);
{
  const qe = readFileSync('src/components/QuoteEstimate.astro', 'utf8');
  eq('QuoteEstimate: 공용 상자(qv-box·QV_CSS) 사용 · 자체 상자 스타일 없음',
    [qe.includes('class="qv-box"'), qe.includes('injectQuoteViewStyle'), /\.qe-(box|notice|total|title)\b/.test(qe), qe.includes('--color-warn')],
    [true, true, false, false]);
}

const DOC = { info: { customer: 'C', ref: '', title: 'T', date: '2026-01-10', quoteNo: 'INQ-1', manager: '', contact: 'c', delivery: '', validDays: '7', payment: '' },
  items: [{ name: 'A', spec: 's', qty: 1, unit: '회', unitPrice: 100, supply: 100, vat: 10 }], supply: 100, vat: 10, total: 110, totalKorean: '일백일십' };
const EST = { state: 'estimate', rev: 1, updatedAt: '2026-01-10T01:02:00.000Z', byStaff: false, totalKrw: 110, totalKrwText: '₩110',
  totalUsdText: '$0.08', validDays: 7, validUntil: '2026-01-17', manual: [], doc: DOC };
const REV = { state: 'reviewing', rev: 1, updatedAt: '2026-01-10T01:02:00.000Z', byStaff: false, totalKrw: null, totalKrwText: null,
  totalUsdText: null, validDays: null, validUntil: null, manual: ['분석: XPS', '1단계 ALD Al₂O₃'], doc: null };
const CONF = { ...EST, state: 'confirmed', totalKrw: 110 };
const CONF_NODOC = { ...CONF, doc: null, totalKrw: null, totalKrwText: null, totalUsdText: null };

// estimate
{
  const h = renderQuoteBox(EST, KO, { refresh: true });
  const put = (t) => t.replace('{krw}', '₩110').replace('{usd}', '$0.08');
  eq('estimate: 라벨·금액 줄(view 값 그대로)·안내·유효·갱신', [
    h.includes(`>${KO.estimate}<`),
    h.includes(totalLine(KO, '₩110', '$0.08')),
    h.includes(`class="qv-amount">${put(KO.totalMain)}<`) && h.includes(`class="qv-meta">${put(KO.totalMeta)}<`),
    h.includes(`class="qv-notice">${KO.notice}<`),
    h.includes(KO.valid.replace('{days}', '7').replace('{date}', '2026-01-17')),
    h.includes(KO.updated.replace('{date}', '2026-01-10 10:02')),
  ], [true, true, true, true, true, true]);
  // 순서: 제목 → 금액 → 유효기간 → 갱신 → 안내 → 견적서 버튼
  const at = (k) => h.indexOf(k);
  eq('estimate: 순서(제목·금액·유효·갱신·안내·버튼)', [
    at('qv-label') < at('qv-total'), at('qv-total') < at(KO.valid.slice(0, 4)), at(KO.valid.slice(0, 4)) < at(KO.updated.slice(0, 4)),
    at(KO.updated.slice(0, 4)) < at('qv-notice'), at('qv-notice') < at('data-qv-doc'),
  ], [true, true, true, true, true]);
  eq('estimate: 견적서 버튼·새로고침 줄', [h.includes('data-qv-doc'), h.includes('data-qv-refresh'), h.includes(KO.liveNote)], [true, true, true]);
  eq('estimate: refresh 없으면 새로고침 줄 없음', renderQuoteBox(EST, KO).includes('data-qv-refresh'), false);
  eq('estimate: byStaff 라벨', renderQuoteBox({ ...EST, byStaff: true }, KO).includes(`>${KO.estimateByStaff}<`), true);
  eq('estimate: doc 없으면 견적서 버튼 없음', renderQuoteBox({ ...EST, doc: null }, KO).includes('data-qv-doc'), false);
  const e = renderQuoteBox(EST, EN, { refresh: true });
  eq('estimate en: 금액 줄(달러가 큰 글씨, 원화는 설명)', [e.includes(`class="qv-amount">${EN.totalMain.replace('{usd}', '$0.08')}<`),
    e.includes(`class="qv-meta">${EN.totalMeta.replace('{krw}', '₩110')}<`)], [true, true]);
  eq('estimate en: 한글 없음(문구·값 모두 영문일 때)', /[가-힣]/.test(e), false);
}
// reviewing
{
  const h = renderQuoteBox(REV, KO, { refresh: true });
  eq('reviewing: 라벨·안내·목록·새로고침', [h.includes(`>${KO.reviewing}<`), h.includes(KO.reviewingIntro), h.includes('<li>분석: XPS</li>'), h.includes('data-qv-refresh')], [true, true, true, true]);
  eq('reviewing: 금액·견적서 없음', [h.includes('qv-total'), h.includes('data-qv-doc')], [false, false]);
}
// confirmed
{
  const h = renderQuoteBox(CONF, KO);
  eq('confirmed: 라벨·견적서 버튼·금액 줄 없음', [h.includes(`>${KO.confirmed}<`), h.includes('data-qv-doc'), h.includes('qv-total')], [true, true, false]);
  eq('confirmed: doc 없으면 버튼 없음', renderQuoteBox(CONF_NODOC, KO).includes('data-qv-doc'), false);
}
// 이스케이프 · 없음
{
  const bad = { ...REV, manual: ['<script>alert(1)</script>'] };
  const h = renderQuoteBox(bad, KO);
  eq('manual 이스케이프', [h.includes('<script>'), h.includes('&lt;script&gt;')], [false, true]);
  const bad2 = { ...EST, totalKrwText: '<img src=x>', totalUsdText: '"x"' };
  const h2 = renderQuoteBox(bad2, KO);
  eq('금액 문자열 이스케이프', [h2.includes('<img'), h2.includes('&lt;img src=x&gt;'), h2.includes('&quot;x&quot;')], [false, true, true]);
  eq('view null·빈 값 → 빈 문자열', [renderQuoteBox(null, KO), renderQuoteBox(undefined, KO), renderQuoteBox({ state: 'x' }, KO)], ['', '', '']);
  eq('kstStamp', [kstStamp('2026-01-10T15:30:00.000Z'), kstStamp('bad')], ['2026-01-11 00:30', '']);
}
// docOptions
{
  const d = docOptions(EST, KO, 'ko');
  eq('docOptions estimate ko', [d.stamp, d.note, d.fxNote, d.lang, d.total, d.info.quoteNo], [KO.docStamp, KO.docNoteEstimate, '', 'ko', 110, 'INQ-1']);
  const de = docOptions(EST, EN, 'en');
  eq('docOptions estimate en: fxNote = approx + USD', [de.lang, de.stamp, de.fxNote], ['en', EN.docStamp, `${EN.approx} $0.08`]);
  const dc = docOptions(CONF, KO, 'ko');
  eq('docOptions confirmed: stamp 없음 · note 확정', [dc.stamp, dc.note, dc.fxNote], ['', KO.docNoteConfirmed, '']);
  eq('docOptions: doc 없음·reviewing → null', [docOptions(REV, KO, 'ko'), docOptions(CONF_NODOC, KO, 'ko'), docOptions(null, KO, 'ko')], [null, null, null]);
  eq('docOptions: logoUrl 은 호출부 몫', 'logoUrl' in d, false);
}

if (failed) {
  console.error(`\n견적 상자(quote-view-render) 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 견적 상자(quote-view-render) — ${total}건 통과`);
