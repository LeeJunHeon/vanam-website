// 이메일 주소 규칙 — 서버(api/inquiry·api/order)와 화면(견적·문의·주문 폼)이 **같은 규칙**을 쓴다 (2026-10-12).
//
// 왜 한 곳인가: 예전에는 서버만 '도메인에 점(.)이 있어야 한다'를 검사하고, 화면은 브라우저 기본
// 검사(type=email)만 했다. 브라우저는 `kim@navercom` 을 통과시키므로 고객은 보내기를 누른 뒤
// 원인을 알 수 없는 '전송 실패'만 보았고, 실패한 시도도 접수 횟수 제한(IP당 10분 5회)에 들어가
// 주소를 고쳐도 한동안 계속 막혔다.
//
// ⚠️ .js 인 이유: 서버(.ts)·화면 스크립트·node 검증 스크립트가 빌드 없이 같은 파일을 import 한다.

/** 공백·@ 없는 앞부분 @ 공백·@ 없는 도메인(점 1개 이상) */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 이메일 주소 모양인가 (앞뒤 공백은 무시한다).
 * @param {unknown} v
 * @returns {boolean}
 */
export function isEmail(v) {
  return typeof v === 'string' && EMAIL_RE.test(v.trim());
}
