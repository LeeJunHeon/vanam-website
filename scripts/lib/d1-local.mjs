// 로컬 D1(wrangler --local) 전용 실행기.
//
// 왜 한 곳에 모으는가: 가격 DB 가져오기는 원가 데이터를 다룬다.
// 실수로 --remote 가 한 번 섞이면 운영 DB 를 덮어쓴다(되돌릴 수 없다).
// → wrangler 를 부르는 경로를 이 파일의 runWrangler 하나로 좁히고,
//   인자에 --local 이 없거나 --remote 가 있으면 실행 전에 예외를 던진다.
//   배포·비밀·로그인 계열 하위 명령도 여기서 막는다.
import { execFileSync } from 'node:child_process';

/** 이 스크립트 계열이 절대 실행하지 않는 wrangler 하위 명령. */
const FORBIDDEN = ['deploy', 'versions', 'secret', 'login', 'logout', 'publish', 'delete'];

/**
 * wrangler 를 동기 실행한다. 로컬 D1 외에는 아무것도 허용하지 않는다.
 * @param {string[]} args  예: ['d1','execute','vanam-orders','--local','--file','x.sql']
 * @param {{cwd?: string}} [opts]
 * @returns {string} stdout
 */
export function runWrangler(args, opts = {}) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('runWrangler: 인자가 없습니다');
  if (!args.includes('--local')) throw new Error(`runWrangler 거부: --local 이 없습니다 → ${args.join(' ')}`);
  if (args.includes('--remote')) throw new Error(`runWrangler 거부: --remote 는 금지입니다 → ${args.join(' ')}`);
  for (const f of FORBIDDEN) {
    if (args.includes(f)) throw new Error(`runWrangler 거부: 금지된 하위 명령 "${f}" → ${args.join(' ')}`);
  }
  if (args[0] !== 'd1' || args[1] !== 'execute') {
    throw new Error(`runWrangler 거부: d1 execute 만 허용합니다 → ${args.join(' ')}`);
  }
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // CI 환경 변수를 주면 wrangler 가 대화형 프롬프트를 띄우지 않는다.
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** wrangler --json 출력에서 JSON 부분만 잘라 파싱한다(앞에 배너가 붙는 경우 대비). */
function parseJsonOut(out) {
  const i = out.indexOf('[');
  const j = out.lastIndexOf(']');
  if (i < 0 || j < i) throw new Error(`wrangler --json 출력에서 JSON 을 찾지 못했습니다:\n${out}`);
  return JSON.parse(out.slice(i, j + 1));
}

/**
 * 로컬 D1 에 SELECT 를 던져 결과 배열을 받는다.
 * @param {string} dbName 예: 'vanam-orders'
 * @param {string} sql
 * @returns {Record<string, unknown>[]}
 */
export function queryLocal(dbName, sql) {
  const out = runWrangler(['d1', 'execute', dbName, '--local', '--json', '--command', sql]);
  const parsed = parseJsonOut(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return /** @type {Record<string, unknown>[]} */ (first?.results ?? []);
}

/** 로컬 D1 에 SQL 파일을 적용한다. @param {string} dbName @param {string} file */
export function applyFileLocal(dbName, file) {
  return runWrangler(['d1', 'execute', dbName, '--local', '--file', file]);
}

/** 로컬 D1 에 단일 명령을 적용한다(쓰기 포함). @param {string} dbName @param {string} sql */
export function execLocal(dbName, sql) {
  return runWrangler(['d1', 'execute', dbName, '--local', '--command', sql]);
}

/** SQL 문자열 리터럴로 안전하게 감싼다. null/undefined 는 NULL. */
export function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`sqlLit: 유한하지 않은 숫자 ${v}`);
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  // 개행·따옴표 모두 리터럴 안에 그대로 들어간다. 홑따옴표만 두 배로.
  return `'${String(v).replace(/'/g, "''")}'`;
}
