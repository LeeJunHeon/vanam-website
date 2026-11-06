// 사이트맵 lastmod 공통 부품 — scripts/sitemap-lastmod.mjs(적용·stamp)와 scripts/check-sitemap-lastmod.mjs(게이트)가 함께 쓴다.
// 본문 지문은 scripts/lib/page-text.mjs 하나에서만 만든다. 사용법은 scripts/sitemap-lastmod.mjs 상단 주석.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import config from '../sitemap-lastmod.config.mjs';
import { fingerprintFile } from './page-text.mjs';

export { config };
export const FP_OPTS = { exclude: config.exclude, textFromAttr: config.textFromAttr };
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 명령줄: [--dist <dir>] [--record <file>] [--stamp] */
export function parseArgs(argv) {
  const a = { dist: 'dist/client', record: config.record, stamp: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist') a.dist = argv[++i];
    else if (argv[i] === '--record') a.record = argv[++i];
    else if (argv[i] === '--stamp') a.stamp = true;
    else throw new Error(`알 수 없는 인자: ${argv[i]}`);
  }
  return a;
}

/** Asia/Seoul 기준 날짜(YYYY-MM-DD). 한국은 서머타임이 없어 UTC+9 고정이다. */
export const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

/** Cloudflare Workers Builds 는 빌드 환경에 WORKERS_CI=1 을 넣는다(공식 문서: Workers > CI/CD > Builds > Configuration > Default variables). */
export const isCloudflareBuild = (env = process.env) => env.WORKERS_CI === '1';

/** HEAD 커밋 날짜(KST). git 을 못 쓰면 null. */
export function headCommitDateKST(cwd = process.cwd()) {
  try {
    const ts = execFileSync('git', ['log', '-1', '--format=%ct'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return /^\d+$/.test(ts) ? kstDate(new Date(Number(ts) * 1000)) : null;
  } catch {
    return null;
  }
}

export const isValidDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// ── 기록 파일 ──
export function loadRecord(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function saveRecord(file, rec) {
  const lines = Object.keys(rec).sort().map((k) => `  ${JSON.stringify(k)}: { "hash": ${JSON.stringify(rec[k].hash)}, "date": ${JSON.stringify(rec[k].date)} }`);
  fs.writeFileSync(file, `{\n${lines.join(',\n')}\n}\n`);
}

// ── 사이트맵 XML ──
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
export const stripLastmod = (xml) => xml.replace(/<lastmod>[^<]*<\/lastmod>/g, '');
const pick = (body, tag) => (new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body) || [])[1] ?? null;

/** sitemap-index.xml 과 그 자식 sitemap 전부를 읽는다. */
export function readSitemaps(dist) {
  const indexFile = path.join(dist, 'sitemap-index.xml');
  if (!fs.existsSync(indexFile)) throw new Error(`${indexFile} 가 없다 — npm run build 먼저`);
  const indexXml = fs.readFileSync(indexFile, 'utf8');
  const children = [...indexXml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)].map((m) => {
    const loc = pick(m[1], 'loc');
    const name = path.basename(new URL(loc).pathname);
    const file = path.join(dist, name);
    if (!fs.existsSync(file)) throw new Error(`${file} 가 없다 (sitemap-index.xml 이 가리키는 자식 sitemap)`);
    const xml = fs.readFileSync(file, 'utf8');
    const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((u) => {
      const uloc = pick(u[1], 'loc');
      return { loc: uloc, path: new URL(uloc).pathname, lastmod: pick(u[1], 'lastmod'), hreflang: (u[1].match(/<xhtml:link\b/g) || []).length };
    });
    return { loc, name, file, xml, lastmod: pick(m[1], 'lastmod'), urls };
  });
  return { indexFile, indexXml, children };
}

/** <url> 마다 <lastmod> 를 dateByLoc 값으로 맞춘다(없으면 지운다). 나머지 글자는 그대로 둔다. */
export function setUrlLastmod(xml, dateByLoc) {
  return xml.replace(/<url>([\s\S]*?)<\/url>/g, (m, body) => {
    const loc = pick(body, 'loc');
    let b = stripLastmod(body);
    const d = dateByLoc.get(loc);
    if (d) b = b.replace('</loc>', `</loc><lastmod>${d}</lastmod>`);
    return `<url>${b}</url>`;
  });
}
/** sitemap-index.xml 의 <sitemap> 마다 <lastmod> 를 dateByLoc 값으로 맞춘다. */
export function setIndexLastmod(xml, dateByLoc) {
  return xml.replace(/<sitemap>([\s\S]*?)<\/sitemap>/g, (m, body) => {
    const loc = pick(body, 'loc');
    let b = stripLastmod(body);
    const d = dateByLoc.get(loc);
    if (d) b = b.replace('</loc>', `</loc><lastmod>${d}</lastmod>`);
    return `<sitemap>${b}</sitemap>`;
  });
}

/** XML 이 올바른 형식(well-formed)인지 직접 파싱해 확인한다. 문제없으면 null, 있으면 오류 문구. */
export function xmlError(xml) {
  const entOk = (s) => !/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(s);
  const tagRe = /<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
  const stack = []; let roots = 0; let i = 0;
  if (xml.startsWith('﻿')) i = 1;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    if (text.includes('>') && /]]>/.test(text)) return `글자 안에 ]]> (위치 ${i})`;
    if (!entOk(text)) return `잘못된 & (위치 ${i})`;
    if (stack.length === 0 && text.trim() !== '') return `최상위 요소 밖의 글자 (위치 ${i})`;
    if (lt < 0) break;
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt); if (e < 0) return `닫히지 않은 <? (위치 ${lt})`; if (xml.startsWith('<?xml ', lt) && lt !== (xml.startsWith('﻿') ? 1 : 0)) return 'XML 선언이 맨 앞이 아님'; i = e + 2; continue; }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); if (e < 0) return `닫히지 않은 주석 (위치 ${lt})`; i = e + 3; continue; }
    if (xml.startsWith('</', lt)) {
      const e = xml.indexOf('>', lt); if (e < 0) return `닫히지 않은 태그 (위치 ${lt})`;
      const name = xml.slice(lt + 2, e).trim(); const open = stack.pop();
      if (open !== name) return `짝이 안 맞는 태그 </${name}> (열린 태그 <${open ?? '없음'}>, 위치 ${lt})`;
      i = e + 1; continue;
    }
    tagRe.lastIndex = lt; const m = tagRe.exec(xml);
    if (!m) return `태그 형식 오류 (위치 ${lt}: ${xml.slice(lt, lt + 40)})`;
    if (!entOk(m[2])) return `속성값에 잘못된 & (위치 ${lt})`;
    const names = [...m[2].matchAll(/\s+([A-Za-z_][\w:.-]*)\s*=/g)].map((x) => x[1]);
    if (new Set(names).size !== names.length) return `중복 속성 (위치 ${lt})`;
    if (stack.length === 0) { roots++; if (roots > 1) return `최상위 요소가 둘 이상 (위치 ${lt})`; }
    if (!m[3]) stack.push(m[1]);
    i = tagRe.lastIndex;
  }
  if (stack.length) return `닫히지 않은 요소 <${stack[stack.length - 1]}>`;
  if (roots !== 1) return '최상위 요소 없음';
  return null;
}

// ── HTML 대응 · 지문 ──
export function htmlFileFor(dist, urlPathname) {
  const p = decodeURIComponent(urlPathname).replace(/^\/+/, '');
  const cands = [path.join(dist, p, 'index.html')];
  const bare = p.replace(/\/+$/, '');
  if (bare !== '') cands.push(path.join(dist, bare + '.html'));
  return cands.find((f) => fs.existsSync(f) && fs.statSync(f).isFile()) ?? null;
}

/**
 * 사이트맵의 모든 URL 을 기록과 비교한다.
 * status: same(지문 같음) · changed(지문 다름) · new(기록 없음) · no-html(정적 HTML 없음) · no-main(<main> 없음)
 */
export function evaluate(dist, record) {
  const sm = readSitemaps(dist);
  const rows = []; const seen = new Set();
  for (const child of sm.children) {
    for (const u of child.urls) {
      seen.add(u.path);
      const file = htmlFileFor(dist, u.path);
      const hash = file ? (fingerprintFile(file, FP_OPTS)?.hash ?? null) : null;
      const rec = record[u.path] ?? null;
      const status = !file ? 'no-html' : hash == null ? 'no-main' : !rec ? 'new' : rec.hash !== hash ? 'changed' : 'same';
      rows.push({ child: child.name, loc: u.loc, path: u.path, lastmod: u.lastmod, hreflang: u.hreflang, file, hash, rec, status });
    }
  }
  const stale = Object.keys(record).filter((k) => !seen.has(k)).sort();
  return { sm, rows, stale };
}

/** 생성 결과 요약(lastmod 를 뺀 XML 의 해시와 개수) — "lastmod 만 바뀌었는가"를 게이트가 확인하는 기준. */
export function summarize(sm) {
  const files = { [path.basename(sm.indexFile)]: { sitemaps: sm.children.length, sha256NoLastmod: sha256(stripLastmod(sm.indexXml)) } };
  for (const c of sm.children) files[c.name] = { urls: c.urls.length, hreflang: c.urls.reduce((n, u) => n + u.hreflang, 0), sha256NoLastmod: sha256(stripLastmod(c.xml)) };
  return files;
}
export const reportFile = (dist) => path.join(dist, '..', 'sitemap-lastmod.report.json');
