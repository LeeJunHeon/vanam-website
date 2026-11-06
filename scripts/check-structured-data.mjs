// 구조화 데이터(JSON-LD) 게이트 — 빌드 결과(dist/client)를 검사한다. Node 만 사용.
//   node scripts/check-structured-data.mjs [디렉터리|파일]   (인자 없으면 dist/client)
// 핵심 규칙: JSON-LD 의 값은 그 페이지 화면에 실제로 보이는 텍스트에 있어야 한다.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT = 'dist/client';
const arg = process.argv[2] || DEFAULT;
const SITE = 'https://vanam.co.kr';
const ORG_ID = `${SITE}/#organization`;
const WEBSITE_ID = `${SITE}/#website`;
const SERVICE_KEYS = ['deposition', 'wafers', 'analysis', 'equipment'];
const FIXED_IDS = new Set([ORG_ID, WEBSITE_ID,
  ...SERVICE_KEYS.flatMap((k) => [`${SITE}/product/#service-${k}`, `${SITE}/ko/product/#service-${k}`])]);

// 타입별 허용 속성(schema.org 정의에 있는 것만). 이 모듈이 만드는 타입만 검사한다.
const THING = ['name', 'alternateName', 'description', 'url', 'image', 'sameAs', 'identifier', 'mainEntityOfPage', 'potentialAction', 'subjectOf', 'disambiguatingDescription', 'additionalType'];
const ALLOWED = {
  Thing: THING,
  Organization: [...THING, 'logo', 'slogan', 'foundingDate', 'email', 'telephone', 'address', 'areaServed', 'knowsAbout', 'hasOfferCatalog', 'founder', 'contactPoint', 'legalName', 'brand', 'numberOfEmployees', 'taxID', 'vatID'],
  WebSite: [...THING, 'inLanguage', 'publisher', 'potentialAction', 'copyrightHolder', 'issn'],
  Service: [...THING, 'serviceType', 'provider', 'areaServed', 'category', 'hasOfferCatalog', 'serviceOutput', 'offers', 'brand', 'audience', 'termsOfService', 'availableChannel', 'isRelatedTo', 'isSimilarTo', 'produces', 'providerMobility', 'review', 'aggregateRating', 'slogan', 'logo', 'serviceAudience', 'broker', 'hoursAvailable', 'serviceArea'],
  Dataset: [...THING, 'creator', 'isAccessibleForFree', 'license', 'variableMeasured', 'keywords', 'distribution', 'measurementTechnique', 'temporalCoverage', 'spatialCoverage', 'publisher', 'datePublished', 'dateModified', 'includedInDataCatalog', 'version', 'citation'],
  PropertyValue: [...THING, 'value', 'unitCode', 'unitText', 'propertyID', 'minValue', 'maxValue', 'measurementTechnique'],
  ImageObject: [...THING, 'contentUrl', 'caption', 'width', 'height', 'encodingFormat', 'thumbnailUrl', 'embedUrl', 'creator', 'license', 'representativeOfPage', 'uploadDate'],
  BreadcrumbList: ['itemListElement', 'numberOfItems', 'itemListOrder', 'name', 'url', 'description'],
  ItemList: ['itemListElement', 'numberOfItems', 'itemListOrder', 'name', 'url', 'description'],
  ListItem: ['position', 'item', 'name', 'url', 'description', 'nextItem', 'previousItem'],
  OfferCatalog: ['itemListElement', 'numberOfItems', 'itemListOrder', 'name', 'url', 'description', 'image'],
  Offer: [...THING, 'itemOffered', 'price', 'priceCurrency', 'availability', 'itemCondition', 'seller', 'validFrom', 'priceValidUntil', 'eligibleRegion', 'areaServed', 'category', 'sku'],
  PostalAddress: [...THING, 'addressCountry', 'addressRegion', 'addressLocality', 'streetAddress', 'postalCode', 'postOfficeBoxNumber'],
};
const errors = [];
const fail = (page, field, value, msg = '') =>
  errors.push(`${page} :: ${field} :: ${String(value).slice(0, 140)}${msg ? '  → ' + msg : ''}`);

// ── 파일 수집 ──
const stat = fs.statSync(arg);
const baseDir = stat.isDirectory() ? arg : path.dirname(arg);
const roots = [...new Set([baseDir, DEFAULT])].filter((d) => fs.existsSync(d));
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}
const files = stat.isDirectory() ? walk(arg) : [arg];

// ── 텍스트 정규화 ──
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', times: '×', ndash: '–', mdash: '—', hellip: '…', sup2: '²', micro: 'µ', deg: '°' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return String.fromCodePoint(n); }
  return ENT[e.toLowerCase()] ?? m;
});
const fold = (s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
function visibleText(html) {
  let t = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  return fold(decode(t));
}
const pageTextCache = new Map();
function textOf(file) {
  if (!pageTextCache.has(file)) pageTextCache.set(file, visibleText(fs.readFileSync(file, 'utf8')));
  return pageTextCache.get(file);
}
function findInRoots(rel) {
  for (const r of roots) { const p = path.join(r, rel); if (fs.existsSync(p)) return p; }
  return null;
}
const enProductText = findInRoots('product/index.html') ? textOf(findInRoots('product/index.html')) : null;
const enTechText = findInRoots('technology/index.html') ? textOf(findInRoots('technology/index.html')) : null;

// ── 페이지 종류 ──
function urlPath(file) {
  let rel = path.relative(stat.isDirectory() ? arg : path.dirname(arg), file).split(path.sep).join('/');
  if (!stat.isDirectory()) rel = path.basename(file);
  rel = rel.replace(/(^|\/)index\.html$/, '$1');
  return '/' + rel.replace(/\.html$/, '');
}
function kindOf(p) {
  const q = p.replace(/^\/ko(?=\/)/, '').replace(/^\/ko$/, '/');
  if (/^\/product\/?$/.test(q)) return 'product';
  if (/^\/product\/(oxides|nitrides|metals|multilayers|wafers)\/?$/.test(q)) return 'category';
  if (/^\/wafers\/?$/.test(q)) return 'waferlist';
  if (/^\/wafers\/[^/]+\/?$/.test(q)) return 'waferdetail';
  if (/^\/materials\/m\d+\/?$/.test(q)) return 'material';
  return 'other';
}

// ── JSON-LD 추출 ──
function blocks(html, page) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1])); } catch (e) { fail(page, 'JSON parse', m[1].slice(0, 60), e.message); }
  }
  return out;
}
const topNodes = (b) => (Array.isArray(b['@graph']) ? b['@graph'] : [b]);
function* walkObjs(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walkObjs(x); }
  else if (v && typeof v === 'object') { yield v; for (const x of Object.values(v)) yield* walkObjs(x); }
}
function* walkStrings(v) {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* walkStrings(x);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* walkStrings(x);
}
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

const counts = {}; const bump = (k, n = 1) => (counts[k] = (counts[k] || 0) + n);
const pageExists = (urlStr) => {
  let p; try { p = new URL(urlStr).pathname; } catch { return false; }
  p = decodeURIComponent(p);
  const cands = [p.replace(/^\//, ''), path.join(p.replace(/^\//, ''), 'index.html'), p.replace(/^\//, '').replace(/\/$/, '') + '.html'];
  return cands.some((c) => c && findInRoots(c) && fs.statSync(findInRoots(c)).isFile());
};

for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const page = urlPath(file);
  const kind = kindOf(page);
  const text = textOf(file);
  const bl = blocks(html, page);
  const nodes = bl.flatMap(topNodes);
  const types = (n) => arr(n['@type']);
  const ofType = (t) => nodes.filter((n) => types(n).includes(t));
  const vis = (field, val) => { if (val == null || val === '') return; if (!text.includes(fold(String(val)))) fail(page, field, val, '화면 텍스트에 없음'); };

  // 기본: 모든 노드에 @type, 참조는 같은 페이지 또는 고정 @id
  const localIds = new Set();
  for (const o of walkObjs(bl)) if (o['@id'] && Object.keys(o).length > 1) localIds.add(o['@id']);
  for (const b of bl) for (const n of topNodes(b)) if (!n['@type']) fail(page, '@type 없음', JSON.stringify(n).slice(0, 80));
  for (const o of walkObjs(bl)) {
    const keys = Object.keys(o).filter((k) => k !== '@context');
    if (keys.length === 1 && keys[0] === '@id') {
      if (!localIds.has(o['@id']) && !FIXED_IDS.has(o['@id'])) fail(page, '@id 참조', o['@id'], '같은 페이지 노드도 고정 @id 도 아님');
    } else if (keys.length && !o['@type'] && !('@id' in o)) {
      // 평범한 값 객체는 없다(모든 객체가 @type 을 가진다)
      if (!('@graph' in o)) fail(page, '@type 없는 객체', JSON.stringify(o).slice(0, 80));
    }
  }
  // 내부 링크
  for (const s of walkStrings(bl)) {
    if (s.startsWith(SITE)) { const u = s.split('#')[0]; if (!pageExists(u)) fail(page, '내부 링크', s, 'dist 에 페이지 없음'); }
  }
  // 타입별 허용 속성 (Product·Blog·FAQ 등 기존 블록은 ALLOWED 에 없어 제외)
  for (const o of walkObjs(bl)) {
    const t = types(o).find((x) => ALLOWED[x]);
    if (!t) continue;
    for (const k of Object.keys(o)) if (!k.startsWith('@') && !ALLOWED[t].includes(k)) fail(page, `${t}.${k}`, JSON.stringify(o[k]), `schema.org ${t} 에 없는 속성`);
  }
  // Product 는 웨이퍼 상세에만
  for (const o of walkObjs(bl)) if (types(o).includes('Product') && kind !== 'waferdetail') fail(page, 'Product 타입', page, '웨이퍼 상세 외 사용 금지');
  // Organization / WebSite 공통
  if (bl.length) {
    const org = ofType('Organization')[0]; const ws = ofType('WebSite')[0];
    if (!org || org['@id'] !== ORG_ID) fail(page, 'Organization', org?.['@id'], '@id 없음');
    else {
      if (org.areaServed !== 'Worldwide') fail(page, 'Organization.areaServed', org.areaServed);
      if (arr(org.knowsAbout).length < 8 || arr(org.knowsAbout).length > 12) fail(page, 'knowsAbout 개수', arr(org.knowsAbout).length, '8~12');
      const offers = arr(org.hasOfferCatalog?.itemListElement);
      if (offers.length !== 4 || offers.some((o) => !FIXED_IDS.has(o.itemOffered?.['@id']))) fail(page, 'hasOfferCatalog', offers.length, 'Offer 4개 + 서비스 @id 참조');
      if (JSON.stringify(org).includes('"price')) fail(page, 'Organization', 'price', '가격 금지');
      if (page === '/' || kind === 'product') for (const k of arr(org.knowsAbout)) {
        const src = fold(k);
        if (!((enProductText && enProductText.includes(src)) || (enTechText && enTechText.includes(src)))) fail(page, 'knowsAbout', k, '/product/·/technology/(EN) 텍스트에 없음');
      }
    }
    if (!ws || ws['@id'] !== WEBSITE_ID || ws.publisher?.['@id'] !== ORG_ID) fail(page, 'WebSite', ws?.['@id'], 'publisher 가 Organization @id 참조여야 함');
  }

  // 종류별 필수 노드
  const need = (type, n = 1) => { const c = ofType(type).length; if (c < n) fail(page, `필수 노드 ${type}`, c, `${n}개 이상 필요`); return c; };
  const crumbVis = () => ofType('BreadcrumbList').forEach((b) => arr(b.itemListElement).forEach((li) => vis('BreadcrumbList.name', li.name)));
  if (kind === 'product') {
    bump('product');
    const svc = ofType('Service');
    if (svc.length !== 4) fail(page, '필수 노드 Service', svc.length, '4개');
    need('BreadcrumbList');
    for (const s of svc) {
      if (s['@id'].endsWith('service-deposition')) {
        if (s.name !== (page.startsWith('/ko') ? '맞춤형 박막 증착' : 'Custom thin-film deposition')) fail(page, 'Service.name', s.name, '증착 서비스는 고정 어구만 허용');
      } else vis('Service.name', s.name);
      vis('Service.description', s.description);
      if (s['@id'].endsWith('service-deposition')) for (const c of arr(s.hasOfferCatalog?.itemListElement)) if (!c.description) fail(page, '카테고리 description', c.name, '없음');
      if (s.areaServed !== 'Worldwide') fail(page, 'Service.areaServed', s.areaServed);
      if (s.provider?.['@id'] !== ORG_ID) fail(page, 'Service.provider', JSON.stringify(s.provider));
      if (JSON.stringify(s).includes('"price')) fail(page, 'Service', 'price', '가격 금지');
      for (const o of walkObjs(s.hasOfferCatalog)) { if (o.name !== s.name) vis('Service.catalog.name', o.name); vis('Service.catalog.description', o.description); }
    }
    const isKo = page.startsWith('/ko');
    for (const k of SERVICE_KEYS) if (!svc.some((s) => s['@id'] === `${SITE}${isKo ? '/ko' : ''}/product/#service-${k}`)) fail(page, 'Service @id', k, '없음');
    const dep = svc.find((s) => s['@id'].endsWith('service-deposition'));
    if (dep && arr(dep.hasOfferCatalog?.itemListElement).length !== 4) fail(page, 'deposition 카테고리 수', arr(dep.hasOfferCatalog?.itemListElement).length, '4');
    const eq = svc.find((s) => s['@id'].endsWith('service-equipment'));
    if (eq && arr(eq.hasOfferCatalog?.itemListElement).length !== 2) fail(page, 'equipment 하위 수', arr(eq.hasOfferCatalog?.itemListElement).length, '2');
    crumbVis();
  } else if (kind === 'category') {
    bump('category'); need('BreadcrumbList');
    for (const b of ofType('BreadcrumbList')) if (arr(b.itemListElement).length !== 3) fail(page, 'Breadcrumb 단계', arr(b.itemListElement).length, '3');
    crumbVis();
  } else if (kind === 'waferlist') {
    bump('waferlist'); need('BreadcrumbList'); need('ItemList');
    const cards = (html.match(/<article\b/g) || []).length;
    for (const l of ofType('ItemList')) {
      if (arr(l.itemListElement).length !== cards || l.numberOfItems !== cards) fail(page, 'ItemList 항목 수', `${arr(l.itemListElement).length}`, `화면 카드 ${cards}개`);
      arr(l.itemListElement).forEach((li) => vis('ItemList.name', li.name));
    }
    crumbVis();
  } else if (kind === 'waferdetail') {
    bump('waferdetail'); need('Product'); need('BreadcrumbList'); crumbVis();
  } else if (kind === 'material') {
    bump('material');
    need('BreadcrumbList'); const sv = need('Service');
    for (const b of ofType('BreadcrumbList')) if (arr(b.itemListElement).length !== 3) fail(page, 'Breadcrumb 단계', arr(b.itemListElement).length, '3');
    crumbVis();
    const rows = (html.match(/<li class="text-\[13px\]/g) || []).length;
    const ds = ofType('Dataset');
    if (rows > 0) { bump('material+dataset'); if (ds.length !== 1) fail(page, '필수 노드 Dataset', ds.length, `스펙 행 ${rows}개 → 1개`); }
    else if (ds.length) fail(page, 'Dataset', ds.length, '스펙 행이 없는데 Dataset 있음');
    if (ofType('Thing').length) fail(page, '옛 Thing 블록', ofType('Thing').length, '중복 블록 남음');
    for (const s of ofType('Service')) {
      vis('Service.description', s.description);
      if ('about' in s) fail(page, 'Service.about', JSON.stringify(s.about), 'serviceOutput 을 써야 함');
      vis('Service.serviceOutput.name', s.serviceOutput?.name);
      arr(s.serviceOutput?.alternateName).forEach((a) => vis('Service.serviceOutput.alternateName', a));
      vis('Service.category', s.category);
      arr(s.image).forEach((im) => vis('ImageObject.caption', im.caption));
      if (s.provider?.['@id'] !== ORG_ID) fail(page, 'Service.provider', JSON.stringify(s.provider));
      if (!String(s['@id']).endsWith('#service')) fail(page, 'Service.@id', s['@id']);
    }
    for (const d of ds) {
      const vm = arr(d.variableMeasured);
      if (vm.length !== rows) fail(page, 'variableMeasured 개수', vm.length, `화면 스펙 행 ${rows}개`);
      for (const v of vm) {
        const i = String(v.name).indexOf(': ');
        const title = i >= 0 ? v.name.slice(0, i) : v.name;
        const label = i >= 0 ? v.name.slice(i + 2) : null;
        vis('Dataset.variableMeasured.title', title); if (label) vis('Dataset.variableMeasured.label', label);
        vis('Dataset.variableMeasured.value', v.value);
      }
      const svc = ofType('Service')[0];
      if (svc && d.description !== svc.description && !/^(반암이 측정한 |.+ specifications measured by VanaM: )/.test(d.description)) fail(page, 'Dataset.description', d.description, '화면 설명도 규칙 문구도 아님');
      if (d.license) fail(page, 'Dataset.license', d.license, '넣지 않는다');
      if (d.isAccessibleForFree !== true || d.creator?.['@id'] !== ORG_ID) fail(page, 'Dataset', 'creator/isAccessibleForFree');
    }
  } else { bump('other'); }
}

console.log('check-structured-data 페이지 종류별:', JSON.stringify(counts));
if (errors.length) {
  console.error(`check-structured-data FAIL (${errors.length}건, ${arg}):`);
  for (const e of errors.slice(0, 60)) console.error('  - ' + e);
  if (errors.length > 60) console.error(`  … 외 ${errors.length - 60}건`);
  process.exit(1);
}
console.log(`check-structured-data OK (${files.length} HTML)`);
