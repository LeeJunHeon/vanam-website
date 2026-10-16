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

if (failed) {
  console.error(`\n담당자 알림 메일 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 담당자 알림 메일 — ${total}건 통과 · 테스트 빌드는 발송·주소 읽기 없음`);
