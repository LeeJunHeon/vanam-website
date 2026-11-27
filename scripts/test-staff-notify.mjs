// scripts/test-staff-notify.mjs — 담당자 알림 메일(staff-notify.js) 단위 테스트
//
// 제목·본문이 정한 모양인지, 테스트 빌드에서는 발송·주소 읽기를 아예 하지 않는지 확인한다.
// 실제 발송 통로(staff-notify-run.ts)는 cloudflare:workers 를 쓰므로 node 에서 부를 수 없다 —
// 판정 순서(staffNotifyFlow)는 가짜 통로로, 실행부는 원문 검사로 확인한다.
import { readFileSync } from 'node:fs';
import {
  staffKind, staffSubject, staffText, staffHtml, staffAlertText, staffNotifyFlow,
  STAFF_FROM_NAME, STAFF_SUBJECT_NAME_MAX, STAFF_ALERT_REASONS,
} from '../src/lib/staff-notify.js';
import { isSafeAddress } from '../src/lib/mail-mime.js';
import {
  staffInputFromRow, waferLineFromRow, estimateLineFromRevisions, staffRecord, staffStatusOf, staffMailLabel,
  staffSentBefore, isStaffPending, staffNotifyRecorded, parseStaffMail, STAFF_REASON_KO,
} from '../src/lib/staff-notify-record.js';
import { ACK_REASON_KO } from '../src/lib/quote-ack.js';
import { SECRET_RES, checkSource } from './check-mail-guard.mjs';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}

const ORIGIN = 'https://vanam.co.kr';
const quote = {
  type: 'quote', id: 'INQ-TEST-0001', receivedKst: '2026-10-16 10:20', locale: 'ko', origin: ORIGIN,
  name: '홍길동', company: '테스트대학교', email: 'customer@example.com', phone: '010-0000-0000',
  productName: '산화물 박막 증착', product: 'oxide-deposition', material: 'SiO2', method: 'PECVD',
  substrate: 'Si 4인치', sampleCount: '3', details: '1단계: SiO2 100nm\n2단계: 열처리', estimateLine: '💰 예상 견적(자동): ₩1,100,000 (부가세 포함 · 확정 전)',
  message: '',
};
const general = { type: 'general', id: 'INQ-TEST-0002', receivedKst: '2026-10-16 10:21', locale: 'en', origin: ORIGIN,
  name: 'Jane Doe', company: '', email: 'jane@example.com', phone: '', message: 'Hello,\nplease call me.' };
const wafer = { ...general, id: 'INQ-TEST-0003', company: 'Wafer Lab', product: 'si-wafer-4', productName: 'Si 웨이퍼 4인치',
  waferLine: '상품: Si 웨이퍼 4인치 (si-wafer-4) × 2박스 · 다이싱: 불필요 · 예상 합계 ₩200,000' };

// ① 유형별 제목 · 회사 없으면 이름
eq('유형 판정', [staffKind(quote), staffKind(general), staffKind(wafer)], ['quote', 'general', 'wafer']);
eq('견적 제목', staffSubject(quote), '[홈페이지 견적요청] 테스트대학교 · INQ-TEST-0001');
eq('일반 문의 제목(회사 없음 → 이름)', staffSubject(general), '[홈페이지 문의] Jane Doe · INQ-TEST-0002');
eq('웨이퍼 문의 제목', staffSubject(wafer), '[홈페이지 웨이퍼 문의] Wafer Lab · INQ-TEST-0003');
eq('보내는 이름', STAFF_FROM_NAME, 'VanaM 홈페이지');

// ② 메시지·상세는 자르지 않는다(구글챗 상한 3000자보다 길게)
const longDetails = Array.from({ length: 400 }, (_, i) => `단계 ${i + 1}: 아주 긴 공정 설명 줄입니다`).join('\n');
const longMsg = 'M'.repeat(9000) + '끝';
const longText = staffText({ ...quote, details: longDetails, message: longMsg });
eq('상세 전문이 실림', [longDetails.length > 3000, longText.includes(longDetails)], [true, true]);
eq('메시지 전문이 실림', [longText.includes(longMsg), longText.includes('이하 생략')], [true, false]);

// ③ 빈 값 줄 생략
const gText = staffText(general);
eq('빈 회사·전화 줄 없음', [/^회사:/m.test(gText), /^전화:/m.test(gText)], [false, false]);
eq('요청 내용이 하나도 없으면 [요청 내용] 머리도 없음', gText.includes('[요청 내용]'), false);
const qText = staffText(quote);
eq('메시지 없으면 원문 칸 없음', qText.includes('[고객이 쓴 메시지'), false);
eq('웨이퍼 정보 없으면 줄 없음', /^웨이퍼 정보:/m.test(qText), false);
eq('일반 문의 메시지 칸', gText.includes('[고객이 쓴 메시지 — 원문]\n-----\nHello,\nplease call me.\n-----'), true);

// 라벨 순서 고정
const order = ['새 홈페이지 문의가 접수되었습니다.', '접수번호: ', '접수시각: ', '유형: ', '언어: ', '관리 화면: ',
  '[고객]', '이름: ', '회사: ', '이메일: ', '전화: ', '[요청 내용]', '제품: ', '물질: ', '방식: ', '기판: ', '샘플 수량: ',
  '상세:', '자동 견적: ', '이 메일은 홈페이지가 자동으로 보낸 알림입니다.'];
const pos = order.map((l) => qText.indexOf(l));
eq('견적 본문 라벨 순서', pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1])), true);
eq('접수시각 KST 표기 · 유형 · 언어', [qText.includes('접수시각: 2026-10-16 10:20 (KST)'), qText.includes('유형: 견적 요청'), qText.includes('언어: ko')], [true, true, true]);
eq('제품 줄(이름 + 코드)', qText.includes('제품: 산화물 박막 증착 (oxide-deposition)'), true);
eq('여러 줄 상세는 라벨 다음 줄부터', qText.includes('상세:\n1단계: SiO2 100nm\n2단계: 열처리'), true);
eq('자동 견적 줄 머리 중복 없음', qText.includes('자동 견적: ₩1,100,000 (부가세 포함 · 확정 전)'), true);
eq('웨이퍼 정보 줄', staffText(wafer).includes(`웨이퍼 정보: ${wafer.waferLine}`), true);
eq('맺음말', qText.endsWith('이 메일에 답장하면 hello@ 로 갑니다 — 고객 회신은 위 고객 이메일로 보내 주세요.'), true);

// ④ 제목의 줄바꿈·제어문자 제거 · 길이 자르기
const evil = staffSubject({ ...quote, company: '악성\r\nBcc: x@evil.test\u0000\u0007회사\u2028끝' });
eq('제목에 줄바꿈·제어문자 없음', /[\u0000-\u001f\u007f\u2028\u2029]/.test(evil), false);
eq('제목 정리 결과', evil, '[홈페이지 견적요청] 악성 Bcc: x@evil.test 회사 끝 · INQ-TEST-0001');
const longName = staffSubject({ ...general, name: '가'.repeat(100) });
eq('제목 이름 자르기', longName, `[홈페이지 문의] ${'가'.repeat(STAFF_SUBJECT_NAME_MAX)}… · INQ-TEST-0002`);

// ⑤ HTML 이스케이프 — html 은 text 를 그대로 옮긴 것
const xss = staffText({ ...general, message: '<script>alert("x")</script> & \'q\'', name: '<b>이름</b>' });
const html = staffHtml(xss);
eq('html 에 날것의 태그 없음', [html.includes('<script>'), html.includes('<b>')], [false, false]);
eq('이스케이프된 글자', html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;'), true);
eq('pre 한 덩어리', [html.startsWith('<pre style="white-space:pre-wrap;font-family:inherit">'), html.endsWith('</pre>')], [true, true]);
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
eq('html 을 풀면 text 와 같은 글자', unesc(html.replace(/^<pre[^>]*>/, '').replace(/<\/pre>$/, '')), xss);

// ⑥ 관리 화면 링크
eq('견적 → /admin/quote?id=', qText.includes(`관리 화면: ${ORIGIN}/admin/quote?id=INQ-TEST-0001`), true);
eq('일반 → /admin', gText.includes(`관리 화면: ${ORIGIN}/admin\n`), true);
eq('웨이퍼 → /admin', staffText(wafer).includes(`관리 화면: ${ORIGIN}/admin\n`), true);
eq('origin 끝 / 정리', staffText({ ...quote, origin: `${ORIGIN}/` }).includes(`${ORIGIN}/admin/quote?id=`), true);

// ⑦ 발송 판정 순서 — 가짜 통로로 무엇을 불렀는지 센다
async function flow(opts) {
  const calls = { readTo: 0, send: 0, alert: [] };
  const r = await staffNotifyFlow({
    live: opts.live, id: 'INQ-TEST-0009', isSafeAddress,
    readTo: () => { calls.readTo++; if (opts.readThrows) throw new Error('x'); return opts.to ?? ''; },
    send: async () => { calls.send++; if (opts.sendThrows) throw new Error('x'); return opts.result ?? { sent: true, reason: 'ok' }; },
    alert: async (t) => { calls.alert.push(t); if (opts.alertThrows) throw new Error('x'); },
  });
  return { r, calls };
}
const TO = 'staff@example.com';
{
  const { r, calls } = await flow({ live: false, to: TO });
  eq('테스트 빌드 → 주소 읽기·발송·알림 0회', [r, calls.readTo, calls.send, calls.alert.length], [{ sent: false, reason: 'blocked_build' }, 0, 0, 0]);
}
{
  const { r, calls } = await flow({ live: true, to: '' });
  eq('주소 없음 → 조용히 건너뜀', [r.reason, calls.send, calls.alert.length], ['disabled', 0, 0]);
}
{
  const { r, calls } = await flow({ live: true, to: '  ' });
  eq('공백 주소 → 건너뜀', [r.reason, calls.send], ['disabled', 0]);
}
{
  const { r, calls } = await flow({ live: true, to: 'not-an-address' });
  eq('주소 모양 틀림 → 설정 오류 알림(발송 없음)', [r.reason, calls.send, calls.alert], ['bad_config', 0,
    ['⚠️ 담당자 알림 메일 발송 실패 — 접수번호 INQ-TEST-0009 (bad_config). 관리자 화면에서 확인해 주세요.']]);
}
{
  const { r, calls } = await flow({ live: true, to: TO });
  eq('정상 발송 → 알림 없음', [r, calls.send, calls.alert.length], [{ sent: true, reason: 'ok' }, 1, 0]);
}
for (const reason of ['auth_failed', 'http_error', 'fetch_error', 'error', 'no_credentials', 'bad_recipient']) {
  const { r, calls } = await flow({ live: true, to: TO, result: { sent: false, reason } });
  eq(`실패(${reason}) → 구글챗 한 줄`, [r.reason, calls.alert.length, calls.alert[0]?.includes(`(${reason})`)], [reason, 1, true]);
}
{
  // 토큰 단계 실패(11-27) — 알림 목록에서 빠지면 구글 인증 서버가 응답하지 않아 실패해도 조용히 지나간다
  const { r, calls } = await flow({ live: true, to: TO, result: { sent: false, reason: 'token_unreachable' } });
  eq('실패(token_unreachable) → 구글챗 한 줄', [r.reason, calls.alert, STAFF_ALERT_REASONS.includes('token_unreachable')],
    ['token_unreachable', ['⚠️ 담당자 알림 메일 발송 실패 — 접수번호 INQ-TEST-0009 (token_unreachable). 관리자 화면에서 확인해 주세요.'], true]);
  eq('실패 알림: 실행 위치가 있으면 사유 뒤에 · 이상한 값은 빼고', [staffAlertText('INQ-TEST-0009', 'token_unreachable', 'HKG'), staffAlertText('INQ-TEST-0009', 'fetch_error', 'hkg x'), staffAlertText('INQ-TEST-0009', 'fetch_error')],
    ['⚠️ 담당자 알림 메일 발송 실패 — 접수번호 INQ-TEST-0009 (token_unreachable · 실행 위치 HKG). 관리자 화면에서 확인해 주세요.',
      '⚠️ 담당자 알림 메일 발송 실패 — 접수번호 INQ-TEST-0009 (fetch_error). 관리자 화면에서 확인해 주세요.',
      '⚠️ 담당자 알림 메일 발송 실패 — 접수번호 INQ-TEST-0009 (fetch_error). 관리자 화면에서 확인해 주세요.']);
}
{
  const { r, calls } = await flow({ live: true, to: TO, result: { sent: false, reason: 'blocked_host' } });
  eq('blocked_host → 조용히', [r.reason, calls.alert.length], ['blocked_host', 0]);
}
{
  const { r, calls } = await flow({ live: true, to: TO, sendThrows: true });
  eq('발송 예외 → error + 알림(밖으로 던지지 않음)', [r.reason, calls.alert.length], ['error', 1]);
}
{
  const { r } = await flow({ live: true, to: TO, result: { sent: false, reason: 'http_error' }, alertThrows: true });
  eq('알림까지 실패해도 던지지 않음', r.reason, 'http_error');
}
{
  const { r, calls } = await flow({ live: true, readThrows: true });
  eq('주소 읽기 예외 → error + 알림', [r.reason, calls.send, calls.alert.length], ['error', 0, 1]);
}
eq('알림 문구에 고객 정보 없음', staffAlertText('INQ-1', 'http_error'), '⚠️ 담당자 알림 메일 발송 실패 — 접수번호 INQ-1 (http_error). 관리자 화면에서 확인해 주세요.');
eq('알림 사유 목록', STAFF_ALERT_REASONS.includes('blocked_host'), false);

// 실행부 원문 검사 — 운영 표식으로만 보내고, 통로는 sendMail · sendChat 하나씩, fetch 직접 호출 없음
const run = readFileSync('src/lib/staff-notify-run.ts', 'utf8');
const pure = readFileSync('src/lib/staff-notify.js', 'utf8');
eq('실행부: live 는 MAIL_LIVE', /live:\s*MAIL_LIVE\b/.test(run), true);
eq('실행부: fetch 직접 호출 없음', /\bfetch\s*\(/.test(run), false);
eq('실행부: 받는 주소는 cloudflare:workers env 에서', [run.includes("from 'cloudflare:workers'"), run.includes('INQUIRY_NOTIFY_TO')], [true, true]);
eq('실행부: mail-mode.js 를 import 하지 않음', /from ['"][^'"]*mail-mode/.test(run), false);
eq('순수 함수 파일: import 없음', /^\s*import\s/m.test(pure), false);
const ADDR_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]/;
eq('새 파일에 메일 주소 없음', [ADDR_RE.test(run), ADDR_RE.test(pure)], [false, false]);

// 게이트: 받는 주소 비밀값이 번들에 박힌 모양을 잡는다 · 실제 저장소 src 는 통과
eq('INQUIRY_NOTIFY_TO 값이 박힌 모양 → 잡힘', SECRET_RES.some((re) => re.test('{"INQUIRY_NOTIFY_TO":"someone@example.com"}')), true);
eq('이름만(값 없음) → 통과', SECRET_RES.some((re) => re.test("cfEnv?.INQUIRY_NOTIFY_TO ?? ''")), false);
eq('실제 저장소 src → 메일 게이트 통과', checkSource('src'), []);

// ⑧ 저장된 접수 행 → 메일 입력(관리자 [담당자 메일 (다시) 보내기]) — 전부 가짜 값
const base0 = total;
const rowQuote = {
  id: 'INQ-20991231-TEST', type: 'quote', status: 'new', created_at: '2099-12-31T07:15:00.000Z', locale: 'ko',
  name: '홍길동', company: '테스트대학교', email: 'customer@example.com', phone: '010-0000-0000',
  product_name: '산화물 박막 증착', product_sku: 'oxide-deposition', material: 'SiO2, TiO2', method: 'PECVD', substrate: 'Si 4인치',
  details: '1단계: SiO2 100nm\n2단계: 열처리', details_json: JSON.stringify({ sampleCount: '3', steps: [] }), message: null,
};
const revs = [
  { rev: 2, source: 'staff', kind: 'estimate', total: 2200000, seen_total: null, manual_json: null, created_at: '2100-01-01T00:00:00.000Z' },
  { rev: 1, source: 'auto', kind: 'estimate', total: 1100000, seen_total: 1000000, manual_json: null, created_at: '2099-12-31T07:15:01.000Z' },
];
const inQuote = staffInputFromRow(rowQuote, { origin: ORIGIN, revisions: revs });
eq('행→입력(견적): 기본 대응', [inQuote.type, inQuote.id, inQuote.locale, inQuote.origin, inQuote.name, inQuote.company, inQuote.email, inQuote.phone],
  ['quote', 'INQ-20991231-TEST', 'ko', ORIGIN, '홍길동', '테스트대학교', 'customer@example.com', '010-0000-0000']);
eq('행→입력(견적): 제품·물질·방식·기판·상세', [inQuote.productName, inQuote.product, inQuote.material, inQuote.method, inQuote.substrate, inQuote.details],
  ['산화물 박막 증착', 'oxide-deposition', 'SiO2, TiO2', 'PECVD', 'Si 4인치', '1단계: SiO2 100nm\n2단계: 열처리']);
eq('행→입력(견적): 접수시각은 한국 시간(UTC 07:15 → 16:15)', inQuote.receivedKst, '2099-12-31 16:15');
eq('행→입력(견적): 샘플 수량 = details_json.sampleCount', inQuote.sampleCount, '3');
eq('행→입력(견적): 웨이퍼 줄 없음', inQuote.waferLine, '');
eq('행→입력(견적): 자동 견적 줄 = 첫 자동 개정(나중 담당자 개정 아님)', inQuote.estimateLine,
  '💰 예상 견적(자동): ₩1,100,000 (부가세 포함 · 확정 전) · 고객 화면 금액 ₩1,000,000 과 다름');
{
  const t = staffText(inQuote);
  eq('행→입력(견적): 본문 줄', [
    t.includes('접수번호: INQ-20991231-TEST'), t.includes('접수시각: 2099-12-31 16:15 (KST)'), t.includes('유형: 견적 요청'),
    t.includes('제품: 산화물 박막 증착 (oxide-deposition)'), t.includes('샘플 수량: 3'),
    t.includes('자동 견적: ₩1,100,000 (부가세 포함 · 확정 전) · 고객 화면 금액 ₩1,000,000 과 다름'),
    t.includes(`관리 화면: ${ORIGIN}/admin/quote?id=INQ-20991231-TEST`),
  ], [true, true, true, true, true, true, true]);
  eq('행→입력(견적): 제목', staffSubject(inQuote), '[홈페이지 견적요청] 테스트대학교 · INQ-20991231-TEST');
  // 접수 때 넘기던 값과 같은 입력이면 본문도 같은 글자
  const atReceipt = { type: 'quote', id: rowQuote.id, receivedKst: '2099-12-31 16:15', locale: 'ko', origin: ORIGIN,
    name: rowQuote.name, company: rowQuote.company, email: rowQuote.email, phone: rowQuote.phone,
    productName: rowQuote.product_name, product: rowQuote.product_sku, material: 'SiO2, TiO2', method: 'PECVD', substrate: 'Si 4인치',
    sampleCount: '3', waferLine: '', details: rowQuote.details, estimateLine: inQuote.estimateLine, message: '' };
  eq('행→입력(견적): 접수 때 입력과 본문이 같은 글자', t, staffText(atReceipt));
}
{
  // 값이 없으면 그 줄이 빠진다 — 샘플 수량·자동 견적·깨진 구조화 사본
  const bare = staffInputFromRow({ ...rowQuote, details_json: '{깨짐', phone: null, company: null }, { origin: ORIGIN });
  const t = staffText(bare);
  eq('행→입력: 값 없으면 줄 생략', [bare.sampleCount, bare.estimateLine, bare.waferLine, /^샘플 수량:/m.test(t), /^자동 견적:/m.test(t), /^전화:/m.test(t), /^회사:/m.test(t)],
    ['', '', '', false, false, false, false]);
  eq('행→입력: 구조화 사본 없음(NULL)', staffInputFromRow({ ...rowQuote, details_json: null }, { origin: ORIGIN }).sampleCount, '');
  eq('행→입력: 접수 시각이 이상하면 줄 생략', /^접수시각:/m.test(staffText(staffInputFromRow({ ...rowQuote, created_at: 'x' }, { origin: ORIGIN }))), false);
}
// 자동 견적 줄 — 담당자 확인 건 · 자동 개정 없음 · 이상한 입력
eq('자동 견적 줄: 자동 개정 없음 → 빈 줄', estimateLineFromRevisions([revs[0]]), '');
eq('자동 견적 줄: 개정 없음·이상한 값 → 빈 줄', [estimateLineFromRevisions([]), estimateLineFromRevisions(null), estimateLineFromRevisions('x')], ['', '', '']);
eq('자동 견적 줄: 금액 없는 예상 견적 → 빈 줄', estimateLineFromRevisions([{ rev: 1, source: 'auto', kind: 'estimate', total: null, seen_total: null, manual_json: null }]), '');
eq('자동 견적 줄: 고객 화면 금액과 같으면 덧말 없음',
  estimateLineFromRevisions([{ rev: 1, source: 'auto', kind: 'estimate', total: 550000, seen_total: 550000, manual_json: null }]),
  '💰 예상 견적(자동): ₩550,000 (부가세 포함 · 확정 전)');
eq('자동 견적 줄: 담당자 확인 건', estimateLineFromRevisions([{ rev: 1, source: 'auto', kind: 'manual', total: null, seen_total: null,
  manual_json: JSON.stringify([{ code: 'samples', min: 10 }]) }]).startsWith('💰 예상 견적(자동): 담당자 확인 필요 — '), true);

const rowGeneral = { id: 'INQ-20991231-GEN2', type: 'general', status: 'new', created_at: '2099-12-31T15:30:00.000Z', locale: 'en',
  name: 'Jane Doe', company: null, email: 'jane@example.com', phone: null, product_name: null, product_sku: null,
  material: null, method: null, substrate: null, details: null, details_json: null, message: 'Hello,\nplease call me.' };
const inGeneral = staffInputFromRow(rowGeneral, { origin: ORIGIN, revisions: [] });
{
  const t = staffText(inGeneral);
  eq('행→입력(일반): 유형·제목', [staffKind(inGeneral), staffSubject(inGeneral)], ['general', '[홈페이지 문의] Jane Doe · INQ-20991231-GEN2']);
  eq('행→입력(일반): 날짜가 넘어가는 한국 시간(UTC 15:30 → 다음 날 00:30)', inGeneral.receivedKst, '2100-01-01 00:30');
  eq('행→입력(일반): 요청 내용 묶음 없음 · 메시지 원문 · 관리 화면', [
    t.includes('[요청 내용]'), /^샘플 수량:/m.test(t), /^웨이퍼 정보:/m.test(t), /^자동 견적:/m.test(t),
    t.includes('[고객이 쓴 메시지 — 원문]\n-----\nHello,\nplease call me.\n-----'), t.includes(`관리 화면: ${ORIGIN}/admin\n`), t.includes('언어: en'),
  ], [false, false, false, false, true, true, true]);
}

const rowWafer = { ...rowGeneral, id: 'INQ-20991231-WAF3', company: 'Wafer Lab', product_name: 'Si 웨이퍼 4인치', product_sku: 'si-wafer-4',
  details_json: JSON.stringify({ wafer: { sku: 'si-wafer-4', qty: 2, dicing: true, dicingFeeKrw: 70000, unitKrw: 900000, totalKrw: 1940000 } }) };
const inWafer = staffInputFromRow(rowWafer, { origin: ORIGIN });
eq('행→입력(웨이퍼): 유형·제목', [staffKind(inWafer), staffSubject(inWafer)], ['wafer', '[홈페이지 웨이퍼 문의] Wafer Lab · INQ-20991231-WAF3']);
eq('행→입력(웨이퍼): 웨이퍼 줄(접수 때와 같은 형식 · 달러 환산 없음)', inWafer.waferLine,
  '상품: Si 웨이퍼 4인치 (si-wafer-4) × 2박스 · 다이싱: 필요 (+₩70,000/박스 × 2) · 예상 합계 ₩1,940,000');
eq('행→입력(웨이퍼): 본문에 웨이퍼 정보 줄 · 달러 표기 없음', [staffText(inWafer).includes(`웨이퍼 정보: ${inWafer.waferLine}`), /\$|환율/.test(inWafer.waferLine), inWafer.sampleCount],
  [true, false, '']);
eq('웨이퍼 줄: 다이싱 불필요 · 합계 없음(옛 문의)', waferLineFromRow({ product_name: 'Si 웨이퍼 4인치', details_json: JSON.stringify({ wafer: { sku: 'si-wafer-4', qty: 1, dicing: false } }) }),
  '상품: Si 웨이퍼 4인치 (si-wafer-4) × 1박스 · 다이싱: 불필요');
eq('웨이퍼 줄: 상품 이름 없으면 코드', waferLineFromRow({ product_name: null, details_json: JSON.stringify({ wafer: { sku: 'si-wafer-4', qty: 3, dicing: false, totalKrw: 300000 } }) }),
  '상품: si-wafer-4 (si-wafer-4) × 3박스 · 다이싱: 불필요 · 예상 합계 ₩300,000');
eq('웨이퍼 줄: 사본 없음·깨짐 → 빈 줄', [waferLineFromRow({ details_json: null }), waferLineFromRow({ details_json: '{' }), waferLineFromRow({ details_json: '{"sampleCount":"2"}' }), waferLineFromRow(null)], ['', '', '', '']);
const rowTests = total - base0;

// ⑨ 결과 기록(inquiries.staff_mail) — 자동 실패 → 관리자 성공 순서의 n · sentAt · sentN 과 화면 한 줄
const base1 = total;
const T1 = '2099-12-31T07:15:02.000Z', T2 = '2099-12-31T07:50:00.000Z', T3 = '2099-12-31T08:00:00.000Z';
eq('상태 판정', [staffStatusOf({ sent: true, reason: 'ok' }), staffStatusOf({ sent: false, reason: 'fetch_error' }), staffStatusOf({ sent: false, reason: 'disabled' }),
  staffStatusOf({ sent: false, reason: 'blocked_build' }), staffStatusOf({ sent: false, reason: 'blocked_host' }), staffStatusOf({ sent: false, reason: 'no_credentials' }),
  staffStatusOf({ sent: false, reason: 'bad_config' }), staffStatusOf({ sent: false }), staffStatusOf(null)].map((x) => `${x.status}:${x.reason}`),
  ['sent:null', 'failed:fetch_error', 'skipped:disabled', 'skipped:blocked_build', 'skipped:blocked_host', 'skipped:no_credentials', 'failed:bad_config', 'failed:error', 'failed:error']);
const r1 = staffRecord(null, { status: 'failed', reason: 'fetch_error', by: 'auto', at: T1 });
eq('기록: 자동 실패', JSON.parse(r1), { status: 'failed', reason: 'fetch_error', by: 'auto', at: T1, n: 1, sentAt: null, sentN: 0 });
eq('라벨: 자동 실패', staffMailLabel(r1), { tone: 'bad', text: '담당자 메일: 실패 — Gmail 발송 단계 연결 오류 — 나갔는지 확실하지 않으니 hello@ 보낸편지함을 확인하세요 · 2099-12-31 16:15' });
eq('버튼: 보낸 적 없음', [staffSentBefore(null), staffSentBefore(r1), staffSentBefore('깨짐')], [false, false, false]);
const r1p = staffRecord(r1, { status: 'pending', by: 'admin', at: T2 });
eq("기록: '보내는 중'은 횟수를 세지 않는다", JSON.parse(r1p), { status: 'pending', reason: null, by: 'admin', at: T2, n: 1, sentAt: null, sentN: 0 });
eq('라벨: 보내는 중(2분 안) → 버튼 숨김 판정', [staffMailLabel(r1p, Date.parse(T2) + 30_000), isStaffPending(r1p, Date.parse(T2) + 30_000)],
  [{ tone: 'muted', text: '담당자 메일: 보내는 중…' }, true]);
eq('라벨: 2분이 지난 보내는 중 → 중단됨', [staffMailLabel(r1p, Date.parse(T2) + 121_000), isStaffPending(r1p, Date.parse(T2) + 121_000)],
  [{ tone: 'bad', text: '담당자 메일: 중단됨 — 처리 시간 안에 끝나지 못했습니다. 다시 보내 주세요' }, false]);
// 결과 기록의 이전 값은 '보내는 중'이 아니라 읽어 둔 행의 값(r1)이다 — 확인 메일과 같은 순서
const r2 = staffRecord(r1, { status: 'sent', reason: null, by: 'admin', at: T2 });
eq('기록: 관리자 성공', JSON.parse(r2), { status: 'sent', reason: null, by: 'admin', at: T2, n: 2, sentAt: T2, sentN: 1 });
eq('라벨: 관리자 성공', staffMailLabel(r2), { tone: 'ok', text: '담당자 메일: 보냄 · 2099-12-31 16:50 · 다시 보냄' });
eq('버튼: 보낸 적 있음', staffSentBefore(r2), true);
const r3 = staffRecord(r2, { status: 'failed', reason: 'auth_failed', by: 'admin', at: T3 });
eq('기록: 나중 실패도 보낸 사실 유지', JSON.parse(r3), { status: 'failed', reason: 'auth_failed', by: 'admin', at: T3, n: 3, sentAt: T2, sentN: 1 });
eq('라벨: 나중 실패 + 앞서 보냄', staffMailLabel(r3),
  { tone: 'bad', text: `담당자 메일: 실패 — ${ACK_REASON_KO.auth_failed} · 2099-12-31 17:00 (앞서 2099-12-31 16:50 에 보냄)` });
eq('버튼: 나중에 실패해도 [다시 보내기]', staffSentBefore(r3), true);
eq('라벨: 자동 성공(다시 보냄 없음)', staffMailLabel(staffRecord(null, { status: 'sent', by: 'auto', at: T1 })), { tone: 'ok', text: '담당자 메일: 보냄 · 2099-12-31 16:15' });
eq('라벨: 기록 없는 옛 접수 건을 관리자가 처음 보냄(다시 보냄 없음)', staffMailLabel(staffRecord(null, { status: 'sent', by: 'admin', at: T2 })).text, '담당자 메일: 보냄 · 2099-12-31 16:50');
eq('라벨: 안 보냄 사유(전용 3종)', ['disabled', 'bad_config', 'blocked_build'].map((reason) => staffMailLabel(staffRecord(null, { ...staffStatusOf({ sent: false, reason }), by: 'auto', at: T1 }))),
  [{ tone: 'muted', text: '담당자 메일: 안 보냄 — 받는 주소(INQUIRY_NOTIFY_TO) 미설정' },
    { tone: 'bad', text: '담당자 메일: 실패 — 받는 주소 모양이 이상함 · 2099-12-31 16:15' },
    { tone: 'muted', text: '담당자 메일: 안 보냄 — 테스트 빌드라 보내지 않음' }]);
eq('사유 한글: 공통 사유는 확인 메일 것 그대로', [STAFF_REASON_KO.fetch_error, STAFF_REASON_KO.http_error, STAFF_REASON_KO.no_credentials, STAFF_REASON_KO.error],
  [ACK_REASON_KO.fetch_error, ACK_REASON_KO.http_error, ACK_REASON_KO.no_credentials, ACK_REASON_KO.error]);
eq('라벨: 모르는 사유는 그대로 · 기록 없음은 null', [staffMailLabel(staffRecord(null, { status: 'failed', reason: 'weird', by: 'auto', at: T1 })).text, staffMailLabel(null), staffMailLabel('{깨짐'), parseStaffMail('')],
  ['담당자 메일: 실패 — weird · 2099-12-31 16:15', null, null, null]);
// 실행 위치(colo) · 토큰 단계 실패 사유(11-27)
eq('상태 판정: token_unreachable 은 실패', staffStatusOf({ sent: false, reason: 'token_unreachable' }), { status: 'failed', reason: 'token_unreachable' });
{
  const rc = staffRecord(null, { status: 'failed', reason: 'token_unreachable', by: 'auto', at: T1, colo: 'HKG' });
  eq('기록: 실패 기록에 실행 위치', JSON.parse(rc), { status: 'failed', reason: 'token_unreachable', by: 'auto', at: T1, n: 1, sentAt: null, sentN: 0, colo: 'HKG' });
  eq('라벨: 실패 줄 끝에 실행 위치 · 새 사유 문구', staffMailLabel(rc),
    { tone: 'bad', text: '담당자 메일: 실패 — 구글 인증 서버가 응답하지 않거나 오류를 냈습니다 — 메일은 나가지 않았습니다(다시 보내면 됩니다) · 2099-12-31 16:15 · 실행 위치 HKG' });
  eq('기록: 실행 위치가 없거나 이상하면 키를 넣지 않는다(옛 기록과 같은 모양)', [null, undefined, '', 'hkg', 'HKG1'].map((colo) => 'colo' in JSON.parse(staffRecord(null, { status: 'failed', reason: 'error', by: 'auto', at: T1, colo }))), Array(5).fill(false));
  eq('라벨: 실행 위치 없는 옛 기록은 그대로', staffMailLabel(JSON.stringify({ status: 'failed', reason: 'auth_failed', by: 'auto', at: T1, n: 1, sentAt: null, sentN: 0 })).text,
    `담당자 메일: 실패 — ${ACK_REASON_KO.auth_failed} · 2099-12-31 16:15`);
  const sentC = staffRecord(rc, { status: 'sent', by: 'admin', at: T2, colo: 'NRT' });
  eq('라벨: 성공 줄에는 실행 위치를 붙이지 않는다(기록에는 남는다)', [JSON.parse(sentC).colo, staffMailLabel(sentC).text], ['NRT', '담당자 메일: 보냄 · 2099-12-31 16:50 · 다시 보냄']);
  const later = staffRecord(sentC, { status: 'failed', reason: 'fetch_error', by: 'admin', at: T3, colo: 'HKG' });
  eq('라벨: 앞서 보낸 사실 뒤 · 줄 맨 끝에 실행 위치', staffMailLabel(later).text,
    `담당자 메일: 실패 — ${ACK_REASON_KO.fetch_error} · 2099-12-31 17:00 (앞서 2099-12-31 16:50 에 보냄) · 실행 위치 HKG`);
}
const recordTests = total - base1;

// ⑩ 발송 + 기록 순서(staffNotifyRecorded) — 가짜 통로. 자동 실패는 구글챗 알림, 관리자 실패는 알림 없음
const base2 = total;
async function recorded(opts) {
  const calls = { readTo: 0, send: 0, alert: [], writes: [], order: [] };
  let tick = 0;
  const r = await staffNotifyRecorded({
    by: opts.by, prev: opts.prev ?? null, now: () => `2099-12-31T07:15:0${++tick}.000Z`,
    write: opts.noDb ? null : async (json) => { calls.order.push('write'); calls.writes.push(JSON.parse(json)); if (opts.writeThrows) throw new Error('x'); },
    live: opts.live ?? true, id: 'INQ-20991231-TEST', isSafeAddress,
    readTo: () => { calls.readTo++; return opts.to ?? TO; },
    send: async () => { calls.order.push('send'); calls.send++; if (opts.sendThrows) throw new Error('x'); return opts.result ?? { sent: true, reason: 'ok' }; },
    alert: async (t) => { calls.alert.push(t); },
    ...(opts.colo === undefined ? {} : { colo: opts.colo }),
  });
  return { r, calls };
}
{
  // 토큰 단계 실패(11-27) — 자동 발송이면 알림이 나가고, 기록·알림에 실행 위치가 붙는다
  const { r, calls } = await recorded({ by: 'auto', result: { sent: false, reason: 'token_unreachable' }, colo: 'HKG' });
  eq('자동 + token_unreachable → 알림 1번(실행 위치 포함)', [r, calls.alert],
    [{ sent: false, reason: 'token_unreachable', status: 'failed' }, ['⚠️ 담당자 알림 메일 발송 실패 — 접수번호 INQ-20991231-TEST (token_unreachable · 실행 위치 HKG). 관리자 화면에서 확인해 주세요.']]);
  eq("자동 + token_unreachable → '보내는 중'·결과 기록 모두 실행 위치", calls.writes.map((w) => `${w.status}:${w.reason}:${w.colo}`), ['pending:null:HKG', 'failed:token_unreachable:HKG']);
  const admin = await recorded({ by: 'admin', result: { sent: false, reason: 'token_unreachable' }, colo: 'NRT' });
  eq('관리자 + token_unreachable → 알림 없음 · 기록에 실행 위치', [admin.calls.alert.length, admin.calls.writes.at(-1)?.reason, admin.calls.writes.at(-1)?.colo], [0, 'token_unreachable', 'NRT']);
  const none = await recorded({ by: 'auto', result: { sent: false, reason: 'token_unreachable' } });
  eq('실행 위치를 못 읽어도 발송·기록·알림은 그대로(키 없음)', [none.r.reason, none.calls.alert.length, none.calls.writes.map((w) => 'colo' in w)], ['token_unreachable', 1, [false, false]]);
}
{
  const { r, calls } = await recorded({ by: 'auto', result: { sent: false, reason: 'fetch_error' } });
  eq('자동 실패 → 구글챗 알림 1번', [r, calls.alert.length, calls.alert[0]?.includes('INQ-20991231-TEST (fetch_error)')],
    [{ sent: false, reason: 'fetch_error', status: 'failed' }, 1, true]);
  eq("자동 실패 → 기록 2번('보내는 중' → 발송 → 결과)", [calls.order, calls.writes.map((w) => `${w.status}:${w.reason}:${w.by}:${w.n}`)],
    [['write', 'send', 'write'], ['pending:null:auto:0', 'failed:fetch_error:auto:1']]);
  // 그 기록 위에서 관리자가 다시 보내 성공
  const prev = JSON.stringify(calls.writes[1]);
  const again = await recorded({ by: 'admin', prev });
  eq('관리자 성공 → n·sentAt·sentN', [again.r, again.calls.writes.map((w) => [w.status, w.by, w.n, w.sentN, w.sentAt])],
    [{ sent: true, reason: 'ok', status: 'sent' }, [['pending', 'admin', 1, 0, null], ['sent', 'admin', 2, 1, '2099-12-31T07:15:02.000Z']]]);
  eq('관리자 성공 → 라벨', staffMailLabel(JSON.stringify(again.calls.writes[1])).text, '담당자 메일: 보냄 · 2099-12-31 16:15 · 다시 보냄');
}
for (const reason of ['fetch_error', 'http_error', 'auth_failed', 'error']) {
  const { r, calls } = await recorded({ by: 'admin', result: { sent: false, reason } });
  eq(`관리자 실패(${reason}) → 구글챗 알림 없음 · 기록은 남음`, [r.status, calls.alert.length, calls.writes.at(-1)?.status, calls.writes.at(-1)?.by], ['failed', 0, 'failed', 'admin']);
}
{
  const { r, calls } = await recorded({ by: 'admin', to: 'not-an-address' });
  eq('관리자 + 주소 모양 틀림 → 알림 없음 · 실패 기록 1번(발송 없음)', [r.reason, r.status, calls.send, calls.alert.length, calls.writes.map((w) => w.status)], ['bad_config', 'failed', 0, 0, ['failed']]);
}
{
  const { r, calls } = await recorded({ by: 'auto', to: 'not-an-address' });
  eq('자동 + 주소 모양 틀림 → 알림 1번(기존과 같음)', [r.reason, calls.alert.length], ['bad_config', 1]);
}
{
  const { r, calls } = await recorded({ by: 'auto', live: false });
  eq("테스트 빌드 → 주소 읽기·발송 없음 · '안 보냄' 기록 1번", [r, calls.readTo, calls.send, calls.alert.length, calls.writes.map((w) => `${w.status}:${w.reason}`)],
    [{ sent: false, reason: 'blocked_build', status: 'skipped' }, 0, 0, 0, ['skipped:blocked_build']]);
}
{
  const { r, calls } = await recorded({ by: 'auto', to: '' });
  eq("받는 주소 미설정 → '안 보냄' 기록 1번 · 알림 없음", [r.status, r.reason, calls.send, calls.alert.length, calls.writes.map((w) => `${w.status}:${w.reason}:${w.n}`)],
    ['skipped', 'disabled', 0, 0, ['skipped:disabled:1']]);
}
{
  const { r, calls } = await recorded({ by: 'auto' });
  eq('자동 성공 → 기록 2번 · 알림 없음', [r, calls.alert.length, calls.writes.map((w) => [w.status, w.n, w.sentN])], [{ sent: true, reason: 'ok', status: 'sent' }, 0, [['pending', 0, 0], ['sent', 1, 1]]]);
}
{
  const { r, calls } = await recorded({ by: 'auto', noDb: true });
  eq('접수 행이 저장되지 않은 접수 → 기록 생략 · 발송은 그대로', [r.status, calls.send, calls.writes.length], ['sent', 1, 0]);
}
{
  const { r, calls } = await recorded({ by: 'auto', writeThrows: true });
  eq('기록 실패는 발송 결과에 영향 없음(던지지 않음)', [r, calls.send], [{ sent: true, reason: 'ok', status: 'sent' }, 1]);
}
{
  const { r, calls } = await recorded({ by: 'auto', sendThrows: true });
  eq('발송 예외 → error 기록 + 알림(자동)', [r.status, r.reason, calls.alert.length, calls.writes.at(-1)?.reason], ['failed', 'error', 1, 'error']);
}
const flowTests = total - base2;

// 실행부·API 원문 검사 — 기록 컬럼 · 관리자 발송 통로 · 받는 주소 값은 밖으로 내지 않는다
const base3 = total;
const rec = readFileSync('src/lib/staff-notify-record.js', 'utf8');
const api = readFileSync('src/pages/api/admin/staff-mail.ts', 'utf8');
const inq = readFileSync('src/pages/api/inquiry.ts', 'utf8');
eq('실행부: 기록은 inquiries.staff_mail 한 문장', (run.match(/UPDATE inquiries SET staff_mail = \?/g) ?? []).length, 1);
eq('실행부: 판정·기록은 staffNotifyRecorded 로', /staffNotifyRecorded\(/.test(run), true);
eq('실행부: 설정 여부만 내보낸다(boolean)', /export function staffNotifyConfigured\(\): boolean/.test(run), true);
eq('API: 관리자 확인 · 발송은 runStaffNotify(by admin) 로만', [/isAdmin\(request\)/.test(api), /runStaffNotify\(input, \{ d, by: 'admin'/.test(api), /\bfetch\s*\(/.test(api), /sendMail|sendChat/.test(api)], [true, true, false, false]);
eq('API: 보내는 중이면 409', /isStaffPending\(row\.staff_mail\)\) return json\(\{ ok: false, error: 'in_progress' \}, 409\)/.test(api), true);
eq('API: 없는 접수는 404 · 접수번호 형식 검사', [api.includes("error: 'not_found' }, 404"), api.includes('/^INQ-\\d{8}-[A-Z0-9]{4}$/')], [true, true]);
eq('접수: 자동 발송은 저장된 DB 와 by auto 를 넘긴다', /\{ d: rowDb, by: 'auto' \}/.test(inq), true);
eq('새 파일에 메일 주소 없음(기록·API)', [ADDR_RE.test(rec), ADDR_RE.test(api)], [false, false]);
eq('접수·관리자: 실행 위치와 토큰 설정은 셋째 인자로', [/\{ d: rowDb, by: 'auto' \}, \{ colo, token: mailTokenOf\(siteSettings\) \}/.test(inq), /\{ colo: requestColo\(request\), token \}\)/.test(api)], [true, true]);
eq('실행부: 실행 위치·토큰 설정을 발송 통로로 넘긴다', run.includes('{ tag: TAG, ref: p.id, origin: p.origin, colo: ctx.colo, token: ctx.token }'), true);
eq('접수: 설정을 다시 읽지 않는다(readSiteSettings 한 번) · 관리자 담당자 메일은 한 번 읽는다', [(inq.match(/readSiteSettings\(/g) ?? []).length, (api.match(/readSiteSettings\(/g) ?? []).length], [1, 1]);
const srcTests = total - base3;

if (failed) {
  console.error(`\n담당자 알림 메일 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 담당자 알림 메일 — ${total}건 통과 · 테스트 빌드는 발송·주소 읽기 없음 · 행→입력 ${rowTests}건 · 기록·라벨 ${recordTests}건 · 발송+기록 순서 ${flowTests}건 · 원문 ${srcTests}건`);
