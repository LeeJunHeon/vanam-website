// 결제 확정 공용 모듈.
//
// 결제가 확정되는 경로는 두 개다.
//   ① 브라우저 캡처 (/api/paypal/capture)  — 빠르다. 고객이 즉시 완료 화면을 본다.
//   ② PayPal 웹훅   (/api/paypal/webhook)  — 확실하다. 브라우저가 죽어도 도착한다.
// 두 경로가 각자 검증을 구현하면 한쪽이 느슨해지는 순간 방어가 뚫린다.
// 그래서 "검증 + DB 반영 + 알림"을 이 파일 하나로 모으고 양쪽이 호출만 한다.
import { notifyChat, expectedUsdStr, toCents } from './paypal';
import { readRate } from './fx';

type Row = Record<string, unknown>;
type DBLike = {
  prepare: (sql: string) => {
    bind: (...a: unknown[]) => {
      first: <T = Row>() => Promise<T | null>;
      run: () => Promise<unknown>;
    };
  };
};

export type SettleOk = { ok: true; ref: string; paidUsd: number; duplicate: boolean };
export type SettleErr = { ok: false; code: 'bad_ref' | 'not_found' | 'verify_failed'; detail: string };
export type SettleResult = SettleOk | SettleErr;

export const isOrdRef = (ref: string) => /^ORD-\d{8}-[A-Z0-9]{4}$/.test(ref);
export const isInqRef = (ref: string) => /^INQ-\d{8}-[A-Z0-9]{4}$/.test(ref);

/**
 * 결제 1건을 검증하고 확정한다.
 * - 검증 실패 시 DB 를 전혀 건드리지 않는다(돈이 들어왔을 수 있으므로 자동 환불도 하지 않는다).
 * - 이미 확정된 건은 아무것도 하지 않고 duplicate 로 돌려준다(웹훅 재전송·동시 도착 방어).
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

  // 멱등: 이미 확정된 건은 DB 도 알림도 다시 건드리지 않는다.
  if (row.paid_at) {
    return { ok: true, ref, paidUsd: Number(row.paid_usd ?? args.paidUsd), duplicate: true };
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
  if (inq) {
    await d
      .prepare(`UPDATE inquiries SET paid_at = ?, paid_usd = ?, paypal_capture_id = ? WHERE id = ? AND paid_at IS NULL`)
      .bind(now, args.paidUsd, args.captureId ?? null, ref)
      .run();
  } else {
    await d
      .prepare(`UPDATE orders SET status = 'paid', paid_at = ?, paid_usd = ?, paypal_capture_id = ? WHERE id = ? AND paid_at IS NULL`)
      .bind(now, args.paidUsd, args.captureId ?? null, ref)
      .run();
  }

  // 어느 경로로 확정됐는지 남긴다 — 문제 추적 시 결정적인 단서가 된다.
  const via = args.source === 'webhook' ? ' · 웹훅 확정' : '';
  await notifyChat(`💳 [PayPal 결제완료] ${ref} — $${args.paidUsd.toFixed(2)} USD (paypal: ${args.ppOrderId})${via}`);
  return { ok: true, ref, paidUsd: args.paidUsd, duplicate: false };
}
