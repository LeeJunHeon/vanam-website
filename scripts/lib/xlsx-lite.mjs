// xlsx 최소 리더(node 동기 경로) — 해석은 src/lib/xlsx-core.js(브라우저·워커·node 공용)가 한다.
//
// 이 파일은 파일 읽기(readFileSync)와 동기 해제(inflateRawSync)만 맡는 얇은 래퍼다.
// 내보내는 이름·결과는 예전과 같다: openXlsx(path) · colToNum · numToCol · parseRef.
//
// ⚠️ 한계: zip64·암호화·외부 참조 시트는 지원하지 않는다(우리 파일엔 없다).
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { zipEntries, openWorkbook, colToNum, numToCol, parseRef } from '../../src/lib/xlsx-core.js';

export { colToNum, numToCol, parseRef };

/**
 * xlsx 파일을 연다. 시트 XML 은 요청할 때 한 장씩 해석한다.
 * @param {string} path
 */
export function openXlsx(path) {
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const e of zipEntries(readFileSync(path))) {
    files.set(e.name, e.method === 0 ? Uint8Array.from(e.raw) : inflateRawSync(e.raw));
  }
  return openWorkbook(files);
}
