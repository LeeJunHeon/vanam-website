// scripts/check-paypal-ui.mjs — 주문 완료·조회 화면의 PayPal 캡처 처리 정적 검사(소스)
//
// 두 화면(OrderDone.astro · OrderLookup.astro)에서:
//   · /api/paypal/capture 요청 본문에 ref 가 들어간다(서버가 캡처 전에 이미 결제·오래된 결제창·결제 불가를 가린다 — 없으면 캡처하지 않고 bad_request)
//   · 캡처 전 거절 코드(stale_order·already_paid·not_payable·bad_request)와 duplicate_payment 를 따로 처리한다
//   · mStale 한/영 문구가 있다
// OrderDone 은 .catch 의 mApproved('승인 완료·확정 중') 덮어쓰기 예외 목록에 새 코드가 다 있어야 한다
//   (돈이 빠지지 않은 경우에 '승인 완료' 안내가 뜨면 안 된다).
import { readFileSync } from 'node:fs';

const KO = '다른 창에서 결제가 새로 시작되었습니다. 이 화면을 새로고침한 뒤 다시 결제해 주세요.';
const EN = 'A new payment was started in another window. Please refresh this page and try again.';
const CODES = ['stale_order', 'already_paid', 'not_payable', 'bad_request', 'duplicate_payment'];
const errs = [];

for (const [file, refExpr] of [['src/components/pages/OrderDone.astro', 'host.dataset.ref'], ['src/components/pages/OrderLookup.astro', 'wrap.dataset.ref']]) {
  const src = readFileSync(file, 'utf8');
  const name = file.split('/').pop();
  // capture 요청 — fetch('/api/paypal/capture', …) 뒤 첫 body
  const at = src.indexOf("fetch('/api/paypal/capture'");
  if (at < 0) { errs.push(`${name}: /api/paypal/capture 요청을 찾지 못함`); continue; }
  const body = /body:\s*JSON\.stringify\(\{([^}]*)\}\)/.exec(src.slice(at, at + 600))?.[1] ?? '';
  if (!new RegExp(`\\bref:\\s*${refExpr.replace(/\./g, '\\.')}\\b`).test(body)) errs.push(`${name}: capture 요청 본문에 ref: ${refExpr} 가 없다 (본문: {${body.trim()}})`);
  // 응답 처리 — 이후 3000자 안(onApprove 블록)
  const handler = src.slice(at, at + 3500);
  for (const c of CODES) if (!handler.includes(`'${c}'`)) errs.push(`${name}: capture 응답 처리에 '${c}' 가 없다`);
  if (!src.includes(KO)) errs.push(`${name}: mStale 한글 문구가 없다`);
  if (!src.includes(EN)) errs.push(`${name}: mStale 영문 문구가 없다`);
  if (!/mStale/.test(handler)) errs.push(`${name}: stale_order 에 mStale 을 쓰지 않는다`);
}

// OrderDone .catch 덮어쓰기 예외 목록
{
  const src = readFileSync('src/components/pages/OrderDone.astro', 'utf8');
  const list = /var NO_OVERWRITE = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
  for (const c of ['capture_failed', ...CODES]) if (!list.includes(`'${c}'`)) errs.push(`OrderDone.astro: .catch 덮어쓰기 예외 목록(NO_OVERWRITE)에 '${c}' 가 없다`);
  if (!/NO_OVERWRITE\.indexOf\(m\) < 0[\s\S]{0,120}mApproved/.test(src)) errs.push('OrderDone.astro: .catch 가 NO_OVERWRITE 로 mApproved 덮어쓰기를 거르지 않는다');
}

if (errs.length) {
  for (const e of errs) console.error('  ✗', e);
  console.error(`\nPayPal 결제 화면 검사 실패 — ${errs.length}건.`);
  process.exit(1);
}
console.log(`✓ PayPal 결제 화면 — 완료·조회 2곳 · 캡처 요청에 ref · 거절 코드 ${CODES.length}종 처리 · mStale 한/영 · 완료 화면 mApproved 덮어쓰기 예외 목록`);
