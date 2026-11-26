// 담당자 알림 메일 — 결과 기록(inquiries.staff_mail) · 관리자 화면 한 줄 · 저장된 접수 행으로 메일 내용 다시 만들기(순수 함수).
//
// 무엇: 담당자 알림 메일은 접수 순간에 한 번 시도한다. 그 결과를 접수 행에 남기고, 관리자 화면에서 다시 보낼 수 있게 한다
//   (11-26: 구글 토큰 서버가 응답하지 않아 알림 메일이 실패했는데, 결과가 DB 에 없고 다시 보낼 방법도 없었다).
//   기록 모양·규칙은 접수 확인 메일(quote-ack.js 의 ackRecord · isFreshPending · ackLabel)과 같다 —
//   status(sent | failed | skipped | pending) · reason · by(auto | admin) · at · n · sentAt · sentN.
//   '보내는 중' 기록 → 결과 기록 순서라, 중간에 끊기면 관리자 화면에 '중단됨'으로 보인다.
// 부르는 곳: 실행부 staff-notify-run.ts(기록 쓰기) · 관리자 화면(결과 한 줄) · api/admin/staff-mail.ts(행 → 메일 입력).
//
// ⚠️ .js 이고 화면·네트워크·DB 를 만지지 않는다 — node 테스트(scripts/test-staff-notify.mjs)가 빌드 없이 확인한다.
//    제목·본문 조립과 발송 판정은 staff-notify.js 의 것을 그대로 쓴다(여기서 다시 만들지 않는다).
// ⚠️ 받는 주소·본문·고객 정보를 기록에 넣지 않는다(결과와 사유만).
import { staffNotifyFlow } from './staff-notify.js';
import { parseAck, isFreshPending, kstText, ACK_REASON_KO } from './quote-ack.js';
import { materialLabels } from './material-value.js';
import { buildEstimateChatLine } from './chat-message.js';
import { summarizeRevisions } from './quote-admin.js';

const str = (v) => (v == null ? '' : String(v).trim());

// ── 결과 기록 ─────────────────────────────────────────────────────────────────────

/**
 * 보내지 않고 끝난 사유 — '안 보냄'(skipped)으로 남긴다: 받는 주소 미설정 · 테스트 빌드 · 운영 주소가 아닌 곳 · Gmail 설정 없음.
 * 그 밖은 '실패'(failed) — 받는 주소 모양이 틀린 것(bad_config · bad_recipient)도 고쳐야 할 설정이라 실패로 보인다.
 */
export const STAFF_SKIP_REASONS = ['disabled', 'blocked_build', 'blocked_host', 'no_credentials'];

/**
 * 발송 판정 결과(staffNotifyFlow) → 기록할 상태.
 * @param {{ sent: boolean, reason: string }} r
 * @returns {{ status: 'sent' | 'failed' | 'skipped', reason: string | null }}
 */
export function staffStatusOf(r) {
  if (r?.sent) return { status: 'sent', reason: null };
  const reason = str(r?.reason) || 'error';
  return { status: STAFF_SKIP_REASONS.includes(reason) ? 'skipped' : 'failed', reason };
}

/** 기록 읽기 — 깨졌거나 없으면 null(옛 접수 건) @param {unknown} raw */
export const parseStaffMail = parseAck;

/** '보내는 중' 기록이 아직 살아 있는가(2분 — 확인 메일과 같은 기준) @param {unknown} raw @param {number} [now] */
export const isStaffPending = isFreshPending;

/**
 * 새 기록(JSON 문자열).
 *   n = 끝난 시도 횟수(다시 보내기 포함 · '보내는 중'은 세지 않음)
 *   sentAt·sentN = 마지막으로 보낸 시각·보낸 횟수 — 나중 시도가 실패해도 '이미 보냈다'는 사실을 잃지 않는다
 * @param {unknown} prevRaw 이전 기록
 * @param {{ status: 'sent'|'failed'|'skipped'|'pending', reason?: string|null, by: 'auto'|'admin', at: string }} r
 */
export function staffRecord(prevRaw, r) {
  const prev = parseStaffMail(prevRaw);
  const sent = r.status === 'sent';
  return JSON.stringify({
    status: r.status, reason: r.reason ?? null,
    by: r.by, at: r.at,
    n: (Number(prev?.n) || 0) + (r.status === 'pending' ? 0 : 1),
    sentAt: sent ? r.at : (typeof prev?.sentAt === 'string' ? prev.sentAt : null),
    sentN: (Number(prev?.sentN) || 0) + (sent ? 1 : 0),
  });
}

/** 실패·건너뜀 사유 → 관리자용 한글. 메일 공통 사유는 확인 메일 것을 쓰고, 담당자 메일 전용 사유를 더한다. */
export const STAFF_REASON_KO = Object.freeze({
  ...ACK_REASON_KO,
  disabled: '받는 주소(INQUIRY_NOTIFY_TO) 미설정',
  bad_config: '받는 주소 모양이 이상함',
  blocked_build: '테스트 빌드라 보내지 않음',
});

/**
 * 관리자 카드 한 줄(확인 메일 줄과 같은 말투·색). 기록이 없으면 null(이 기능 전에 접수된 건).
 * @param {unknown} raw inquiries.staff_mail @param {number} [now] '보내는 중'이 오래됐는지 볼 기준 시각
 * @returns {{ tone: 'ok'|'bad'|'muted', text: string } | null}
 */
export function staffMailLabel(raw, now = Date.now()) {
  const a = parseStaffMail(raw);
  if (!a) return null;
  const when = kstText(a.at);
  // 나중 시도가 실패·중단돼도 앞서 보낸 사실은 같이 적는다
  const before = a.status !== 'sent' && typeof a.sentAt === 'string' && kstText(a.sentAt) ? ` (앞서 ${kstText(a.sentAt)} 에 보냄)` : '';
  if (a.status === 'sent') {
    // '다시 보냄' = 관리자가 눌러 보냈고 그 전에 끝난 시도가 있었다(기록 없는 옛 접수 건의 첫 발송에는 붙이지 않는다)
    const again = a.by === 'admin' && Number(a.n) > 1;
    return { tone: 'ok', text: ['담당자 메일: 보냄', when].filter(Boolean).join(' · ') + (again ? ' · 다시 보냄' : '') };
  }
  if (a.status === 'pending') {
    return isStaffPending(raw, now)
      ? { tone: 'muted', text: '담당자 메일: 보내는 중…' }
      : { tone: 'bad', text: `담당자 메일: 중단됨 — 처리 시간 안에 끝나지 못했습니다. 다시 보내 주세요${before}` };
  }
  const why = STAFF_REASON_KO[a.reason] ?? (str(a.reason) || STAFF_REASON_KO.error);
  if (a.status === 'failed') return { tone: 'bad', text: `담당자 메일: 실패 — ${why}${when ? ` · ${when}` : ''}${before}` };
  return { tone: 'muted', text: `담당자 메일: 안 보냄 — ${why}${before}` };
}

/** 보낸 적이 있는가 — 버튼 글자([담당자 메일 보내기] / [… 다시 보내기])를 가른다 @param {unknown} raw */
export function staffSentBefore(raw) {
  const a = parseStaffMail(raw);
  return Boolean(a && (Number(a.sentN) > 0 || typeof a.sentAt === 'string'));
}

/**
 * 담당자 알림 한 건 — 발송 판정(staffNotifyFlow) + 결과 기록. 예외를 던지지 않는다.
 *   순서: (보낼 수 있으면) '보내는 중' 기록 → 발송 → 결과 기록. 보내지 않고 끝나는 건(주소 미설정·테스트 빌드 등)은 결과만 한 번.
 *         → 기록 쓰기는 접수 한 건에 많아야 2번.
 *   구글챗 실패 알림은 접수 직후 자동 발송(by 'auto')에만 — 관리자가 누른 발송은 화면에 결과가 나오므로 알리지 않는다.
 *   write 가 없으면(접수 행이 DB 에 저장되지 않은 접수) 기록을 생략한다. 기록 실패는 발송 결과에 영향을 주지 않는다.
 * @param {{
 *   by: 'auto' | 'admin', prev?: unknown, now: () => string,
 *   write?: ((json: string) => Promise<unknown>) | null,
 *   live: boolean, id: string, readTo: () => string, isSafeAddress: (a: unknown) => boolean,
 *   send: (to: string) => Promise<{ sent: boolean, reason: string }>, alert: (text: string) => Promise<unknown>,
 * }} d
 * @returns {Promise<{ sent: boolean, reason: string, status: 'sent' | 'failed' | 'skipped' }>}
 */
export async function staffNotifyRecorded(d) {
  const by = d.by === 'admin' ? 'admin' : 'auto';
  const prev = d.prev ?? null;
  const put = async (r) => {
    if (typeof d.write !== 'function') return;
    try {
      await d.write(staffRecord(prev, { ...r, by, at: d.now() }));
    } catch {
      /* 기록 실패는 삼킨다 — 로그는 호출부(write)가 접수번호만 남긴다 */
    }
  };
  let r;
  try {
    r = await staffNotifyFlow({
      live: d.live, id: d.id, readTo: d.readTo, isSafeAddress: d.isSafeAddress,
      send: async (to) => {
        await put({ status: 'pending' });
        return d.send(to);
      },
      alert: by === 'auto' ? d.alert : async () => undefined,
    });
  } catch {
    r = { sent: false, reason: 'error' };
  }
  const s = staffStatusOf(r);
  await put(s);
  return { sent: Boolean(r.sent), reason: String(r.reason ?? 'error'), status: s.status };
}

// ── 저장된 접수 행 → 담당자 메일 입력 ─────────────────────────────────────────────

const parseJson = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
};

/**
 * 웨이퍼 문의 한 줄 — 접수 때(api/inquiry.ts 의 waferLine)와 같은 문장 형식. 구조화 사본(details_json.wafer)이 없으면 빈 문자열.
 * 값 해석은 관리자 화면의 waferInq 와 같다(이름 = 저장된 상품 이름, 없으면 상품 코드).
 * 달러 환산(≈ $… · 환율 …)은 뺀다 — 접수 당시 환율이 저장돼 있지 않다.
 * @param {any} row inquiries 행
 */
export function waferLineFromRow(row) {
  const w = parseJson(row?.details_json)?.wafer;
  if (!w || typeof w !== 'object') return '';
  const sku = String(w.sku ?? '');
  const name = str(row?.product_name) || sku;
  const qty = Number(w.qty) || 1;
  const dicing = w.dicing === true;
  const fee = Number(w.dicingFeeKrw) || 0;
  const total = Number(w.totalKrw) || 0;
  return `상품: ${name} (${sku}) × ${qty}박스` +
    ` · 다이싱: ${dicing ? `필요 (+₩${fee.toLocaleString('ko-KR')}/박스 × ${qty})` : '불필요'}` +
    (total > 0 ? ` · 예상 합계 ₩${total.toLocaleString('ko-KR')}` : '');
}

/**
 * 접수 시 자동 견적 한 줄 — 개정 중 source 가 auto 인 첫 개정으로 다시 만든다(접수 때와 같은 buildEstimateChatLine).
 * 자동 견적이 없거나 만들지 못하면 빈 문자열(그 줄만 빠진다).
 * @param {unknown} revisions quote_revisions 행들({rev, source, kind, total, seen_total, manual_json})
 */
export function estimateLineFromRevisions(revisions) {
  try {
    const first = summarizeRevisions(revisions).first;
    if (!first) return '';
    if (first.kind === 'estimate') {
      if (typeof first.total !== 'number') return '';
      return buildEstimateChatLine({ kind: 'estimate', total: first.total, seenTotal: first.seenTotal });
    }
    if (first.kind === 'manual') return buildEstimateChatLine({ kind: 'manual', manualAdmin: first.manualAdmin });
    return '';
  } catch {
    return '';
  }
}

/**
 * inquiries 행 → 담당자 메일 입력(staffSubject · staffText 에 그대로 넘긴다).
 * 접수 때 api/inquiry.ts 가 넘기는 값과 같은 자리에 같은 뜻의 값을 채운다.
 * @param {any} row inquiries 행
 * @param {{ origin: string, revisions?: unknown }} o origin = 요청이 들어온 주소 · revisions = 그 접수의 개정 행들(없으면 자동 견적 줄 없음)
 */
export function staffInputFromRow(row, o) {
  const sample = parseJson(row?.details_json)?.sampleCount;
  return {
    type: row?.type === 'quote' ? 'quote' : 'general',
    id: str(row?.id),
    receivedKst: kstText(row?.created_at),
    locale: str(row?.locale),
    origin: str(o?.origin),
    name: str(row?.name), company: str(row?.company), email: str(row?.email), phone: str(row?.phone),
    productName: str(row?.product_name), product: str(row?.product_sku),
    material: materialLabels(str(row?.material)),
    method: str(row?.method), substrate: str(row?.substrate),
    sampleCount: sample == null ? '' : str(sample),
    waferLine: waferLineFromRow(row),
    details: str(row?.details),
    estimateLine: estimateLineFromRevisions(o?.revisions),
    message: str(row?.message),
  };
}
