// xlsx 최소 리더 — 의존성 없이 node:zlib 만으로 시트 값·수식을 읽는다.
//
// 왜 직접 쓰는가: 가격 DB 는 구글 시트에서 내려받은 xlsx 한 장이고,
// 이 저장소는 새 npm 의존성을 늘리지 않는다(package-lock.json 불변 원칙).
// 우리가 필요한 건 "값과 수식 텍스트"뿐이라 서식·차트·피벗은 전부 무시한다.
//
// 읽는 파일: [Content_Types] 대신 xl/workbook.xml(+rels)로 시트 경로를 찾고,
//   xl/sharedStrings.xml 로 공유 문자열을 풀고, 해당 시트 XML 만 압축 해제한다.
// 지원 셀: 숫자(t 없음) · 공유 문자열(t="s", 리치 텍스트 <r><t> 포함) ·
//   인라인 문자열(t="inlineStr") · 불리언(t="b") · 수식 문자열 결과(t="str") ·
//   오류(t="e"). 수식 텍스트(<f>)와 캐시된 계산값(<v>)을 함께 돌려준다.
//
// ⚠️ 한계: zip64·암호화·외부 참조 시트는 지원하지 않는다(우리 파일엔 없다).
//   서식(날짜 직렬값 → Date)도 변환하지 않는다 — 가격 DB 에 날짜 열이 없다.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// ── ZIP ────────────────────────────────────────────────────────────────────
// xlsx 는 zip 이다. 중앙 디렉터리(EOCD → CD)만 읽고 필요한 엔트리만 해제한다.
/** @param {Buffer} buf @returns {Map<string, Buffer>} 파일명 → 압축 해제 전 위치 정보 대신 바로 해제한 내용 */
function unzip(buf) {
  // EOCD(0x06054b50)를 뒤에서 찾는다. 주석이 있을 수 있어 최대 64KB 만 훑는다.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx: ZIP 중앙 디렉터리(EOCD)를 찾지 못했습니다');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  /** @type {Map<string, Buffer>} */
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`xlsx: 중앙 디렉터리 항목 서명 불일치 (#${n})`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    // 로컬 헤더에서 실제 데이터 시작 위치를 다시 계산한다(extra 길이가 CD 와 다를 수 있다).
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`xlsx: 로컬 헤더 서명 불일치 (${name})`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`xlsx: 지원하지 않는 압축 방식 ${method} (${name})`);
  }
  return out;
}

// ── XML ────────────────────────────────────────────────────────────────────
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** XML 엔터티를 푼다. 숫자 참조(&#10; &#x1F;)도 처리. */
function unesc(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') return String.fromCodePoint(parseInt(g[1] === 'x' || g[1] === 'X' ? g.slice(2) : g.slice(1), g[1] === 'x' || g[1] === 'X' ? 16 : 10));
    return ENTITY[g] ?? m;
  });
}
/** 태그의 속성을 뽑는다. @param {string} tag `<c r="A1" t="s">` @returns {Record<string,string>} */
function attrs(tag) {
  /** @type {Record<string,string>} */
  const o = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) o[m[1]] = unesc(m[2]);
  return o;
}

// ── 열 문자 ↔ 번호 ─────────────────────────────────────────────────────────
/** 'A'→1, 'Z'→26, 'AA'→27 */
export function colToNum(col) {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
/** 1→'A', 27→'AA' */
export function numToCol(n) {
  let s = '';
  for (let x = n; x > 0;) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - r) / 26); }
  return s;
}
/** 'AB12' → { col: 28, row: 12 } */
export function parseRef(ref) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(ref).trim());
  if (!m) throw new Error(`xlsx: 셀 주소 형식 오류: ${ref}`);
  return { col: colToNum(m[1]), row: Number(m[2]) };
}

// ── 공유 문자열 ────────────────────────────────────────────────────────────
function parseSharedStrings(xml) {
  if (!xml) return [];
  /** @type {string[]} */
  const out = [];
  // <si> 하나가 문자열 하나. 리치 텍스트면 <r><t>…</t></r> 가 여러 개 — 전부 이어붙인다.
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    const body = si[1] ?? '';
    let s = '';
    for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) s += unesc(t[1] ?? '');
    out.push(s);
  }
  return out;
}

// ── 시트 ───────────────────────────────────────────────────────────────────
/**
 * @typedef {object} Cell
 * @property {string} ref  'A1'
 * @property {number} row
 * @property {number} col
 * @property {string|number|boolean|null} v 값(캐시된 계산값 포함). 빈 셀은 없음(맵에 아예 안 들어간다)
 * @property {string|null} f 수식 텍스트(없으면 null). '=' 은 붙지 않는다
 * @property {string} t  원본 타입('n'|'s'|'inlineStr'|'b'|'str'|'e')
 */

function parseSheet(xml, shared) {
  /** @type {Map<string, Cell>} */
  const cells = new Map();
  let maxRow = 0, maxCol = 0;
  for (const m of xml.matchAll(/<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
    const a = attrs('<c' + m[1] + '>');
    const body = m[3] ?? '';
    const ref = a.r;
    if (!ref) continue;
    const { row, col } = parseRef(ref);
    const t = a.t || 'n';
    const fm = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body);
    const f = fm ? unesc(fm[1]) : null;
    const vm = /<v\b[^>]*>([\s\S]*?)<\/v>|<v\b[^>]*\/>/.exec(body);
    const rawV = vm ? unesc(vm[1] ?? '') : null;

    /** @type {string|number|boolean|null} */
    let v = null;
    if (t === 's') {
      const i = rawV === null ? -1 : Number(rawV);
      if (i >= 0 && i < shared.length) v = shared[i];
      else if (rawV !== null) throw new Error(`xlsx: 공유 문자열 인덱스 범위 밖 (${ref}: ${rawV})`);
    } else if (t === 'inlineStr') {
      let s = '';
      const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body);
      for (const tt of (is?.[1] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) s += unesc(tt[1] ?? '');
      v = s;
    } else if (t === 'b') {
      v = rawV === null ? null : rawV === '1' || rawV.toUpperCase() === 'TRUE';
    } else if (t === 'str' || t === 'e') {
      v = rawV;
    } else { // 'n' — 숫자
      v = rawV === null || rawV === '' ? null : Number(rawV);
      if (v !== null && Number.isNaN(v)) v = rawV; // 이상값은 원문 그대로 남긴다(조용한 0 방지)
    }
    // 값도 수식도 없는 셀(서식만 있는 껍데기)은 '비움'과 같다 — 맵에 넣지 않는다.
    if (v === null && f === null) continue;
    cells.set(ref, { ref, row, col, v, f, t });
    if (row > maxRow) maxRow = row;
    if (col > maxCol) maxCol = col;
  }
  return { cells, maxRow, maxCol };
}

/** 시트 하나를 감싼 접근자. */
function makeSheet(name, parsed) {
  const { cells, maxRow, maxCol } = parsed;
  return {
    name, maxRow, maxCol, cells,
    /** @param {string} ref @returns {Cell|null} */
    cell(ref) { return cells.get(String(ref).toUpperCase()) ?? null; },
    /** 셀 값(비움은 null). @param {string} ref */
    value(ref) { return this.cell(ref)?.v ?? null; },
    /** 수식 텍스트(없으면 null). @param {string} ref */
    formula(ref) { return this.cell(ref)?.f ?? null; },
    /** (row, col) 1-기준 값 */
    at(row, col) { return this.value(numToCol(col) + row); },
    /** 한 행을 1-기준 배열로. rows[1] 이 A열. @param {number} row */
    row(row) {
      const out = [null];
      for (let c = 1; c <= maxCol; c++) out.push(this.at(row, c));
      return out;
    },
    /** 전체를 2차원 배열로(0-기준, [r][c] = r+1 행 c+1 열) */
    toArray() {
      const out = [];
      for (let r = 1; r <= maxRow; r++) {
        const line = [];
        for (let c = 1; c <= maxCol; c++) line.push(this.at(r, c));
        out.push(line);
      }
      return out;
    },
    /**
     * 헤더 행을 키로 쓴 객체 배열. 빈 셀은 null 로 남는다(0 과 구분).
     * @param {number} headerRow 헤더가 있는 행(1-기준)
     * @param {number} [firstRow] 데이터 시작 행(기본: headerRow+1)
     */
    records(headerRow, firstRow) {
      const headers = [];
      for (let c = 1; c <= maxCol; c++) {
        const h = this.at(headerRow, c);
        headers.push(h === null ? null : String(h).trim());
      }
      const out = [];
      for (let r = (firstRow ?? headerRow + 1); r <= maxRow; r++) {
        /** @type {Record<string, any>} */
        const rec = { __row: r };
        let any = false;
        for (let c = 1; c <= maxCol; c++) {
          const key = headers[c - 1];
          if (!key) continue;
          const v = this.at(r, c);
          rec[key] = v;
          if (v !== null && v !== '') any = true;
        }
        if (any) out.push(rec);
      }
      return out;
    },
  };
}

/**
 * xlsx 파일을 연다. 시트 XML 은 요청할 때 한 장씩 해제한다(전체 메모리 낭비 방지).
 * @param {string} path
 */
export function openXlsx(path) {
  const files = unzip(readFileSync(path));
  const text = (n) => { const b = files.get(n); return b ? b.toString('utf8') : null; };

  const wb = text('xl/workbook.xml');
  if (!wb) throw new Error('xlsx: xl/workbook.xml 이 없습니다 — xlsx 파일이 맞습니까?');
  const rels = text('xl/_rels/workbook.xml.rels') ?? '';
  /** @type {Record<string,string>} rId → 시트 경로 */
  const target = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const a = attrs(m[0]);
    if (!a.Id || !a.Target) continue;
    let t = a.Target.replace(/^\/xl\//, '').replace(/^\.\//, '');
    target[a.Id] = t.startsWith('xl/') ? t : `xl/${t}`;
  }

  /** @type {{name:string, path:string}[]} */
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const a = attrs(m[0]);
    if (!a.name) continue;
    const rid = a['r:id'] || a['id'];
    const p = target[rid];
    if (!p) throw new Error(`xlsx: 시트 "${a.name}" 의 경로(rels ${rid})를 찾지 못했습니다`);
    sheets.push({ name: a.name, path: p });
  }

  const shared = parseSharedStrings(text('xl/sharedStrings.xml'));
  /** @type {Map<string, ReturnType<typeof makeSheet>>} */
  const cache = new Map();

  return {
    sheetNames: sheets.map((s) => s.name),
    /** 시트 이름으로 찾기. 없으면 예외(조용한 빈 시트 방지). @param {string} name */
    sheet(name) {
      const hit = cache.get(name);
      if (hit) return hit;
      const meta = sheets.find((s) => s.name === name);
      if (!meta) throw new Error(`xlsx: 시트를 찾지 못했습니다: ${name} (있는 시트: ${sheets.map((s) => s.name).join(', ')})`);
      const xml = text(meta.path);
      if (xml === null) throw new Error(`xlsx: 시트 XML 없음: ${meta.path}`);
      const s = makeSheet(name, parseSheet(xml, shared));
      cache.set(name, s);
      return s;
    },
  };
}
