// scripts/test-paypal-capture.mjs — PayPal 이중 결제 방어 테스트(캡처 전 확인 · 이중 결제 의심 · 결제 완료 알림 1회)
//
// 실제 라우트(api/paypal/create-order · capture · webhook)와 lib/paypal · lib/paypal-settle 을 esbuild 로 묶어 그대로 돌린다.
//   가짜: PayPal(전역 fetch — 토큰·결제창 만들기·캡처·웹훅 서명 확인) · D1(주문 표 한 개, 바뀐 행 수 meta.changes 포함)
//         · 구글챗(chat-send — 보낸 글만 모은다) · 환율(fx) · 요청 횟수 제한(rate-limit) · cloudflare:workers(env)
// 확인: 정상 1회 · 탭 두 개(오래된 결제창) · 결제 끝난 뒤 다른 창 · 캡처 뒤 확정 틈(이중 결제 의심) · 웹훅 재전송 ·
//       브라우저·웹훅 동시 도착 · 금액·통화 불일치 · 확정 뒤 결제창 번호를 덮어쓰지 않음(create-order)
// 네트워크·비밀값 없이 돈다. 주문은 가짜.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let total = 0, failed = 0;
const report = console.error.bind(console); // 라우트 로그를 숨기는 동안에도 실패는 보이게
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    report(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}

// ── 가짜 모듈 ───────────────────────────────────────────────────────────────────
const STUBS = [
  [/^cloudflare:workers$/, `export const env = { PAYPAL_CLIENT_ID: 'cid', PAYPAL_SECRET: 'sec', PAYPAL_ENV: 'sandbox', PAYPAL_WEBHOOK_ID: 'wh' };`],
  [/\/lib\/db$/, `export async function db() { return globalThis.__pp.db; }`],
  [/\/lib\/rate-limit$/, `export async function rateLimit() { return { ok: true }; }
    export function tooMany() { return new Response('{}', { status: 429 }); }`],
  [/(^|\/)fx$/, `const R = { rate: 1400, updatedAt: null, source: 'test', mode: 'manual' };
    export async function readRate() { return R; } export async function getRate() { return R; } export const pickWaitUntil = () => undefined;`],
  [/(^|\/)chat-send$/, `export async function sendChat(text) { globalThis.__pp.chats.push(text); return { sent: false }; }`],
];
const ROUTES = ['create-order', 'capture', 'webhook'].map((n) => resolve(`src/pages/api/paypal/${n}.ts`));

/** 라우트를 묶어 불러온다 — 원본 파일 그대로(바꿔 끼운 내용이 있으면 overrides 로) */
async function loadRoutes() {
  const dir = mkdtempSync(join(tmpdir(), 'pp-capture-'));
  try {
    const out = join(dir, 'routes.mjs');
    await build({
      stdin: {
        contents: ROUTES.map((p, i) => `export { POST as r${i} } from ${JSON.stringify(p)};`).join('\n'),
        resolveDir: process.cwd(), loader: 'ts',
      },
      bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
      define: { 'import.meta.env': 'globalThis.__metaEnv' },
      plugins: [{
        name: 'stubs',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) => {
            const hit = STUBS.findIndex(([re]) => re.test(a.path));
            return hit >= 0 ? { path: String(hit), namespace: 'stub' } : undefined;
          });
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[Number(a.path)][1], loader: 'js' }));
        },
      }],
    });
    globalThis.__metaEnv = {};
    const m = await import(pathToFileURL(out).href);
    return { createOrder: m.r0, capture: m.r1, webhook: m.r2 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const R = await loadRoutes();

// ── 가짜 D1 — orders 한 표. 쓰는 SQL 만 안다(모르는 SQL 은 오류 — 새 쿼리가 생기면 시험이 알려준다) ─────────
const REF = 'ORD-20261023-TEST';
const tick = () => new Promise((r) => setTimeout(r, 0)); // 동시 도착이 실제로 엇갈리게
function fakeDb() {
  const rows = new Map([[REF, { id: REF, status: 'pending', amount: 140000, amount_usd: 100, currency: 'KRW', buyer_email: 'a@example.com',
    paid_at: null, paid_usd: null, paypal_order_id: null, paypal_capture_id: null, chat_detail: '' }]]);
  const log = { paidUpdates: 0, ppWrites: 0 };
  const pick = (r, cols) => (r ? (cols === '*' ? { ...r } : Object.fromEntries(cols.split(',').map((c) => c.trim()).map((c) => [c, r[c]]))) : null);
  const db = {
    rows, log,
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim();
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() {
          await tick();
          let m;
          if ((m = /^SELECT (.+) FROM (orders|inquiries) WHERE id = \?$/.exec(q))) return m[2] === 'orders' ? pick(rows.get(args[0]), m[1]) : null;
          if ((m = /^SELECT (.+) FROM (orders|inquiries) WHERE paypal_order_id = \?$/.exec(q))) {
            return m[2] === 'orders' ? pick([...rows.values()].find((r) => r.paypal_order_id === args[0]), m[1]) : null;
          }
          throw new Error(`fake D1: 모르는 SQL — ${q}`);
        },
        async run() {
          await tick();
          let r;
          if (/^UPDATE orders SET paypal_order_id = \? WHERE id = \? AND paid_at IS NULL$/.test(q)) {
            r = rows.get(args[1]);
            if (!r || r.paid_at) return { meta: { changes: 0 } };
            r.paypal_order_id = args[0]; log.ppWrites++;
            return { meta: { changes: 1 } };
          }
          if (/^UPDATE orders SET status = 'paid', paid_at = \?, paid_usd = \?, paypal_capture_id = \? WHERE id = \? AND paid_at IS NULL AND paypal_order_id = \?$/.test(q)) {
            r = rows.get(args[3]);
            if (!r || r.paid_at || r.paypal_order_id !== args[4]) return { meta: { changes: 0 } };
            Object.assign(r, { status: 'paid', paid_at: args[0], paid_usd: args[1], paypal_capture_id: args[2] }); log.paidUpdates++;
            return { meta: { changes: 1 } };
          }
          throw new Error(`fake D1: 모르는 SQL — ${q}`);
        },
      };
      return stmt;
    },
  };
  return db;
}

// ── 가짜 PayPal(fetch) ─────────────────────────────────────────────────────────
function fakePayPal() {
  const pp = { n: 0, orders: new Map(), captureCalls: 0, captured: 0, onCapture: null, captureAmount: null, captureCurrency: null };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.endsWith('/v1/oauth2/token')) return reply(200, { access_token: 'tok' });
    if (u.endsWith('/v1/notifications/verify-webhook-signature')) return reply(200, { verification_status: 'SUCCESS' });
    if (u.endsWith('/v2/checkout/orders')) {
      const b = JSON.parse(init.body);
      const id = `PP${++pp.n}`;
      pp.orders.set(id, { ref: b.purchase_units[0].custom_id, value: b.purchase_units[0].amount.value, captured: false });
      if (pp.onCreate) { const h = pp.onCreate; pp.onCreate = null; await h(id); }
      return reply(201, { id });
    }
    const m = /\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(u);
    if (m) {
      pp.captureCalls++;
      const o = pp.orders.get(decodeURIComponent(m[1]));
      if (!o) return reply(404, { name: 'RESOURCE_NOT_FOUND' });
      if (o.captured) return reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
      o.captured = true; pp.captured++;
      if (pp.onCapture) { const h = pp.onCapture; pp.onCapture = null; await h(); }
      const id = decodeURIComponent(m[1]);
      return reply(201, { id, status: 'COMPLETED', purchase_units: [{ reference_id: o.ref, payments: { captures: [{
        id: `CAP-${id}`, status: 'COMPLETED', custom_id: o.ref,
        amount: { value: pp.captureAmount ?? o.value, currency_code: pp.captureCurrency ?? 'USD' } }] } }] });
    }
    throw new Error(`fake PayPal: 모르는 주소 ${u}`);
  };
  return pp;
}

// ── 한 장면 준비 · 부르기 ───────────────────────────────────────────────────────
function scene() {
  globalThis.__pp = { db: fakeDb(), chats: [] };
  const pp = fakePayPal();
  const post = async (route, body, headers = {}) => {
    const request = new Request('https://vanam.co.kr/api/paypal/x', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const res = await route({ request, locals: {} });
    return { status: res.status, ...(await res.json()) };
  };
  const create = () => post(R.createOrder, { ref: REF });
  const capture = (orderID, ref = REF) => post(R.capture, ref ? { orderID, ref } : { orderID });
  const hook = (event) => post(R.webhook, event, { 'paypal-transmission-id': 't1', 'paypal-transmission-sig': 's1' });
  const completedEvent = (orderID, captureId = `CAP-${orderID}`, value = '100.00') => ({ event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: captureId, custom_id: REF, amount: { value, currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: orderID } } } });
  const approvedEvent = (orderID) => ({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderID, purchase_units: [{ custom_id: REF }] } });
  const st = globalThis.__pp;
  const chats = (kind) => st.chats.filter((t) => t.includes(kind)).length;
  const row = () => ({ ...st.db.rows.get(REF) });
  return { pp, st, create, capture, hook, completedEvent, approvedEvent, chats, row };
}
const PAID = '💳 *결제 완료*'; // 알림 머리 — 이중 결제 알림의 '이미 결제 완료된'과 구분
const DUP = '이중 결제 의심';
const BAD = '검증실패';
// 라우트의 경고 로그는 숨긴다(결과는 응답·호출 수로 본다)
const quiet = async (fn) => {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, warn, error }); }
};

await quiet(async () => {
  // ① 정상 1회 결제
  {
    const s = scene();
    const a = await s.create();
    const c = await s.capture(a.id);
    eq('정상: 캡처 성공 응답', [c.status, c.ok, c.duplicate, c.paidUsd], [200, true, false, 100]);
    eq('정상: 캡처 1번 · 확정 1번 · 결제 완료 알림 1번 · 🚨 0', [s.pp.captureCalls, s.st.db.log.paidUpdates, s.chats(PAID), s.chats('🚨')], [1, 1, 1, 0]);
    eq('정상: DB 결제창·캡처 번호', [s.row().paypal_order_id, s.row().paypal_capture_id, s.row().status], [a.id, `CAP-${a.id}`, 'paid']);
  }

  // ② 탭 두 개(A 만든 뒤 B 만듦) → A 로 결제 시도: 캡처하지 않는다
  {
    const s = scene();
    const a = await s.create();
    const b = await s.create();
    const c = await s.capture(a.id);
    eq('탭 두 개: A 로 결제 → 409 stale_order', [c.status, c.error], [409, 'stale_order']);
    eq('탭 두 개: 캡처 0번 · 확정 0 · 알림 0', [s.pp.captureCalls, s.st.db.log.paidUpdates, s.st.chats.length], [0, 0, 0]);
    eq('탭 두 개: 저장된 결제창은 B · 아직 미결제', [s.row().paypal_order_id, s.row().paid_at], [b.id, null]);
    // ref 없이 온 옛 요청도 캡처하지 않는다(결제창 번호로 못 찾음 → not_found)
    const c2 = await s.capture(a.id, null);
    eq('탭 두 개: ref 없는 A 요청 → 404 not_found · 캡처 0', [c2.status, c2.error, s.pp.captureCalls], [404, 'not_found', 0]);
    // 웹훅 APPROVED(A)도 같은 사전 확인 — 캡처하지 않는다
    const h = await s.hook(s.approvedEvent(a.id));
    eq('탭 두 개: 웹훅 APPROVED(A) → 캡처 안 함(stale_order)', [h.status, h.skipped, s.pp.captureCalls], [200, 'stale_order', 0]);
  }

  // ③ B 로 결제 완료 뒤 A 로 결제 시도
  {
    const s = scene();
    const a = await s.create();
    const b = await s.create();
    const cb = await s.capture(b.id);
    const ca = await s.capture(a.id);
    eq('B 결제 뒤 A: B 성공 · A 409 already_paid', [cb.ok, ca.status, ca.error], [true, 409, 'already_paid']);
    eq('B 결제 뒤 A: 캡처 1번(B 만) · 확정 1 · 결제 완료 1 · 🚨 0', [s.pp.captureCalls, s.st.db.log.paidUpdates, s.chats(PAID), s.chats('🚨')], [1, 1, 1, 0]);
    eq('B 결제 뒤 A: DB 는 B 그대로', [s.row().paypal_order_id, s.row().paypal_capture_id], [b.id, `CAP-${b.id}`]);
  }

  // ④ 캡처는 됐는데 settle 시점에 이미 다른 결제창으로 확정됨(사전 확인과 확정 사이의 틈)
  {
    const s = scene();
    const a = await s.create();
    let b = null;
    // A 를 캡처하는 동안(PayPal 응답 전) 다른 창에서 B 를 만들어 결제까지 끝낸다
    s.pp.onCapture = async () => { b = await s.create(); await s.capture(b.id); };
    const ca = await s.capture(a.id);
    eq('틈: A → 409 duplicate_payment', [ca.status, ca.error], [409, 'duplicate_payment']);
    eq('틈: 🚨 이중 결제 의심 1번 · 결제 완료 1번(B) · 확정 1번', [s.chats(DUP), s.chats(PAID), s.st.db.log.paidUpdates], [1, 1, 1]);
    eq('틈: DB 는 B 확정 그대로(A 로 바꾸지 않음)', [s.row().paypal_order_id, s.row().paypal_capture_id, s.row().paid_usd], [b?.id, `CAP-${b?.id}`, 100]);
    const msg = s.st.chats.find((t) => t.includes(DUP)) ?? '';
    eq('틈: 알림 글 — 주문번호 · 결제창 · 금액 · 환불 확인', [msg.includes(REF), msg.includes(a.id), msg.includes('$100.00 USD'), msg.includes('PayPal 에서 환불 여부 확인 필요')], [true, true, true, true]);
  }

  // ⑤ 같은 결제창 웹훅 재전송 · 확정 뒤 APPROVED
  {
    const s = scene();
    const a = await s.create();
    await s.capture(a.id);
    const before = s.st.chats.length;
    const h1 = await s.hook(s.completedEvent(a.id));
    const h2 = await s.hook(s.completedEvent(a.id));
    const h3 = await s.hook(s.approvedEvent(a.id));
    eq('재전송: COMPLETED 두 번 ok · APPROVED 는 already_paid 로 건너뜀', [h1.ok, h2.ok, h3.skipped], [true, true, 'already_paid']);
    eq('재전송: 알림 0번 추가 · 확정 1번 그대로 · 캡처 1번 그대로', [s.st.chats.length - before, s.st.db.log.paidUpdates, s.pp.captureCalls], [0, 1, 1]);
    // 같은 결제창인데 캡처 번호가 다르면 정상 중복이 아니다
    const h4 = await s.hook(s.completedEvent(a.id, 'CAP-OTHER'));
    eq('재전송: 캡처 번호가 다르면 이중 결제 의심', [h4.ok, s.chats(DUP)], [false, 1]);
    // 결제창 번호 없이 온 웹훅 — 캡처 번호가 같으면 정상 중복
    const h5 = await s.hook({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: `CAP-${a.id}`, custom_id: REF, amount: { value: '100.00', currency_code: 'USD' } } });
    eq('재전송: 결제창 번호 없음 + 같은 캡처 번호 → 정상 중복', [h5.ok, s.chats(DUP)], [true, 1]);
  }

  // ⑥ 브라우저·웹훅 동시 도착(같은 결제창)
  {
    const s = scene();
    const a = await s.create();
    // 브라우저 캡처와 PAYMENT.CAPTURE.COMPLETED 웹훅이 거의 같이 확정을 시도
    const [c, h] = await Promise.all([s.capture(a.id), s.hook(s.completedEvent(a.id))]);
    eq('동시(캡처+COMPLETED): 둘 다 ok', [c.ok, h.ok], [true, true]);
    eq('동시(캡처+COMPLETED): DB 반영 1번 · 결제 완료 알림 1번 · 🚨 0', [s.st.db.log.paidUpdates, s.chats(PAID), s.chats('🚨')], [1, 1, 0]);
  }
  {
    const s = scene();
    const a = await s.create();
    // 브라우저 캡처와 웹훅 APPROVED(서버 대신 캡처)가 같이 — PayPal 은 한 번만 캡처한다(두 번째는 ORDER_ALREADY_CAPTURED)
    const [c, h] = await Promise.all([s.capture(a.id), s.hook(s.approvedEvent(a.id))]);
    eq('동시(캡처+APPROVED): 실제 캡처 1번 · DB 반영 1번 · 결제 완료 알림 1번 · 🚨 0',
      [s.pp.captured, s.st.db.log.paidUpdates, s.chats(PAID), s.chats('🚨'), c.ok || h.ok], [1, 1, 1, 0, true]);
  }

  // ⑦ 금액·통화 불일치 — 지금처럼 verify_failed
  for (const [label, amt, cur] of [['금액', '99.00', null], ['통화', null, 'EUR']]) {
    const s = scene();
    const a = await s.create();
    s.pp.captureAmount = amt; s.pp.captureCurrency = cur;
    const c = await s.capture(a.id);
    eq(`${label} 불일치: 409 verify_failed · 🚨 검증실패 1 · 결제 완료 0 · DB 그대로`,
      [c.status, c.error, s.chats(BAD), s.chats(PAID), s.row().paid_at, s.st.db.log.paidUpdates], [409, 'verify_failed', 1, 0, null, 0]);
  }

  // ⑧ 확정 뒤 결제창 번호를 덮어쓰지 않는다(이중 결제 판정 기준 — (a) 고정)
  {
    const s = scene();
    const a = await s.create();
    await s.capture(a.id);
    const again = await s.create();
    eq('확정 뒤 create-order → 409 already_paid · 결제창 번호 그대로', [again.status, again.error, s.row().paypal_order_id], [409, 'already_paid', a.id]);
  }
  {
    const s = scene();
    const a = await s.create();
    // create-order 가 PayPal 에 결제창을 만드는 사이에 A 가 확정됨 → 저장은 조건부라 덮어쓰지 않는다
    s.pp.onCreate = async () => { await s.capture(a.id); };
    const late = await s.create();
    eq('결제창 만드는 중 확정됨 → already_paid · 결제창 번호 A 그대로', [late.status, late.error, s.row().paypal_order_id, s.st.db.log.paidUpdates], [409, 'already_paid', a.id, 1]);
  }

  // ⑨ 주문서 없음 — 캡처하지 않는다
  {
    const s = scene();
    const c = await s.capture('PP999', 'ORD-20261023-NONE');
    eq('주문서 없음: 404 not_found · 캡처 0', [c.status, c.error, s.pp.captureCalls], [404, 'not_found', 0]);
  }
});

if (failed) {
  console.error(`\nPayPal 이중 결제 방어 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ PayPal 이중 결제 방어(capture·webhook·settle) — ${total}건 통과 · 캡처 전 확인(이미 결제·오래된 결제창) · 이중 결제 의심 알림 · 결제 완료 알림 1회`);
