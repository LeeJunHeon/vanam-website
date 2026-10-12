// xlsx 최소 리더(공용) — 브라우저·워커·node 에서 같이 쓴다. node: 모듈을 쓰지 않는다.
//
// 왜 직접 쓰는가: 가격 DB 는 구글 시트에서 내려받은 xlsx 한 장이고,
// 이 저장소는 새 npm 의존성을 늘리지 않는다(package-lock.json 불변 원칙).
// 우리가 필요한 건 "값과 수식 텍스트"뿐이라 서식·차트·피벗은 전부 무시한다.
//
//   zipEntries(bytes)     중앙 디렉터리만 읽어 [{ name, method, raw }] (압축은 풀지 않는다)
//   openWorkbook(files)   압축을 푼 항목(Map<이름, Uint8Array>) → 시트 접근자(시트는 요청할 때 해석)
//   inflateRawWeb(bytes)  DecompressionStream('deflate-raw') — 브라우저·워커·node 18+
//   openXlsxWeb(bytes)    .xml·.rels 항목만 풀어서(이미지 등 건너뜀) openWorkbook
//   node 전용 동기 경로는 scripts/lib/xlsx-lite.mjs 의 openXlsx(path).
//
// 지원 셀: 숫자(t 없음) · 공유 문자열(t="s", 리치 텍스트 <r><t> 포함) ·
//   인라인 문자열(t="inlineStr") · 불리언(t="b") · 수식 문자열 결과(t="str") ·
//   오류(t="e"). 수식 텍스트(<f>)와 캐시된 계산값(<v>)을 함께 돌려준다.
//
// ⚠️ 한계: zip64·암호화·외부 참조 시트는 지원하지 않는다(우리 파일엔 없다).
//   서식(날짜 직렬값 → Date)도 변환하지 않는다 — 가격 DB 에 날짜 열이 없다.

// ── ZIP ────────────────────────────────────────────────────────────────────
// xlsx 는 zip 이다. 중앙 디렉터리(EOCD → CD)만 읽는다.
const utf8 = new TextDecoder('utf-8');

/**
 * @param {Uint8Array} bytes
 * @returns {{name: string, method: number, raw: Uint8Array}[]} raw = 압축된 그대로(method 0 이면 원문)
 */
export function zipEntries(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (i) => dv.getUint32(i, true);
  const u16 = (i) => dv.getUint16(i, true);
  // EOCD(0x06054b50)를 뒤에서 찾는다. 주석이 있을 수 있어 최대 64KB 만 훑는다.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (u32(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx: ZIP 중앙 디렉터리(EOCD)를 찾지 못했습니다');
  const count = u16(eocd + 10);
  let p = u32(eocd + 16);

  const out = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || u32(p) !== 0x02014b50) throw new Error(`xlsx: 중앙 디렉터리 항목 서명 불일치 (#${n})`);
    const method = u16(p + 10);
    const compSize = u32(p + 20);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOff = u32(p + 42);
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // 로컬 헤더에서 실제 데이터 시작 위치를 다시 계산한다(extra 길이가 CD 와 다를 수 있다).
    if (localOff + 30 > buf.length || u32(localOff) !== 0x04034b50) throw new Error(`xlsx: 로컬 헤더 서명 불일치 (${name})`);
    const lNameLen = u16(localOff + 26);
    const lExtraLen = u16(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    if (method !== 0 && method !== 8) throw new Error(`xlsx: 지원하지 않는 압축 방식 ${method} (${name})`);
    out.push({ name, method, raw: buf.subarray(start, start + compSize) });
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
 * 압축을 푼 항목들로 워크북을 연다. 시트 XML 은 요청할 때 한 장씩 해석한다.
 * @param {Map<string, Uint8Array>} files
 */
export function openWorkbook(files) {
  const text = (n) => { const b = files.get(n); return b ? utf8.decode(b) : null; };

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

/**
 * deflate-raw 해제 — 브라우저·워커·node 18+ 의 DecompressionStream.
 * @param {Uint8Array} bytes @returns {Promise<Uint8Array>}
 */
export async function inflateRawWeb(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * xlsx 바이트 → 워크북(비동기). 시트 해석에 필요한 .xml·.rels 항목만 푼다(이미지 등은 건너뛴다).
 * @param {Uint8Array|ArrayBuffer} bytes
 */
export async function openXlsxWeb(bytes) {
  const files = new Map();
  for (const e of zipEntries(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))) {
    if (!/\.(xml|rels)$/i.test(e.name)) continue;
    files.set(e.name, e.method === 0 ? e.raw.slice() : await inflateRawWeb(e.raw));
  }
  return openWorkbook(files);
}
