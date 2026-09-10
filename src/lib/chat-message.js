// 구글챗 알림 본문 조립 — 순수 함수.
//
// 왜 파일로 뺐나: 예전에는 이 템플릿이 api/inquiry.ts 안에 인라인으로 있었다.
// 그래서 알림 문구를 확인하려면 **실제로 제출해 실제 채팅방에 메시지를 쏘는 수밖에** 없었고,
// 폼 항목을 늘릴 때마다 담당자 채팅방에 테스트 알림이 쌓였다.
// 순수 함수로 빼두면 node 로 직접 호출해 최종 텍스트를 확인할 수 있다(제출 없음).
//
// ⚠️ .js 인 이유는 material-value.js·quote-fields.js 와 같다 —
//    Astro(.ts)와 node 스크립트가 빌드 없이 같은 파일을 import 해야 한다.
//
// ⚠️ 문구·줄 구성은 옮기기 전과 **바이트 단위로 같아야 한다**. 담당자가 이 형식에 익숙하고,
//    줄이 바뀌면 과거 알림과 대조가 안 된다.

const DASH = '—';

/**
 * 견적/문의 알림 본문.
 *
 * @param {{
 *   type: 'quote' | 'general',
 *   productName?: string,
 *   product?: string,
 *   who: string,            // "담당: 이름 (회사) · 이메일 · 전화" — 호출부가 만든다
 *   substrate?: string,
 *   sampleCount?: string,
 *   details?: string,
 *   message?: string,
 *   waferLine?: string,
 *   meta: string,           // "접수번호 … · locale · KST"
 * }} p
 * @returns {string}
 */
export function buildInquiryChatText(p) {
  if (p.type === 'quote') {
    return [
      '📩 *새 견적 요청*',
      `상품: ${p.productName ?? ''} (${p.product ?? ''})`,
      p.who,
      `기판: ${p.substrate || DASH} | 총 샘플: ${p.sampleCount || DASH}`,
      // ⚠️ 예전 견적 폼의 '두께·수량·납기' 줄은 뺐다. 지금 폼에는 그 항목이 없어서
      //    **항상 `두께: — | 수량: — | 납기: —`** 로만 찍혔다(실제 입력값이 아니다).
      //    같은 정보는 아래 요청 본문에 '총 샘플 수량'·'완료 희망일'로 이미 들어 있다.
      `\n${p.details || DASH}`,
      p.meta,
    ].filter(Boolean).join('\n');
  }
  // 웨이퍼 문의면 상품·수량·다이싱을 별도 줄로 먼저 보여준다(본문에도 같은 내용이 들어 있지만
  // 담당자가 목록에서 한눈에 구분할 수 있어야 한다).
  return ['✉️ *새 문의*', p.who, p.waferLine, `내용: ${p.message ?? ''}`, p.meta]
    .filter(Boolean).join('\n');
}
