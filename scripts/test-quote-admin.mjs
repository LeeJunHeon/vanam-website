// scripts/test-quote-admin.mjs — 관리자 견적 편집 순수 모듈(src/lib/quote-admin.js) 테스트
//
// sanitizeDocInfo · planInquirySync · summarizeRevisions 의 모든 분기·경계·이상값. 금액은 가짜 값만 쓴다.
import { sanitizeDocInfo, planInquirySync, summarizeRevisions } from '../src/lib/quote-admin.js';
import { manualLabelAdmin } from '../src/lib/quote-customer.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}
const TODAY = '2026-01-10';
const s = (info) => sanitizeDocInfo(info, { today: TODAY });

// ── sanitizeDocInfo ──────────────────────────────────────────────────────────
{
  const full = { customer: ' 가짜대학 홍길동 ', ref: '참조', title: '견적명', date: '2026-02-03', quoteNo: 'INQ-1', manager: '담당',
    contact: '02-0000-0000', delivery: '협의', validDays: '14', payment: '계좌이체' };
  eq('정상 입력 · 앞뒤 공백 제거', s(full), { ...full, customer: '가짜대학 홍길동' });
  eq('키 순서·개수 = 10개', Object.keys(s({})), ['customer', 'ref', 'title', 'date', 'quoteNo', 'manager', 'contact', 'delivery', 'validDays', 'payment']);
  eq('허용 밖 키는 버린다', 'cost' in s({ ...full, cost: 1, breakdown: {} }), false);
  eq('null·배열·문자열 입력 → 빈 칸 + 오늘', [s(null), s([1]), s('x')].map((o) => [o.customer, o.date, o.validDays]),
    [['', TODAY, ''], ['', TODAY, ''], ['', TODAY, '']]);
  eq('객체·배열·null 값은 빈 문자열 · 숫자는 문자열', [s({ customer: { a: 1 } }).customer, s({ ref: ['a'] }).ref, s({ title: null }).title, s({ manager: 7 }).manager],
    ['', '', '', '7']);
  const long = '가'.repeat(300);
  const L = s({ customer: long, ref: long, title: long, delivery: long, payment: long, quoteNo: long, manager: long, contact: long });
  eq('길이 제한 200자', [L.customer, L.ref, L.title, L.delivery, L.payment].map((v) => v.length), [200, 200, 200, 200, 200]);
  eq('길이 제한 60자', [L.quoteNo, L.manager, L.contact].map((v) => v.length), [60, 60, 60]);
  eq('길이 경계 — 딱 200·60 은 그대로', [s({ customer: 'a'.repeat(200) }).customer.length, s({ quoteNo: 'a'.repeat(60) }).quoteNo.length], [200, 60]);
  eq('공백 제거 뒤 길이 제한', s({ customer: `  ${'a'.repeat(200)}  ` }).customer.length, 200);
  eq('날짜 형식이 아니면 오늘', ['2026/01/02', '2026-1-2', '', 'abc', '2026-02-30', '2026-13-01', 20260102].map((d) => s({ date: d }).date),
    Array(7).fill(TODAY));
  eq('윤년 2월 29일은 그대로', [s({ date: '2028-02-29' }).date, s({ date: '2026-02-29' }).date], ['2028-02-29', TODAY]);
  eq('유효 일수 경계', ['1', '365', '0', '366', '-1', '1.5', 'abc', '', ' 14 ', '014', 30, '1e2'].map((v) => s({ validDays: v }).validDays),
    ['1', '365', '', '', '', '', '', '', '14', '14', '30', '']);
}

// ── planInquirySync ──────────────────────────────────────────────────────────
{
  const P = (inquiry, t, confirm = false) => planInquirySync({ inquiry, total: t, confirm });
  eq('결제됨 → already_paid (확정 요청이어도)', [P({ paid_at: '2026-01-01' }, 1000, true), P({ paid_at: 'x', quoted_amount: 1000 }, 1000)],
    [{ error: 'already_paid' }, { error: 'already_paid' }]);
  eq('합계 이상값 → bad_total', [0, -1, NaN, Infinity, null, '1000', undefined].map((t) => P({}, t, true).error), Array(7).fill('bad_total'));
  eq('확정 요청 → 금액·KRW·quoted', P({ quoted_amount: null }, 1100, true), { update: { quoted_amount: 1100, quote_currency: 'KRW', status: 'quoted' } });
  eq('확정 요청 — USD 확정 건도 KRW 로 다시 확정', P({ quoted_amount: 50, quote_currency: 'USD' }, 1100, true),
    { update: { quoted_amount: 1100, quote_currency: 'KRW', status: 'quoted' } });
  eq('확정 + KRW → 확정 금액도 새 합계', P({ quoted_amount: 1000, quote_currency: 'KRW' }, 1100), { update: { quoted_amount: 1100 } });
  eq('확정 + 통화 비움·null·소문자 krw → 새 합계', [P({ quoted_amount: 1000, quote_currency: '' }, 1100), P({ quoted_amount: 1000, quote_currency: null }, 1100),
    P({ quoted_amount: 1000, quote_currency: 'krw' }, 1100)], Array(3).fill({ update: { quoted_amount: 1100 } }));
  eq('확정 + USD → 건드리지 않고 경고', P({ quoted_amount: 50, quote_currency: 'USD' }, 1100), { update: null, warning: 'usd_confirmed' });
  eq('미확정(금액 없음·0·음수·문자열) → 그대로', [null, 0, -5, '1000', undefined].map((q) => P({ quoted_amount: q, quote_currency: 'KRW' }, 1100)),
    Array(5).fill({ update: null }));
  eq('문의 null → 미확정 취급', P(null, 1100), { update: null });
  eq('confirm 은 true 만 확정(문자열 "true" 아님)', P({}, 1100, 'true'), { update: null });
}

// ── summarizeRevisions ───────────────────────────────────────────────────────
{
  const MAN = [{ code: 'measure', name: 'XPS' }, { code: 'samples' }];
  const rows = [
    { rev: 3, source: 'admin', kind: 'estimate', total: 3000, seen_total: null, manual_json: '[]', created_at: '2026-01-03T00:00:00.000Z' },
    { rev: 1, source: 'auto', kind: 'manual', total: null, seen_total: 1000, manual_json: JSON.stringify(MAN), created_at: '2026-01-01T00:00:00.000Z' },
    { rev: 2, source: 'admin', kind: 'estimate', total: 2000, seen_total: null, manual_json: null, created_at: '2026-01-02T00:00:00.000Z' },
  ];
  const r = summarizeRevisions(rows);
  eq('first = 가장 앞 auto', r.first, { rev: 1, source: 'auto', kind: 'manual', total: null, seenTotal: 1000, createdAt: '2026-01-01T00:00:00.000Z',
    manualAdmin: MAN.map(manualLabelAdmin) });
  eq('latest = 마지막 개정(입력 순서와 무관)', r.latest, { rev: 3, source: 'admin', kind: 'estimate', total: 3000, seenTotal: null,
    createdAt: '2026-01-03T00:00:00.000Z', manualAdmin: [] });
  eq('count', r.count, 3);
  eq('입력 배열은 바꾸지 않는다', rows.map((x) => x.rev), [3, 1, 2]);
  eq('빈·null·이상 입력', [summarizeRevisions([]), summarizeRevisions(null), summarizeRevisions('x')],
    Array(3).fill({ first: null, latest: null, count: 0 }));
  eq('auto 없음 → first null', summarizeRevisions([rows[0], rows[2]]).first, null);
  eq('auto 가 여럿이면 rev 가 가장 작은 것', summarizeRevisions([{ ...rows[1], rev: 4 }, { ...rows[1], rev: 2, seen_total: 7 }]).first.seenTotal, 7);
  eq('깨진 manual_json·객체 JSON → []', [summarizeRevisions([{ ...rows[1], manual_json: '{bad' }]).first.manualAdmin,
    summarizeRevisions([{ ...rows[1], manual_json: '{"a":1}' }]).first.manualAdmin], [[], []]);
  eq('rev 가 정수가 아닌 행·null 행은 버린다', summarizeRevisions([null, { rev: '2' }, { ...rows[2] }]).count, 1);
  eq('합계·seen 이 숫자가 아니면 null', summarizeRevisions([{ ...rows[0], total: '3000', seen_total: '1' }]).latest.total, null);
}

if (failed) {
  console.error(`\n관리자 견적 편집(quote-admin) 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 관리자 견적 편집(quote-admin) — ${total}건 통과`);
