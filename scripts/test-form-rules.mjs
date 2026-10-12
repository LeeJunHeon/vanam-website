// scripts/test-form-rules.mjs — 고객 폼 공통 규칙 시험 (2026-10-12)
//   · 이메일 규칙(email-rule.js) — 화면과 서버가 같은 파일을 쓴다
//   · 구글챗 알림 본문 — 고객 글의 꺾쇠 문법 무력화 · 긴 본문 줄이기(보통 글은 바이트 그대로)
//   · 안내 문구 — 한·영 모두 있고, 자리표시({n}·{email}·{min})가 맞다
import { readFileSync } from 'node:fs';
import { isEmail, EMAIL_RE } from '../src/lib/email-rule.js';
import { buildInquiryChatText, CHAT_BODY_MAX } from '../src/lib/chat-message.js';

let pass = 0;
const fails = [];
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

// ── 이메일 규칙 ─────────────────────────────────────
for (const ok of ['a@b.co', 'kim.hong+qa@naver.com', '  a@b.co  ', 'x@sub.domain.co.kr', 'hello@vanam.co.kr'])
  eq(`이메일 통과: ${ok}`, isEmail(ok), true);
for (const no of ['kim@navercom', 'kim@naver', 'a b@c.d', 'a@b c.d', '@b.co', 'a@.', '', '   ', 'a@@b.co', null, undefined, 42])
  eq(`이메일 거절: ${String(no)}`, isEmail(no), false);
eq('정규식 모양(서버와 같은 규칙)', EMAIL_RE.source, '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$');

// ── 구글챗 알림 본문 ─────────────────────────────────
{
  const base = { type: 'general', who: '담당: 홍길동 (반암) · a@b.co', message: '두께 100nm 문의', meta: '접수번호 INQ-20261012-AAAA · ko · 2026-10-12 (KST)' };
  eq('보통 글은 그대로', buildInquiryChatText(base), ['✉️ *새 문의*', base.who, `내용: ${base.message}`, base.meta].join('\n'));
  const evil = buildInquiryChatText({ ...base, who: '담당: <users/all>', message: '<https://evil.example|송장 확인>' });
  eq('꺾쇠 문법 무력화(전원 호출·가짜 링크)', /[<>]/.test(evil), false);
  eq('꺾쇠는 전각으로 남는다', evil.includes('＜users/all＞') && evil.includes('＜https://evil.example|송장 확인＞'), true);
  const long = buildInquiryChatText({ ...base, message: '가'.repeat(CHAT_BODY_MAX + 500) });
  eq('긴 문의 본문은 상한에서 줄인다', long.includes('이하 생략') && long.length < CHAT_BODY_MAX + 300, true);
  eq('줄여도 마지막 줄(접수번호)은 남는다', long.endsWith(base.meta), true);
  const q = buildInquiryChatText({ type: 'quote', productName: '다층 박막', product: 'multilayers', who: base.who, substrate: 'Si', sampleCount: '1', details: '나'.repeat(CHAT_BODY_MAX + 10), meta: base.meta });
  eq('긴 견적 본문도 줄인다', q.includes('이하 생략') && q.endsWith(base.meta), true);
}

// ── 안내 문구(site.json) ─────────────────────────────
{
  const site = JSON.parse(readFileSync(new URL('../src/data/site.json', import.meta.url), 'utf8'));
  for (const lang of ['ko', 'en']) {
    const f = site[lang].contact.form;
    const q = site[lang].quote.form;
    for (const k of ['fail', 'rateLimited', 'captcha', 'tooLong', 'check']) eq(`${lang} contact.form.errors.${k} 있음`, typeof f.errors?.[k] === 'string' && f.errors[k].length > 5, true);
    eq(`${lang} rateLimited 에 {min}`, f.errors.rateLimited.includes('{min}'), true);
    eq(`${lang} fail 에 {email}`, f.errors.fail.includes('{email}'), true);
    eq(`${lang} msgCaptcha 에 {email}(보안 확인이 안 뜨는 회사망 대비)`, f.msgCaptcha.includes('{email}'), true);
    for (const k of ['msgSeqProcess', 'msgSeqMaterial', 'msgSeqValue']) eq(`${lang} quote.form.${k} 에 {n}`, q[k].includes('{n}'), true);
    eq(`${lang} 영문 단계 문구에 'st step' 없음`, /\dst step|^st step/.test(q.msgSeqProcess), false);
    for (const k of ['msgOtherEmpty', 'msgMaxRows']) eq(`${lang} quote.form.${k} 있음`, typeof q[k] === 'string' && q[k].length > 5, true);
  }
}

// ── 입력칸 안내 문구 — 전역 스크립트(BaseLayout)와 공통 규칙(form-check.ts)이 글자 그대로 같다 ──
//    (BaseLayout 은 모든 페이지에 붙어 성능 때문에 import 하지 않고 같은 표를 따로 든다)
{
  const pairs = (block) => Object.fromEntries([...block.matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));
  const base = readFileSync(new URL('../src/layouts/BaseLayout.astro', import.meta.url), 'utf8');
  const fc = readFileSync(new URL('../src/lib/form-check.ts', import.meta.url), 'utf8');
  const bKo = pairs(base.match(/const V_KO = \{([\s\S]*?)\};/)?.[1] ?? '');
  const bEn = pairs(base.match(/const V_EN = \{([\s\S]*?)\};/)?.[1] ?? '');
  const fKo = pairs(fc.match(/\bko: \{([\s\S]*?)\},/)?.[1] ?? '');
  const fEn = pairs(fc.match(/\ben: \{([\s\S]*?)\},/)?.[1] ?? '');
  eq('안내 문구 표(한) 9개', Object.keys(fKo).length, 9);
  eq('BaseLayout·form-check 안내 문구(한) 같음', bKo, fKo);
  eq('BaseLayout·form-check 안내 문구(영) 같음', bEn, fEn);
  eq('BaseLayout 은 form-check 를 import 하지 않는다(모든 페이지 성능)', /from '\.\.\/lib\/form-check'/.test(base), false);
}

// ── 결제 페이지 오류 문구(한·영 각각 같은 열쇠) ─────────
{
  const t = readFileSync(new URL('../src/components/pages/Checkout.astro', import.meta.url), 'utf8');
  for (const k of ['missing_city', 'missing_address', 'missing_recipient', 'missing_country', 'missing_tax', 'invalid_biz_no', 'invalid_tax_email', 'rate_limited', 'bad_amount', 'items', 'fail', 'quote_checkout_closed'])
    eq(`결제 오류 문구 ${k} 한·영 2곳`, (t.match(new RegExp(`^\\s+${k}: '`, 'gm')) ?? []).length, 2);
  eq('한 줄에 한·영이 섞인 옛 문구 없음', / · Check buyer name and email\./.test(t), false);
}

if (fails.length) {
  console.error(`✗ 폼 공통 규칙 — ${fails.length}건 실패`);
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ 폼 공통 규칙(이메일·알림 본문·안내 문구) — ${pass}건 통과`);
