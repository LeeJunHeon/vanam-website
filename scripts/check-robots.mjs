// robots.txt gate: RFC 9309 style matcher; every crawler must get the same rules.
import fs from 'node:fs';

const file = process.argv[2] || 'dist/client/robots.txt';
const buf = fs.readFileSync(file);
const text = buf.toString('utf8');
const errors = [];

// ---- parse groups ----
const groups = [];
let cur = null, lastWasUA = false;
for (const raw of text.split(/\r?\n/)) {
  const line = raw.replace(/#.*$/, '').trim();
  if (!line) continue;
  const i = line.indexOf(':');
  if (i < 0) continue;
  const key = line.slice(0, i).trim().toLowerCase();
  const val = line.slice(i + 1).trim();
  if (key === 'user-agent') {
    if (!cur || !lastWasUA) { cur = { agents: [], rules: [] }; groups.push(cur); }
    cur.agents.push(val.toLowerCase());
    lastWasUA = true;
  } else {
    lastWasUA = false;
    if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val });
  }
}

function pickGroup(bot) {
  const b = bot.toLowerCase();
  return groups.find((g) => g.agents.includes(b)) || groups.find((g) => g.agents.includes('*')) || null;
}
function toRe(p) {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}
function allowed(bot, path) {
  const g = pickGroup(bot);
  if (!g) return true;
  let best = null;
  for (const r of g.rules) {
    if (r.path === '') continue;
    if (!toRe(r.path).test(path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

const bots = ['Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot', 'CCBot', 'Bytespider', 'SomeUnknownBot', 'gptbot'];
const okPaths = ['/', '/ko/', '/materials/', '/ko/materials/m05/', '/product/oxides/', '/wafers/', '/blog/', '/llms.txt', '/llms-full.txt', '/sitemap-index.xml', '/og.png'];
const blockPaths = ['/admin', '/admin/quote', '/keystatic', '/keystatic/branch/main', '/api/inquiry', '/api/keystatic/tree'];

for (const b of bots) {
  for (const p of okPaths) if (!allowed(b, p)) errors.push(`${b} ${p}: expected allow, got block`);
  for (const p of blockPaths) if (allowed(b, p)) errors.push(`${b} ${p}: expected block, got allow`);
}

const lines = text.split(/\r?\n/);
if (!lines.includes('Content-Signal: search=yes, ai-input=yes, ai-train=yes')) errors.push('Content-Signal line missing or not exactly "search=yes, ai-input=yes, ai-train=yes"');
if (!lines.includes('Sitemap: https://vanam.co.kr/sitemap-index.xml')) errors.push('Sitemap line missing: https://vanam.co.kr/sitemap-index.xml');
if (buf.some((c) => c > 127)) errors.push('file contains non-ASCII bytes');
if (lines.some((l) => /^\s*disallow\s*:\s*\/\s*$/i.test(l))) errors.push('found "Disallow: /" (blocks whole site)');

if (errors.length) {
  console.error(`check-robots FAIL (${file}):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`check-robots OK (${file}): ${bots.length} crawlers x ${okPaths.length + blockPaths.length} paths`);
