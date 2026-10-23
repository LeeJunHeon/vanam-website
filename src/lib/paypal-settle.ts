// 결제 확정 공용 모듈.
//
// 결제가 확정되는 경로는 두 개다.
//   ① 브라우저 캡처 (/api/paypal/capture)  — 빠르다. 고객이 즉시 완료 화면을 본다.
//   ② PayPal 웹훅   (/api/paypal/webhook)  — 확실하다. 브라우저가 죽어도 도착한다.
// 두 경로가 각자 검증을 구현하면 한쪽이 느슨해지는 순간 방어가 뚫린다.
// 그래서 "검증 + DB 반영 + 알림"을 이 파일 하나로 모으고 양쪽이 호출만 한다.
//
// 이중 결제 방어(10-23):
//   ① 돈을 가져오기 전(precheckCapture) — 브라우저 캡처·웹훅 APPROVED 캡처가 같이 쓴다.
//      행 없음·결제 불가 상태 → not_payable · 이미 결제됨 → already_paid · 저장된 결제창 번호와 다름(다른 창에서 새로 만듦) → stale_order.
//      이 경우들은 캡처하지 않으므로 고객 돈이 빠지지 않는다.
//   ② 확정 때(settlePayment) — 이미 결제된 주문에 '다른' 결제(캡처 번호 → 결제창 번호 순으로 비교)가 들어오면
//      정상 중복이 아니라 이중 결제 의심 → 🚨 알림(DB 는 그대로).
//      비교 기준은 확정 때 남는 paypal_capture_id · paypal_order_id 다(create-order 는 결제된 주문을 막고, 저장도 'paid_at IS NULL' 조건부).
//   ③ '결제 완료' 알림은 조건부 UPDATE 가 실제로 1행을 바꾼 쪽만 보낸다(브라우저·웹훅 동시 도착 → 한 번).
import { notifyChat, expectedUsdStr, toCents } from './paypal';
import { readRate } from './fx';

type Row = Record<string, unknown>;
/** D1 run() 결과 — meta.changes = 실제로 바뀐 행 수 */
type RunResult = { meta?: { changes?: number } } | null | undefined | void;
type DBLike = {
  prepare: (sql: string) => {
    bind: (...a: unknown[]) => {
      first: <T = Row>() => Promise<T | null>;
      run: () => Promise<RunResult>;
    };
  };
};

export type SettleOk = { ok: true; ref: string; paidUsd: number; duplicate: boolean };
export type SettleErr = { ok: false; code: 'bad_ref' | 'not_found' | 'verify_failed' | 'duplicate_payment'; detail: string };
export type SettleResult = SettleOk | SettleErr;

export const isOrdRef = (ref: string) => /^ORD-\d{8}-[A-Z0-9]{4}$/.test(ref);
export const isInqRef = (ref: string) => /^INQ-\d{8}-[A-Z0-9]{4}$/.test(ref);

export type PrecheckCode = 'not_payable' | 'already_paid' | 'stale_order';
export type PrecheckResult =
  | { ok: true; ref: string; table: 'orders' | 'inquiries' }
  | { ok: false; code: PrecheckCode; ref: string };

/**
 * 캡처(돈 가져오기) 전 확인 — 브라우저 캡처(/api/paypal/capture)와 웹훅 APPROVED 캡처가 같이 쓴다. 돈을 가져오기 전에만 쓴다.
 * 순서: 행 없음 → not_payable · 이미 결제됨 → already_paid · 저장된 결제창 번호가 비었거나 다름 → stale_order
 *       · 결제 가능 상태 아님(create-order 와 같은 기준: ORD 'pending' · INQ 'quoted'/'replied') → not_payable.
 * 여기서 거절된 건은 모두 '돈이 빠지지 않은 상태'다 — 그래서 not_found·verify_failed(돈이 빠졌을 수 있음)는 쓰지 않는다.
 * ref 형식 검사는 부르는 쪽 몫이다(형식이 틀리면 여기서는 not_payable).
 */
export async function precheckCapture(d: DBLike, args: { ref: string; ppOrderId: string }): Promise<PrecheckResult> {
  const ref = String(args.ref || '').trim().toUpperCase();
  const pp = String(args.ppOrderId || '');
  const inq = isInqRef(ref);
  if (!inq && !isOrdRef(ref)) return { ok: false, code: 'not_payable', ref };
  const table = inq ? 'inquiries' : 'orders';
  const row = await d.prepare(`SELECT id, status, paid_at, paypal_order_id FROM ${table} WHERE id = ?`).bind(ref).first<Row>();
  if (!row) return { ok: false, code: 'not_payable', ref };
  if (row.paid_at) return { ok: false, code: 'already_paid', ref };
  const saved = String(row.paypal_order_id ?? '');
  if (!saved || saved !== pp) return { ok: false, code: 'stale_order', ref };
  const st = String(row.status ?? '');
  if (inq ? !['quoted', 'replied'].includes(st) : st !== 'pending') return { ok: false, code: 'not_payable', ref };
  return { ok: true, ref, table };
}

/**
 * 이미 확정된 주문에 들어온 결제가 확정 때와 '같은 결제'인가(웹훅 재전송·동시 도착).
 *   ① 캡처 번호가 양쪽에 있으면 그것으로 · ② 아니면 결제창 번호(둘 다 비어 있지 않을 때) · ③ 비교할 값이 없으면 같은 결제로 본다(거짓 경보 방지 — 경고 로그만)
 */
function sameAsSettled(row: Row, ref: string, ppOrderId: string, captureId?: string): boolean {
  const recCap = String(row.paypal_capture_id ?? '');
  const recPp = String(row.paypal_order_id ?? '');
  if (captureId && recCap) return captureId === recCap;
  if (ppOrderId && recPp) return ppOrderId === recPp;
  console.warn('[paypal] 이미 결제된 주문 — 비교할 결제 번호가 없어 정상 중복으로 처리:', ref);
  return true;
}

/** 이미 결제된 주문에 다른 결제가 들어옴 — DB 는 바꾸지 않고 알린다 */
async function duplicatePayment(ref: string, args: { ppOrderId: string; paidUsd: number; source: string; captureId?: string }): Promise<SettleErr> {
  const amt = Number.isFinite(args.paidUsd) ? args.paidUsd.toFixed(2) : String(args.paidUsd);
  console.error('[paypal] 이중 결제 의심:', ref, args.source, args.ppOrderId || '-', args.captureId || '-');
  await notifyChat(`🚨 [PayPal 이중 결제 의심] ${ref} — 이미 결제 완료된 주문에 다른 결제가 들어왔습니다 (paypal: ${args.ppOrderId || '-'}, capture: ${args.captureId || '-'}, $${amt} USD) · PayPal 에서 확인 후 환불해 주세요`);
  return { ok: false, code: 'duplicate_payment', detail: `pp=${args.ppOrderId || 'none'} cap=${args.captureId || 'none'}` };
}

/**
 * 결제 1건을 검증하고 확정한다.
 * - 검증 실패 시 DB 를 전혀 건드리지 않는다(돈이 들어왔을 수 있으므로 자동 환불도 하지 않는다).
 * - 이미 확정된 건: 확정 때와 같은 결제면 아무것도 하지 않고 duplicate 로(웹훅 재전송·동시 도착),
 *   다른 결제면 DB 는 그대로 두고 이중 결제 의심 알림 + duplicate_payment.
 * - '결제 완료' 알림은 조건부 UPDATE 가 실제로 1행을 바꿨을 때만 보낸다.
 */
export async function settlePayment(
  d: DBLike,
  args: { ref: string; ppOrderId: string; paidUsd: number; paidCur: string; source: 'browser' | 'webhook'; captureId?: string },
): Promise<SettleResult> {
  const ref = String(args.ref || '').toUpperCase();
  const inq = isInqRef(ref);
  if (!inq && !isOrdRef(ref)) return { ok: false, code: 'bad_ref', detail: `ref=${ref || 'none'}` };

  const table = inq ? 'inquiries' : 'orders';
  const row = await d.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(ref).first<Row>();
  if (!row) {
    console.error('[paypal] 확정 대상 없음:', ref, args.ppOrderId, args.source);
    await notifyChat(`🚨 [PayPal 검증실패] ${ref} — 주문/견적 없음 (paypal: ${args.ppOrderId}) · 수동 확인 필요`);
    return { ok: false, code: 'not_found', detail: ref };
  }

  // 이미 확정된 건 — 같은 결제면 멱등(DB·알림 없음), 다른 결제면 이중 결제 의심
  if (row.paid_at) {
    if (sameAsSettled(row, ref, args.ppOrderId, args.captureId)) return { ok: true, ref, paidUsd: Number(row.paid_usd ?? args.paidUsd), duplicate: true };
    return duplicatePayment(ref, args);
  }

  // ── 검증: PayPal 이 알려준 금액을 믿지 않고, 서버가 DB 에서 다시 계산해 대조한다 ──
  const bad: string[] = [];
  const savedPp = String(row.paypal_order_id ?? '');
  if (!savedPp || savedPp !== args.ppOrderId) {
    bad.push(`order_id(db=${savedPp || 'none'} req=${args.ppOrderId})`);
  }
  if (args.paidCur !== 'USD') bad.push(`currency=${args.paidCur || 'none'}`);
  // 대조 기준 환율은 저장된 값을 그대로 읽는다(여기서 갱신하지 않는다 — 결제 도중 기준이 바뀌면 안 된다).
  const fx = await readRate(d as unknown as import('./db').D1);
  const exp = expectedUsdStr(inq ? 'inq' : 'ord', row, fx.rate);
  if (!exp) bad.push('amount_unavailable');
  else if (Math.abs(toCents(exp) - toCents(args.paidUsd)) > 1) {
    bad.push(`amount(exp=${exp} paid=${args.paidUsd})`);
  }

  if (bad.length) {
    console.error('[paypal] 결제 검증 실패:', ref, args.source, bad.join(' / '));
    await notifyChat(`🚨 [PayPal 검증실패] ${ref} — ${bad.join(' / ')} · 자동 처리 중단, 수동 확인 필요`);
    return { ok: false, code: 'verify_failed', detail: bad.join(' / ') };
  }

  // 조건부 UPDATE — 두 경로가 동시에 도착해도 먼저 도착한 쪽만 반영된다.
  const now = new Date().toISOString();
  const res = await d
    .prepare(`UPDATE ${table} SET status = 'paid', paid_at = ?, paid_usd = ?, paypal_capture_id = ? WHERE id = ? AND paid_at IS NULL`)
    .bind(now, args.paidUsd, args.captureId ?? null, ref)
    .run();
  // 실제로 바뀐 행 수 — 0 이면 다른 경로가 먼저 확정했다: 알림 없이 다시 읽어 같은 결제인지 가린다.
  // meta 를 못 읽는 환경이면 지금까지처럼 알림을 보낸다(알림이 빠지는 쪽보다 두 번 가는 쪽이 낫다).
  const changes = (res as { meta?: { changes?: number } } | null | undefined)?.meta?.changes;
  if (changes === 0) {
    const cur = await d.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(ref).first<Row>();
    if (!cur || sameAsSettled(cur, ref, args.ppOrderId, args.captureId)) {
      return { ok: true, ref, paidUsd: Number(cur?.paid_usd ?? args.paidUsd), duplicate: true };
    }
    return duplicatePayment(ref, args);
  }

  // 결제가 확정된 지금이 알릴 시점이다(주문 접수 시점에는 알리지 않는다 —
  // PayPal 을 고르고 결제하지 않는 경우가 많아 소음이 된다).
  // 주문 접수 때 저장해 둔 상세를 그대로 붙여 담당자가 한 번에 파악하게 한다.
  const head = `💳 *결제 완료* — $${args.paidUsd.toFixed(2)} USD (paypal: ${args.ppOrderId})`;
  const detail = String(row.chat_detail ?? '').trim();
  await notifyChat(detail ? `${head}\n${detail}` : `${head}\n주문번호: ${ref}`);
  return { ok: true, ref, paidUsd: args.paidUsd, duplicate: false };
}
