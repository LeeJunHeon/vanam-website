// 견적 테스트 모드 켜짐/꺼짐 — **빌드 시점에** 정한다. (빌드 설정 전용 — 런타임 코드는 import 금지)
//
// 고객 견적 폼의 "예상 견적 보기"는 원가·계산 내역을 그대로 보여주는 내부 검증용이다.
// 실제 사이트에 나가면 안 되므로 구글챗 차단(chat-mode.js)과 같은 방식으로 빌드가 정한다:
//   - npm run local 빌드(VANAM_QUOTE_TEST=1)만 켜짐
//   - 일반 빌드·Cloudflare 빌드는 꺼짐. Cloudflare 빌드에 VANAM_QUOTE_TEST 가 있으면 빌드를 멈춘다.
//
// ⚠️ 켜짐 표식 문자열은 이 파일에만 둔다. 런타임 파일에 있으면 번들 안의 표식으로
//    켜짐/꺼짐을 판정할 수 없게 된다(scripts/check-quote-test-mode.mjs 가 막는다).

export const QUOTE_TEST_ON = 'QUOTE_TEST_ON';
export const QUOTE_TEST_OFF = 'QUOTE_TEST_OFF';

/**
 * @param {Record<string, string | undefined>} env 보통 process.env
 * @returns {'QUOTE_TEST_ON' | 'QUOTE_TEST_OFF'}
 * @throws Cloudflare 빌드(WORKERS_CI=1)에 VANAM_QUOTE_TEST 가 설정돼 있을 때
 */
export function quoteTestModeAtBuild(env) {
  if (env?.WORKERS_CI === '1') {
    if (env?.VANAM_QUOTE_TEST !== undefined) {
      throw new Error('Cloudflare 빌드에서는 견적 테스트 모드를 켤 수 없습니다');
    }
    return QUOTE_TEST_OFF;
  }
  return env?.VANAM_QUOTE_TEST === '1' ? QUOTE_TEST_ON : QUOTE_TEST_OFF;
}
