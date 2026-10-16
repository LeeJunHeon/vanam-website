// 담당자 알림 메일 — 제목·본문 조립 + 발송 판정 순서(순수 함수).
//
// 무엇: 홈페이지 문의(견적 요청·일반 문의·웨이퍼 문의)가 접수되면 담당자에게 접수 내용 전체를 한 통 보낸다.
//   받는 주소는 Cloudflare 비밀값 INQUIRY_NOTIFY_TO(값은 어디에도 적지 않는다) — 읽기·발송은 staff-notify-run.ts.
// 구글챗 알림(chat-message.js)과의 차이: 구글챗은 메시지 크기 한도 때문에 요청 본문을 자르지만, 메일은 전문을 싣는다.
//
// ⚠️ .js 이고 다른 모듈을 import 하지 않는다(chat-message.js 와 같은 원칙) —
//    node 테스트(scripts/test-staff-notify.mjs)가 빌드 없이 최종 제목·본문과 발송 판정을 확인한다.
// ⚠️ 첨부·PDF 없이 글만 보낸다(무료 플랜 CPU 한도). html 은 text 를 이스케이프해 <pre> 하나에 넣은 것 —
//    Gmail 은 text/plain 을 html 에서 다시 만들기 때문에 두 본문이 같은 글자로 보여야 한다.

/** 보내는 사람 표시 이름 */
export const STAFF_FROM_NAME = 'VanaM 홈페이지';

/** 제목에 싣는 회사·이름 최대 길이(글자) */
export const STAFF_SUBJECT_NAME_MAX = 40;

/** 이 사유로 끝나면 담당자 구글챗에 한 줄 알린다(실제 실패 · 설정 오류). blocked_host 등은 조용히 넘긴다. */
export const STAFF_ALERT_REASONS = ['auth_failed', 'http_error', 'fetch_error', 'error', 'no_credentials', 'bad_recipient', 'bad_config'];

const KIND_LABEL = { quote: '견적 요청', general: '일반 문의', wafer: '웨이퍼 문의' };
const SUBJECT_TAG = { quote: '[홈페이지 견적요청]', general: '[홈페이지 문의]', wafer: '[홈페이지 웨이퍼 문의]' };

const str = (v) => (v == null ? '' : String(v).trim());

/** 제목용 한 줄 — 줄바꿈·제어문자를 공백으로 바꾸고 공백을 하나로 모은다 */
const oneLine = (v) => str(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();

const cut = (s, max) => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * 접수 유형 — 공정 견적이면 quote, 일반 문의 중 웨이퍼 상품 줄이 있으면 wafer, 그 밖은 general.
 * @param {{ type: string, waferLine?: string }} p
 * @returns {'quote' | 'general' | 'wafer'}
 */
export function staffKind(p) {
  if (p.type === 'quote') return 'quote';
  return str(p.waferLine) ? 'wafer' : 'general';
}

/**
 * 제목 — "[홈페이지 견적요청] {회사, 없으면 이름} · {접수번호}"
 * @param {{ type: string, waferLine?: string, company?: string, name?: string, id: string }} p
 */
export function staffSubject(p) {
  const who = cut(oneLine(p.company) || oneLine(p.name), STAFF_SUBJECT_NAME_MAX);
  return [`${SUBJECT_TAG[staffKind(p)]}`, who, '·', oneLine(p.id)].filter(Boolean).join(' ');
}

/** "라벨: 값" 한 줄 — 값이 없으면 빈 문자열(뺀다). 여러 줄 값은 라벨 다음 줄부터 전문. */
const line = (label, v) => {
  const s = str(v);
  if (!s) return '';
  return s.includes('\n') ? `${label}:\n${s}` : `${label}: ${s}`;
};

/** 줄 묶음 하나 — 값 있는 줄이 하나도 없으면 머리까지 통째로 뺀다 */
const section = (head, lines) => {
  const kept = lines.filter(Boolean);
  return kept.length ? [head, ...kept].join('\n') : '';
};

/**
 * 본문(text). 라벨 순서는 고정 — 값이 없는 줄은 뺀다. 상세·메시지는 자르지 않는다.
 * @param {{
 *   type: string, id: string, receivedKst?: string, locale?: string, origin: string,
 *   name?: string, company?: string, email?: string, phone?: string,
 *   productName?: string, product?: string, material?: string, method?: string, substrate?: string,
 *   sampleCount?: string, waferLine?: string, details?: string, estimateLine?: string, message?: string,
 * }} p
 * @returns {string}
 */
export function staffText(p) {
  const kind = staffKind(p);
  const id = str(p.id);
  const origin = str(p.origin).replace(/\/+$/, '');
  const admin = kind === 'quote' ? `${origin}/admin/quote?id=${encodeURIComponent(id)}` : `${origin}/admin`;
  const productName = str(p.productName);
  const product = str(p.product);
  const productLine = productName && product && productName !== product ? `${productName} (${product})` : productName || product;
  // 자동 견적 줄(buildEstimateChatLine)은 구글챗용 머리("💰 예상 견적(자동): ")를 달고 온다 — 라벨과 겹치지 않게 뗀다
  const estimate = str(p.estimateLine).replace(/^💰\s*예상 견적\(자동\):\s*/, '');
  const message = str(p.message);

  return [
    '새 홈페이지 문의가 접수되었습니다.',
    [
      line('접수번호', id),
      line('접수시각', str(p.receivedKst) ? `${str(p.receivedKst)} (KST)` : ''),
      line('유형', KIND_LABEL[kind]),
      line('언어', p.locale),
      line('관리 화면', admin),
    ].filter(Boolean).join('\n'),
    section('[고객]', [
      line('이름', p.name),
      line('회사', p.company),
      line('이메일', p.email),
      line('전화', p.phone),
    ]),
    section('[요청 내용]', [
      line('제품', productLine),
      line('물질', p.material),
      line('방식', p.method),
      line('기판', p.substrate),
      line('샘플 수량', p.sampleCount),
      line('웨이퍼 정보', p.waferLine),
      line('상세', p.details),
      line('자동 견적', estimate),
    ]),
    message ? ['[고객이 쓴 메시지 — 원문]', '-----', message, '-----'].join('\n') : '',
    '이 메일은 홈페이지가 자동으로 보낸 알림입니다. 이 메일에 답장하면 hello@ 로 갑니다 — 고객 회신은 위 고객 이메일로 보내 주세요.',
  ].filter(Boolean).join('\n\n');
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 본문(html) — text 를 이스케이프해 <pre> 하나에 넣는다(두 본문이 같은 글자) */
export function staffHtml(text) {
  return `<pre style="white-space:pre-wrap;font-family:inherit">${esc(text)}</pre>`;
}

/** 실패 알림 구글챗 한 줄 — 접수번호와 사유만(고객 정보 없음) */
export function staffAlertText(id, reason) {
  return `⚠️ 담당자 알림 메일 발송 실패 — 접수번호 ${oneLine(id)} (${oneLine(reason)}). 관리자 화면에서 확인해 주세요.`;
}

/**
 * 담당자 알림 한 건의 판정·발송 순서. 예외를 던지지 않는다.
 *   테스트 빌드(live=false) → 아무것도 하지 않음(받는 주소도 읽지 않는다 — 시험 접수가 담당자 메일함으로 가지 않게)
 *   받는 주소 비어 있음 → 건너뜀(기능 꺼짐) · 주소 모양이 틀림 → 설정 오류(bad_config) 알림
 *   발송 → 실제 실패면 구글챗 한 줄
 * 실제 발송·주소 읽기·주소 검사·구글챗은 호출부(staff-notify-run.ts)가 넘긴다 — 테스트는 가짜를 넘긴다.
 * @param {{
 *   live: boolean, id: string, readTo: () => string, isSafeAddress: (a: unknown) => boolean,
 *   send: (to: string) => Promise<{ sent: boolean, reason: string }>, alert: (text: string) => Promise<unknown>,
 * }} d
 * @returns {Promise<{ sent: boolean, reason: string }>}
 */
export async function staffNotifyFlow(d) {
  if (!d.live) return { sent: false, reason: 'blocked_build' };
  let r;
  try {
    const to = str(d.readTo());
    if (!to) return { sent: false, reason: 'disabled' };
    r = d.isSafeAddress(to) ? await d.send(to) : { sent: false, reason: 'bad_config' };
  } catch {
    r = { sent: false, reason: 'error' };
  }
  if (!r.sent && STAFF_ALERT_REASONS.includes(r.reason)) {
    try {
      await d.alert(staffAlertText(d.id, r.reason));
    } catch {
      /* 알림 실패는 무시 — 로그는 호출부가 남긴다 */
    }
  }
  return { sent: Boolean(r.sent), reason: String(r.reason ?? 'error') };
}
