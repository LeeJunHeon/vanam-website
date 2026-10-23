// scripts/test-ack-pdf-switch.mjs — 접수 확인 메일 'PDF 첨부' 운영 설정 스위치(ack_pdf_attach) 실행부 테스트
//
// src/lib/quote-ack-run.ts 를 esbuild(빌드 도구에 이미 들어 있는 것)로 묶되, 바깥과 닿는 모듈만 가짜로 바꿔 실제로 돌린다.
//   가짜: astro:content · db(nowIso) · mail-send(발송 기록만) · doc-pdf(호출 수만 센다) · quote-store · fx · price · chat-send · 로고 그림
//   진짜: quote-ack.js(문구·판정) · site-settings-db(설정 읽기 — 가짜 D1 로) · mail-mime · doc-excel · quote-revision 등
// 확인: ① 꺼짐(값 없음 = 기본 0 · 0) → 로고·PDF 렌더를 부르지 않는다 · pdf 'none:off' · 첨부 없음 · attachNone 문장
//       ② 켜짐(1) → 지금까지와 같다(PDF 한 번 · 'request' · 첨부 이름 · attachRequest 문장)
//       ③ 켜짐 + PDF 설정 없음 → 'none:no_credentials'(종전 그대로)
//       ④ 자동 발송·관리자 다시 보내기 모두 스위치를 따른다 · 운영 설정 읽기는 한 번(DB 읽기를 늘리지 않는다)
// 네트워크·비밀값 없이 돈다. 고객 정보는 가짜.
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachmentName } from '../src/lib/quote-ack.js';

let total = 0, failed = 0;
function eq(label, got, want) {
  total++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`  ✗ ${label}\n      기대: ${JSON.stringify(want)}\n      실제: ${JSON.stringify(got)}`);
  }
}

// ── 가짜 모듈 — 호출은 globalThis.__ack 에 기록한다 ─────────────────────────────
const STUBS = {
  'astro:content': `export const getCollection = async () => [];`,
  './db': `export const nowIso = () => new Date().toISOString();`,
  './mail-send': `export const MAIL_LIVE = false;
    export const gmailConfigured = () => true;
    export async function sendMail(m) { globalThis.__ack.mails.push(m); return { sent: true, reason: null }; }`,
  './doc-pdf': `export const pdfConfigured = () => globalThis.__ack.pdfConfigured;
    export async function logoDataUri() { globalThis.__ack.calls.logo++; return 'data:image/png;base64,AA=='; }
    export async function renderPdf() { globalThis.__ack.calls.render++; return { ok: true, bytes: new Uint8Array([37, 80, 68, 70]) }; }`,
  './quote-store': `export async function latestRevision() { return null; }`,
  './fx': `export async function readRate() { return { rate: 1400, updatedAt: null, source: 'test', mode: 'manual' }; }`,
  './price': `export const formatUsd = (n) => '$' + n;`,
  './chat-send': `export async function sendChat() { globalThis.__ack.chats++; return { sent: false }; }`,
  '../assets/brand/logo-light.png': `export default { src: '/logo-light.png' };`,
};

const dir = mkdtempSync(join(tmpdir(), 'ack-pdf-switch-'));
let runQuoteAck;
try {
  const out = join(dir, 'run.mjs');
  await build({
    entryPoints: [resolve('src/lib/quote-ack-run.ts')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    // processes.ts 의 소재 라이브러리 읽기(vite 전용) — 이 시험은 기판 크기·전달 방식 라벨만 쓴다
    define: { 'import.meta.glob': 'globalThis.__viteGlob' },
    plugins: [{
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => (a.path in STUBS && (a.path === 'astro:content' || a.importer.endsWith('quote-ack-run.ts'))
          ? { path: a.path, namespace: 'stub' } : undefined));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
      },
    }],
  });
  globalThis.__viteGlob = () => ({});
  ({ runQuoteAck } = await import(pathToFileURL(out).href));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── 가짜 D1 — 접수 행 한 건 · settings 표 · UPDATE 기록 ───────────────────────────
const ID = 'INQ-20261023-FAKE';
const row = () => ({
  id: ID, type: 'quote', name: '홍길동', email: 'tester@vanam.co.kr', company: '테스트대학교', locale: 'ko',
  product_name: '금속 박막', material: 'Ti', details: '[공정 순서]\n1. Sputter | Ti | 10nm',
  details_json: JSON.stringify({ seq: [{ process: 'Sputter', material: 'Ti', value: '10', unit: 'nm', etc: '' }], measures: [], delivery: 'direct',
    substrateType: 'Silicon', substrateSize: '4inch', substrateGrade: '', sampleCount: '1', preFilm: false, notes: '', completionDate: '' }),
  created_at: '2026-10-23T01:00:00.000Z', ack_mail: null,
});
function fakeDb(settingRows) {
  const log = { settingsReads: 0, updates: 0 };
  return {
    log,
    prepare(sql) {
      return {
        bind() { return this; },
        async first() { return /FROM inquiries WHERE id = \?/.test(sql) && !/SUM\(/.test(sql) ? row() : null; },
        async all() {
          if (/FROM settings/.test(sql)) { log.settingsReads++; return { results: settingRows }; }
          return { results: [] };
        },
        async run() { if (/^UPDATE inquiries/.test(sql.trim())) log.updates++; return {}; },
      };
    },
  };
}

/** 한 번 돌리고 결과·호출 수·보낸 메일 */
async function runWith({ settingRows, by = 'admin', pdfConfigured = true }) {
  globalThis.__ack = { calls: { logo: 0, render: 0 }, mails: [], chats: 0, pdfConfigured };
  const d = fakeDb(settingRows);
  // 실행부의 한 줄 로그는 이 시험에서 숨긴다(결과는 반환값으로 본다)
  const { log, warn } = console;
  console.log = console.warn = () => {};
  let r;
  try { r = await runQuoteAck(d, ID, { by, origin: 'http://localhost:4321', verified: true }); } finally { console.log = log; console.warn = warn; }
  const m = globalThis.__ack.mails[0] ?? null;
  return { r, calls: { ...globalThis.__ack.calls }, mail: m, settingsReads: d.log.settingsReads };
}

const NONE = '견적 요청서는 아래 조회 화면에서 인쇄하거나 PDF로 저장하실 수 있습니다.';
const REQ = '접수하신 내용을 정리한 견적 요청서(PDF)를 첨부해 드립니다.';

// ① 꺼짐 — 값 없음(배포 직후) · 0 · 이상한 값(2 → 기본값 0)
for (const [label, rows] of [['값 없음(기본)', []], ['0', [{ key: 'ack_pdf_attach', value: 0 }]], ['범위 밖 2 → 기본 끔', [{ key: 'ack_pdf_attach', value: 2 }]]]) {
  for (const by of ['admin', 'auto']) {
    const o = await runWith({ settingRows: rows, by });
    eq(`꺼짐(${label}, ${by}): 보냄 · pdf none:off`, [o.r.status, o.r.pdf], ['sent', 'none:off']);
    eq(`꺼짐(${label}, ${by}): 로고·PDF 렌더 호출 0번`, o.calls, { logo: 0, render: 0 });
    eq(`꺼짐(${label}, ${by}): 첨부 없음`, o.mail?.attachments, []);
    eq(`꺼짐(${label}, ${by}): 본문 attachNone 문장 + 조회 링크 · 첨부 문장 없음`,
      [o.mail?.text.includes(NONE), o.mail?.text.includes('/ko/order/lookup?id='), o.mail?.text.includes(REQ)], [true, true, false]);
    eq(`꺼짐(${label}, ${by}): 운영 설정 읽기 1번`, o.settingsReads, 1);
  }
}

// ② 켜짐 — 지금까지 동작 그대로
for (const by of ['admin', 'auto']) {
  const o = await runWith({ settingRows: [{ key: 'ack_pdf_attach', value: 1 }], by });
  eq(`켜짐(${by}): 보냄 · pdf request`, [o.r.status, o.r.pdf], ['sent', 'request']);
  eq(`켜짐(${by}): 로고·PDF 렌더 각 1번`, o.calls, { logo: 1, render: 1 });
  eq(`켜짐(${by}): 첨부 1개 · 이름 · 종류`, (o.mail?.attachments ?? []).map((a) => [a.filename, a.contentType, a.bytes.length]),
    [[attachmentName('ko', ID, false), 'application/pdf', 4]]);
  eq(`켜짐(${by}): 본문 attachRequest 문장`, [o.mail?.text.includes(REQ), o.mail?.text.includes(NONE)], [true, false]);
  eq(`켜짐(${by}): 운영 설정 읽기 1번`, o.settingsReads, 1);
}

// ③ 켜짐 + PDF 설정 없음 → 종전 그대로
{
  const o = await runWith({ settingRows: [{ key: 'ack_pdf_attach', value: 1 }], pdfConfigured: false });
  eq('켜짐·PDF 설정 없음: none:no_credentials · 렌더 0번 · 첨부 없음 · attachNone',
    [o.r.pdf, o.calls.render, o.mail?.attachments, o.mail?.text.includes(NONE)], ['none:no_credentials', 0, [], true]);
}

// ④ 회신 기한도 같은 한 번의 읽기에서
{
  const o = await runWith({ settingRows: [{ key: 'ack_pdf_attach', value: 0 }, { key: 'reply_business_days', value: 5 }] });
  eq('회신 기한 설정값이 본문에(같은 읽기)', [o.mail?.text.includes('영업일 기준 5일'), o.settingsReads], [true, 1]);
}

if (failed) {
  console.error(`\n확인 메일 PDF 첨부 스위치 테스트 실패 — ${failed}/${total}건.`);
  process.exit(1);
}
console.log(`✓ 확인 메일 PDF 첨부 스위치(quote-ack-run) — ${total}건 통과 · 꺼짐(기본)이면 PDF 렌더 0번·none:off · 켜짐은 종전과 같음 · 설정 읽기 1번`);
