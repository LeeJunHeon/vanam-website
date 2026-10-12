// npm run smoke:price [-- <엑셀 경로>] — 관리자 가격 DB 올리기 로컬 점검 (npm run local 로 띄운 127.0.0.1:8787 전용)
//
//   P0 지금 지문 F0 · 스위치 원래 상태 · 최근 가져오기 sha 가 이 파일과 같은지(다르면 멈춘다 — 추측해서 가져오지 않는다)
//   P1 브라우저 경로(openXlsxWeb)와 node 경로(xlsx-lite)가 같은 데이터·지문(= F0)
//   P2 미리보기 → 바뀌는 것 0 · same · 새 지문 = F0
//   P3 같은 데이터로 바꾸기 → 지문 F0 · 최근 가져오기 sha = 파일 sha
//   P4 스위치 켬 → 사례 A 예상 견적 합계 T0
//   P5 정책 markup_default × 2 사본 → 미리보기 정책 변경 1 · 바꾸기 → 지문 ≠ F0 · 사례 A 합계 ≠ T0
//   P6 원래 데이터로 되돌리기 → 지문 F0 · 합계 T0
//   P7 오류: 쿠키 없음 401 · ID 중복·숫자 칸 글자·필수 키 없음·모르는 표 400 · 옛 base 409 · 2MB 초과 400 → 지문 F0 그대로
//
// ⚠️ 가격 값·ID·실제 금액 외 원가를 출력하지 않는다(지문 앞 12자·개수·견적 합계만). 결과는 터미널에만.
// ⚠️ 끝나면 성공·실패와 상관없이 지문을 F0 로(필요하면 원래 데이터로 다시 바꾸기), 스위치를 원래대로.
// ⚠️ 로컬 서버 전용 — 운영 D1 에는 아무것도 쓰지 않는다.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { openXlsxWeb } from '../src/lib/xlsx-core.js';
import { openXlsx } from './lib/xlsx-lite.mjs';
import { readPriceWorkbook, validatePriceData, priceRowsForDb, priceFingerprint, PRICE_TABLE_ORDER } from '../src/lib/price-sheet.js';

const BASE = 'http://127.0.0.1:8787';
if (process.env.WORKERS_CI) { console.error('✗ WORKERS_CI 환경에서는 실행하지 않습니다(로컬 전용).'); process.exit(1); }

class Stop extends Error {}
const results = [];
const pass = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`); };
const s12 = (s) => String(s ?? '').slice(0, 12);

let cookie = '';
async function call(method, path, body, { admin = true, raw = null } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body || raw ? { 'Content-Type': 'application/json' } : {}), Origin: BASE, ...(admin && cookie ? { Cookie: cookie } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 429) throw new Stop(`${path}: 레이트리밋 — 잠시 뒤 다시`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json };
}

const src = resolve((process.argv[2] ?? '~/vanam-data/quote-db-v3.xlsx').replace(/^~(?=$|\/)/, homedir()));
const bytes = readFileSync(src);
const fileSha = createHash('sha256').update(bytes).digest('hex');
const FILE = { name: basename(src), size: bytes.length, sha256: fileSha };

const step = (process, material, value, unit) => ({ process, material, value, unit, etc: '' });
const FORM_A = {
  steps: [step('Sputter', 'Ti', '10', 'nm'), step('Sputter', 'Pt', '50', 'nm')], measurements: [], sampleCount: '5', delivery: 'direct',
  substrateType: 'Silicon', substrateSize: '4inch', substrateGrade: '', locale: 'ko',
};
const totalA = async () => (await call('POST', '/api/quote-estimate', { form: FORM_A }, { admin: false })).json?.customer?.totalKrw ?? null;
const fpNow = async () => (await call('GET', '/api/admin/quote-auto')).json?.priceDb?.fingerprint ?? null;
const preview = (data) => call('POST', '/api/admin/price-import', { mode: 'preview', file: FILE, data });
const apply = (data, base, expect, file = FILE) => call('POST', '/api/admin/price-import', { mode: 'apply', file, data, baseFingerprint: base, expectFingerprint: expect });
const clone = (o) => JSON.parse(JSON.stringify(o));

let original = null;
let F0 = null;
let data = null;
try {
  const pw = /^ADMIN_PASSWORD="(.*)"$/m.exec(readFileSync(join(homedir(), 'vanam-data', 'local.vars'), 'utf8'))?.[1];
  if (!pw) throw new Stop('~/vanam-data/local.vars 에 ADMIN_PASSWORD 가 없습니다');
  const lr = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ password: pw }) });
  const m = /vanam_admin=([^;]+)/.exec(lr.headers.get('set-cookie') ?? '');
  if (lr.status !== 200 || !m) throw new Stop(`관리자 로그인 실패 (${lr.status})`);
  cookie = `vanam_admin=${m[1]}`;

  console.log('P0 — 지금 상태');
  const st = await call('GET', '/api/admin/quote-auto');
  if (!st.json?.ok) throw new Stop(`quote-auto GET 실패 (${st.status})`);
  original = st.json.on;
  F0 = st.json.priceDb?.fingerprint ?? null;
  const logSha = st.json.priceDb?.importLog?.sha256 ?? '';
  console.log(`  스위치 원래 상태 ${original ? '켜짐' : '꺼짐'} · 지금 지문 ${s12(F0)} · 최근 가져오기 sha ${s12(logSha)} · 파일 sha ${s12(fileSha)}`);
  if (!F0) throw new Stop('가격 DB 가 비어 있다 — 가져오기를 추측해서 실행하지 않는다. 멈추고 보고.');
  if (s12(logSha) !== s12(fileSha)) throw new Stop('최근 가져오기 sha 가 이 파일과 다르다 — 추측해서 다시 가져오지 않는다. 멈추고 보고.');
  pass('P0: 지문 64자 · 가져오기 sha = 파일 sha', /^[0-9a-f]{64}$/.test(F0));

  console.log('\nP1 — 두 경로로 읽기');
  const web = readPriceWorkbook(await openXlsxWeb(new Uint8Array(bytes)));
  const lite = readPriceWorkbook(openXlsx(src));
  const fpWeb = await priceFingerprint(priceRowsForDb(web.data));
  const fpLite = await priceFingerprint(priceRowsForDb(lite.data));
  pass('P1: 문제 0건(엑셀·재검사)', web.problems.length === 0 && lite.problems.length === 0 && validatePriceData(web.data).problems.length === 0,
    `${web.problems.length}/${lite.problems.length}`);
  pass('P1: 브라우저 경로 지문 = node 경로 지문 = F0', fpWeb === fpLite && fpWeb === F0, `${s12(fpWeb)} / ${s12(fpLite)}`);
  data = web.data;
  console.log(`  행 수 ${PRICE_TABLE_ORDER.map((t) => `${t.replace('price_', '')} ${data[t].length}`).join(' · ')}`);

  console.log('\nP2 — 미리보기(같은 데이터)');
  const p2 = await preview(data);
  const zero = (df) => PRICE_TABLE_ORDER.every((t) => df?.[t] && df[t].added + df[t].removed + df[t].changed === 0);
  pass('P2: 바뀌는 것 0 · same · 새 지문 = F0', p2.json?.ok && zero(p2.json.diff) && p2.json.same === true && p2.json.next?.fingerprint === F0 && p2.json.current?.fingerprint === F0,
    `${p2.status}`);

  console.log('\nP3 — 같은 데이터로 바꾸기');
  const p3 = await apply(data, F0, F0);
  const lg3 = (await call('GET', '/api/admin/quote-auto')).json?.priceDb?.importLog?.sha256;
  pass('P3: ok · 지문 F0 · 가져오기 기록 sha = 파일 sha', p3.json?.ok === true && p3.json.fingerprint === F0 && s12(lg3) === s12(fileSha) && p3.json.importLog?.sha12 === s12(fileSha),
    `${p3.status} ${p3.json?.error ?? ''}`);

  console.log('\nP4 — 스위치 켜고 사례 A');
  const on = await call('POST', '/api/admin/quote-auto', { on: true });
  if (on.json?.on !== true) throw new Stop('스위치를 켜지 못함');
  const T0 = await totalA();
  pass('P4: 사례 A 합계 T0', typeof T0 === 'number' && T0 > 0, typeof T0 === 'number' ? `${T0.toLocaleString('ko-KR')}원` : String(T0));

  console.log('\nP5 — 정책 markup_default × 2 사본');
  const mod = clone(data);
  const row = mod.price_policy.find((r) => r.key === 'markup_default');
  if (!row || !Number.isFinite(Number(row.value))) throw new Stop('markup_default 가 숫자 정책이 아니다');
  row.value = String(Number(row.value) * 2);
  const p5 = await preview(mod);
  const df = p5.json?.diff ?? {};
  const onlyPolicy = df.price_policy?.changed === 1 && df.price_policy.added + df.price_policy.removed === 0
    && PRICE_TABLE_ORDER.filter((t) => t !== 'price_policy').every((t) => df[t].added + df[t].removed + df[t].changed === 0);
  pass('P5: 미리보기 — 정책 변경 1 · 나머지 0', p5.json?.ok && onlyPolicy && p5.json.same === false);
  const F5 = p5.json?.next?.fingerprint;
  const a5 = await apply(mod, F0, F5, { ...FILE, name: 'smoke-modified.xlsx', sha256: '0'.repeat(64) });
  const fp5 = await fpNow();
  const T5 = await totalA();
  pass('P5: 바꾸기 → 지문 ≠ F0 · 사례 A 합계 ≠ T0', a5.json?.ok === true && fp5 === F5 && fp5 !== F0 && typeof T5 === 'number' && T5 !== T0,
    `${a5.status} ${a5.json?.error ?? ''} 지문 ${s12(fp5)} · 합계 ${typeof T5 === 'number' ? `${T5.toLocaleString('ko-KR')}원` : T5}`);

  console.log('\nP6 — 원래 데이터로 되돌리기');
  const a6 = await apply(data, F5, F0);
  const fp6 = await fpNow();
  const T6 = await totalA();
  pass('P6: 지문 F0 · 합계 T0', a6.json?.ok === true && fp6 === F0 && T6 === T0, `${a6.status} ${a6.json?.error ?? ''} 지문 ${s12(fp6)}`);

  console.log('\nP7 — 오류');
  const noCookie = await call('POST', '/api/admin/price-import', { mode: 'preview', file: FILE, data }, { admin: false });
  pass('P7: 쿠키 없음 401', noCookie.status === 401, String(noCookie.status));
  const bad = async (label, mut) => {
    const d = clone(data); mut(d);
    const r = await preview(d);
    pass(`P7: ${label} → 400 invalid`, r.status === 400 && r.json?.error === 'invalid', `${r.status} ${r.json?.error ?? ''} 문제 ${r.json?.count ?? 0}건`);
  };
  await bad('ID 중복', (d) => { d.price_recipe[1].recipe_id = d.price_recipe[0].recipe_id; });
  await bad('숫자 칸 abc', (d) => { const k = Object.keys(d.price_recipe[0]).find((c) => c === 'growth_nm_per_min'); d.price_recipe[0][k] = 'abc'; });
  await bad('필수 정책 키 빠짐', (d) => { d.price_policy = d.price_policy.filter((r) => r.key !== 'currency'); });
  await bad('모르는 표', (d) => { d.price_extra = [{ a: 1 }]; });
  const stale = await apply(data, F5, F0);
  pass('P7: 옛 baseFingerprint → 409 db_changed', stale.status === 409 && stale.json?.error === 'db_changed', `${stale.status} ${stale.json?.error ?? ''}`);
  const big = await call('POST', '/api/admin/price-import', null, { raw: JSON.stringify({ mode: 'preview', file: FILE, data, pad: 'x'.repeat(2_000_001) }) });
  pass('P7: 2MB 넘는 본문 → 400 too_large', big.status === 400 && big.json?.error === 'too_large', `${big.status} ${big.json?.error ?? ''}`);
  pass('P7: 끝나고 지문 F0 그대로', (await fpNow()) === F0);
} catch (e) {
  if (e instanceof Stop) { console.error(`\n✗ 멈춤: ${e.message}`); results.push({ name: 'stop', ok: false }); }
  else throw e;
} finally {
  if (F0 && data) {
    try {
      const now = await fpNow();
      if (now && now !== F0) {
        const r = await apply(data, now, F0);
        console.log(`\n지문 복구: ${r.json?.ok ? '완료' : `실패 ${r.json?.error ?? r.status}`}`);
        if (!r.json?.ok) results.push({ name: 'restore-fp', ok: false });
      }
    } catch (e) { console.error('✗ 지문 복구 실패:', e.message); results.push({ name: 'restore-fp', ok: false }); }
  }
  if (original !== null) {
    try {
      const back = await call('POST', '/api/admin/quote-auto', { on: original });
      console.log(`스위치 원상복구: ${back.json?.on === original ? '완료' : '실패'} (${original ? '켜짐' : '꺼짐'})`);
      if (back.json?.on !== original) results.push({ name: 'restore', ok: false });
    } catch (e) { console.error('✗ 스위치 원상복구 실패:', e.message); results.push({ name: 'restore', ok: false }); }
  }
}

const badN = results.filter((r) => !r.ok).length;
console.log(`\n${badN ? '✗' : '✓'} 가격 DB 올리기 로컬 점검 — ${results.length - badN}/${results.length} 통과`);
console.log(`로컬 데이터 지문: ${F0 ? s12(await fpNow().catch(() => F0)) : '-'}`);
if (badN) process.exit(1);
