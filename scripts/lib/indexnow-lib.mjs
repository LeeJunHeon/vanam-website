// IndexNow 공통 부품 — scripts/indexnow-targets.mjs(빌드 때 대상 계산) · scripts/indexnow-submit.mjs(배포 뒤 전송) · scripts/check-indexnow.mjs(게이트)가 함께 쓴다.
//   설정은 scripts/indexnow.config.mjs 한 곳. 공개 기록 형식은 scripts/sitemap-lastmod.mjs 상단 참고.
import config from '../indexnow.config.mjs';
import lastmodConfig from '../sitemap-lastmod.config.mjs';

export { config };
export const RECORD_FILES = lastmodConfig.publicRecord.files; // 공개 기록의 파일 항목(/llms.txt · /llms-full.txt)
export const keyPath = () => `/${config.key}.txt`;
export const keyFileName = () => `${config.key}.txt`;
export const KEY_RE = /^[a-z0-9]{32}$/;

/**
 * 알림 대상 계산 (순수 함수).
 *   prev: 지난 배포의 공개 기록(형식 확인된 객체) — 못 받았으면 null
 *   cur:  이번 빌드의 공개 기록
 *   files: 파일 항목 키 목록(기본 RECORD_FILES)
 * 반환 { mode, urls(경로, 정렬), reasons: { 경로: 이유 } }
 *   mode 'all'  — 지난 기록이 없거나(못 받음) head 지문이 하나도 없다(첫 실행) → 사이트맵 전체 + 파일 전체
 *   mode 'diff' — ① main 지문 바뀜 ② head 지문 바뀜 ③ 새 주소 ④ 사이트맵에서 빠진 주소 ⑤ 내용 바뀐 파일
 */
export function computeTargets(prev, cur, files = RECORD_FILES) {
  const isFile = (k) => files.includes(k);
  const curPages = Object.keys(cur).filter((k) => !isFile(k));
  const curFiles = Object.keys(cur).filter(isFile);
  const reasons = {};
  const prevHasHead = prev && Object.entries(prev).some(([k, v]) => !isFile(k) && typeof v.head === 'string');
  if (!prev || !prevHasHead) {
    const why = !prev ? '지난 공개 기록 없음' : '지난 공개 기록에 head 지문 없음(첫 실행)';
    for (const k of curPages) reasons[k] = why;
    for (const k of curFiles) reasons[k] = why;
    return { mode: 'all', urls: Object.keys(reasons).sort(), reasons };
  }
  for (const k of curPages) {
    const p = prev[k];
    if (!p) reasons[k] = '새 주소';
    else if (p.hash !== cur[k].hash) reasons[k] = '본문(<main>) 바뀜';
    else if (p.head !== cur[k].head) reasons[k] = 'head(제목·설명·canonical·robots·hreflang) 바뀜';
  }
  for (const k of Object.keys(prev)) if (!isFile(k) && !(k in cur)) reasons[k] = '사이트맵에서 빠짐';
  for (const k of curFiles) {
    const p = prev[k];
    if (!p) reasons[k] = '파일 지문 없음(새 항목)';
    else if (p.hash !== cur[k].hash) reasons[k] = '파일 내용 바뀜';
  }
  return { mode: 'diff', urls: Object.keys(reasons).sort(), reasons };
}

export const toUrl = (p, base = `https://${config.host}`) => `${base}${p}`;
export const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/** 키 포함 비교용 — 키 순서를 맞춰 직렬화한다. */
export const canonJson = (obj) => JSON.stringify(obj, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));

/**
 * IndexNow POST. 1회 maxPerRequest 이하로 나눠 보낸다. 던지지 않는다 — 결과 배열 [{ count, status, ok, error? }].
 *   200·202 만 성공. 그 밖의 코드·네트워크 오류는 결과에 담아 호출부가 로그만 남긴다.
 */
export async function submitUrls(urls, { endpoint = process.env.INDEXNOW_ENDPOINT || config.endpoint, host = config.host, key = config.key, keyLocation = `https://${config.host}${keyPath()}`, maxPerRequest = config.maxPerRequest, timeoutMs = config.live.timeoutMs, fetchImpl = fetch } = {}) {
  const results = [];
  for (const part of chunk(urls, maxPerRequest)) {
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host, key, keyLocation, urlList: part }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let body = '';
      try { body = (await res.text()).slice(0, 300); } catch { /* 본문 없음 */ }
      results.push({ count: part.length, status: res.status, ok: res.status === 200 || res.status === 202, body });
    } catch (e) {
      results.push({ count: part.length, status: null, ok: false, error: e.name === 'TimeoutError' ? `시간 초과(${timeoutMs / 1000}초)` : `${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}` });
    }
  }
  return results;
}
