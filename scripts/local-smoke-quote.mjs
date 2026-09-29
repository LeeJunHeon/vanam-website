// npm run smoke:quote — 자동 견적 로컬 점검 (npm run local 로 띄운 127.0.0.1:8787 전용)
//
// 확인하는 것:
//   A. 스위치 켜짐 · 계산 가능한 공정 → 예상 견적 estimate · 접수 시 개정 저장 · 조회에 견적서(doc)
//   B. 스위치 켜짐 · 담당자 확인 공정(장비 후보 여럿 + 분석) → manual · 조회 reviewing · doc 없음
//   C. 스위치 꺼짐 → GET enabled false · POST 404 · 조회 quote null
//   + 고객 응답(예상 견적·조회)에 금지 키·실제 ID 문자열 0건 · 저장소 파일에 실제 ID 문자열 0건
//
// ⚠️ 실제 금액·레시피/장비/기판 ID 를 이 파일에 적지 않는다. ID 목록은 런타임에 관리자 API 에서 받아
//    "나오면 안 되는 문자열"로만 쓰고, 화면에는 개수만 찍는다. 결과는 터미널에만 출력한다(파일로 쓰지 않음).
// ⚠️ 운영 스위치는 끝나면 성공·실패와 상관없이 원래 상태로 되돌린다.
// ⚠️ 로컬 빌드는 구글챗이 차단돼야 한다 — 접수 응답이 delivered:true 면 즉시 멈춘다.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FORBIDDEN_CUSTOMER_KEYS } from '../src/lib/quote-customer.js';
import { VIEW_FORBIDDEN_KEYS } from '../src/lib/quote-revision.js';

const BASE = 'http://127.0.0.1:8787';
if (process.env.WORKERS_CI) { console.error('✗ WORKERS_CI 환경에서는 실행하지 않습니다(로컬 전용).'); process.exit(1); }

class Stop extends Error {}
const results = [];
const pass = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

let cookie = '';
async function call(method, path, body, { admin = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Origin: BASE,
      ...(admin && cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) throw new Stop(`${path}: 레이트리밋 — 10분 뒤 다시`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 404 본문 등 */ }
  return { status: res.status, json, headers: res.headers };
}

/** 깊이 검사 — 나온 금지 키 */
const forbiddenIn = (o, keys) => {
  const found = new Set();
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (keys.includes(k)) found.add(k); walk(x); }
  })(o);
  return [...found];
};

// ── 입력 ─────────────────────────────────────────────────────────────────────
const step = (process, material, value, unit) => ({ process, material, value, unit, etc: '' });
const CASES = {
  A: { steps: [step('Sputter', 'Ti', '10', 'nm'), step('Sputter', 'Pt', '50', 'nm')], measurements: [], material: 'Ti, Pt' },
  B: { steps: [step('ALD', 'Al2O3', '10', 'nm')], measurements: ['XPS'], material: 'Al2O3' },
};
const estimateForm = (c) => ({
  steps: c.steps, measurements: c.measurements, sampleCount: '5', delivery: 'direct',
  substrateType: 'Silicon', substrateSize: '4inch', substrateGrade: '', locale: 'ko',
});
const inquiryBody = (c, seen) => ({
  type: 'quote', product: 'multilayers', productName: 'Multilayers', name: 'SMOKE TEST', email: 'smoke@test.local',
  privacy: 'agreed', material: c.material, locale: 'ko', details: '자동 견적 로컬 점검(SMOKE TEST)',
  detailsJson: JSON.stringify({
    v: 1, delivery: 'direct', preFilm: false, preFilmNote: '', sampleCount: '5',
    substrateType: 'Silicon', substrateSize: '4inch', seq: c.steps, measures: c.measurements,
  }),
  ...(seen !== undefined ? { estimateSeenKrw: seen } : {}),
  'cf-turnstile-response': 'local',
});
async function submit(c, seen) {
  const r = await call('POST', '/api/inquiry', inquiryBody(c, seen));
  if (r.json?.delivered === true) throw new Stop('접수 응답 delivered === true — 로컬 빌드에서 구글챗이 나갔을 수 있다. 즉시 멈춘다.');
  return r;
}
const lookup = (id) => call('POST', '/api/order/lookup', { id, email: 'smoke@test.local', locale: 'ko' });

// ── 실행 ─────────────────────────────────────────────────────────────────────
let original = null;
const ids = new Set();
const inquiryIds = [];
let totalA = null;
const customerBodies = [];
try {
  // 로그인
  const pw = /^ADMIN_PASSWORD="(.*)"$/m.exec(readFileSync(join(homedir(), 'vanam-data', 'local.vars'), 'utf8'))?.[1];
  if (!pw) throw new Stop('~/vanam-data/local.vars 에 ADMIN_PASSWORD 가 없습니다 (npm run local 이 만든다)');
  const login = await call('POST', '/api/admin/login', { password: pw });
  const sc = login.headers.get('set-cookie') ?? '';
  const m = /vanam_admin=([^;]+)/.exec(sc);
  if (login.status !== 200 || !m) throw new Stop(`관리자 로그인 실패 (${login.status})`);
  cookie = `vanam_admin=${m[1]}`;

  // 나오면 안 되는 문자열(실제 ID) — 개수만 출력
  const meta = await call('GET', '/api/admin/quote-calc', null, { admin: true });
  if (meta.status === 503) throw new Stop(`가격 DB 없음(503: ${meta.json?.error ?? ''}) — 가져오기를 추측해서 실행하지 않는다. 멈추고 보고.`);
  if (!meta.json?.ok) throw new Stop(`/api/admin/quote-calc GET 실패 (${meta.status})`);
  for (const r of meta.json.recipes ?? []) { ids.add(r.recipe_id); ids.add(r.equipment_id); }
  for (const e of meta.json.equipment ?? []) ids.add(e.equipment_id);
  for (const s of meta.json.substrates ?? []) ids.add(s.catalog_id);
  ids.delete(undefined); ids.delete(null); ids.delete('');
  console.log(`실제 ID 문자열 ${ids.size}개를 금지 목록으로 사용`);

  // 스위치 원래 상태 기억 → 켬
  const st = await call('GET', '/api/admin/quote-auto', null, { admin: true });
  if (!st.json?.ok) throw new Stop(`/api/admin/quote-auto GET 실패 (${st.status})`);
  original = st.json.on;
  console.log(`스위치 원래 상태: ${original ? '켜짐' : '꺼짐'} · 가격 DB 준비 ${st.json.priceDb?.ready}`);
  const on = await call('POST', '/api/admin/quote-auto', { on: true }, { admin: true });
  if (!on.json?.on) throw new Stop('스위치를 켜지 못함');

  // ── 사례 A ──
  console.log('\n사례 A — Sputter Ti 10 → Pt 50 · 샘플 5 · 방문 전달');
  const g = await call('GET', '/api/quote-estimate');
  pass('A: GET enabled true', g.json?.enabled === true);
  const eA = await call('POST', '/api/quote-estimate', { form: estimateForm(CASES.A) });
  customerBodies.push(eA.json);
  pass('A①: 응답 키가 ok·customer 뿐', JSON.stringify(Object.keys(eA.json ?? {}).sort()) === '["customer","ok"]', Object.keys(eA.json ?? {}).join(','));
  pass('A①: kind estimate', eA.json?.customer?.kind === 'estimate', eA.json?.customer?.kind);
  totalA = eA.json?.customer?.totalKrw ?? null;
  const iA = await submit(CASES.A, totalA);
  pass('A②: 접수 ok · delivered false', iA.json?.ok === true && iA.json?.delivered === false, `delivered=${iA.json?.delivered}`);
  if (iA.json?.id) inquiryIds.push(iA.json.id);
  const lA = await lookup(iA.json?.id);
  const qA = lA.json?.inquiry?.quote;
  customerBodies.push(qA);
  pass('A③: quote.state estimate', qA?.state === 'estimate', qA?.state);
  pass('A③: totalKrw = ① 합계', typeof totalA === 'number' && qA?.totalKrw === totalA);
  pass('A③: doc.total = ① 합계 · 품목 1개 이상', qA?.doc?.total === totalA && (qA?.doc?.items?.length ?? 0) >= 1, `품목 ${qA?.doc?.items?.length ?? 0}개`);
  pass('A①: customer 금지 키 0건', forbiddenIn(eA.json?.customer, FORBIDDEN_CUSTOMER_KEYS).length === 0);
  pass('A③: quote 금지 키 0건', forbiddenIn(qA, VIEW_FORBIDDEN_KEYS).length === 0, forbiddenIn(qA, VIEW_FORBIDDEN_KEYS).join(','));

  // ── 사례 B ──
  console.log('\n사례 B — ALD Al2O3 10(장비 후보 여럿) + 분석 XPS');
  const eB = await call('POST', '/api/quote-estimate', { form: estimateForm(CASES.B) });
  customerBodies.push(eB.json);
  pass('B①: kind manual', eB.json?.customer?.kind === 'manual', JSON.stringify(eB.json?.customer?.manual ?? ''));
  const iB = await submit(CASES.B);
  pass('B②: 접수 ok · delivered false', iB.json?.ok === true && iB.json?.delivered === false, `delivered=${iB.json?.delivered}`);
  if (iB.json?.id) inquiryIds.push(iB.json.id);
  const lB = await lookup(iB.json?.id);
  const qB = lB.json?.inquiry?.quote;
  customerBodies.push(qB);
  pass('B③: quote.state reviewing', qB?.state === 'reviewing', qB?.state);
  pass('B③: manual 문구 2개 이상 · doc null', (qB?.manual?.length ?? 0) >= 2 && qB?.doc === null, JSON.stringify(qB?.manual ?? []));
  pass('B③: quote 금지 키 0건', forbiddenIn(qB, VIEW_FORBIDDEN_KEYS).length === 0);

  // ── 사례 C ──
  console.log('\n사례 C — 스위치 꺼짐');
  const off = await call('POST', '/api/admin/quote-auto', { on: false }, { admin: true });
  if (off.json?.on !== false) throw new Stop('스위치를 끄지 못함');
  const gC = await call('GET', '/api/quote-estimate');
  pass('C: GET enabled false', gC.json?.enabled === false);
  const eC = await call('POST', '/api/quote-estimate', { form: estimateForm(CASES.A) });
  pass('C: POST 404', eC.status === 404, String(eC.status));
  const iC = await submit(CASES.A, totalA);
  pass('C: 접수 ok · delivered false', iC.json?.ok === true && iC.json?.delivered === false, `delivered=${iC.json?.delivered}`);
  if (iC.json?.id) inquiryIds.push(iC.json.id);
  const lC = await lookup(iC.json?.id);
  pass('C: 조회 quote === null', lC.json?.ok === true && lC.json?.inquiry?.quote === null);

  // ── 고객 응답의 실제 ID 문자열 ──
  const text = JSON.stringify(customerBodies);
  const leaked = [...ids].filter((id) => text.includes(id));
  pass('고객 응답(예상 견적·조회) 실제 ID 문자열 0건', leaked.length === 0, leaked.length ? `${leaked.length}개` : '');

  // ── 저장소 유출 검사 ──
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const hits = [];
  for (const f of files) {
    let buf;
    try { buf = readFileSync(f); } catch { continue; }
    if (buf.includes(0)) continue; // 바이너리
    const t = buf.toString('utf8');
    const n = [...ids].filter((id) => new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(t)).length;
    if (n) hits.push(`${f} (${n}개)`);
  }
  pass(`저장소 파일 ${files.length}개 실제 ID 문자열 0건`, hits.length === 0, hits.join(', '));
} catch (e) {
  if (e instanceof Stop) { console.error(`\n✗ 멈춤: ${e.message}`); results.push({ name: 'stop', ok: false }); }
  else throw e;
} finally {
  if (original !== null) {
    try {
      const back = await call('POST', '/api/admin/quote-auto', { on: original }, { admin: true });
      console.log(`\n스위치 원상복구: ${back.json?.on === original ? '완료' : '실패'} (${original ? '켜짐' : '꺼짐'})`);
      if (back.json?.on !== original) results.push({ name: 'restore', ok: false });
    } catch (e) {
      console.error('\n✗ 스위치 원상복구 실패:', e.message);
      results.push({ name: 'restore', ok: false });
    }
  }
}

console.log(`\n사례 A 합계: ${typeof totalA === 'number' ? `${totalA.toLocaleString('ko-KR')}원` : '-'}`);
console.log(`접수번호: ${inquiryIds.join(', ') || '-'}`);
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${bad ? '✗' : '✓'} 자동 견적 로컬 점검 — ${results.length - bad}/${results.length} 통과`);
if (bad) process.exit(1);
