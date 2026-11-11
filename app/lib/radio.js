'use strict';
// Радио: българските радиостанции от https://www.radiosbg.com/.
// Списъкът и известните адреси на потоците са в radio-stations.json. Ако някой адрес не работи,
// програмата чете страницата на радиото в radiosbg.com и взима адресите оттам (пазят се в папката с данни).
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SITE = 'https://www.radiosbg.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function get(url, { redirects = 5, max = 3 * 1024 * 1024, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return resolve(get(new URL(res.headers.location, url).href, { redirects: redirects - 1, max, timeout })); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = []; let n = 0;
      res.on('data', c => { chunks.push(c); n += c.length; if (n > max) { req.destroy(); resolve({ body: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] || '', url }); } });
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] || '', url }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
  });
}

const httpUrl = (u) => { try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const unique = (a) => [...new Set(a.filter(Boolean))];

// адреси на аудио потоци в страница на radiosbg.com. Плейърът е в три вида:
//   MRP.insert({ 'url':'https://…', … })  ·  <audio src="…">  ·  <a class="play" src="…">
const NOT_STREAM = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|html?)(\?|#|$)|radiosbg\.com|muses\.org|facebook|twitter|google|instagram|youtube|w3\.org|schema\.org|jquery|cloudflare|gstatic/i;
const abs = (u) => { u = String(u || '').trim().replace(/&amp;/g, '&'); return httpUrl(u.startsWith('//') ? 'https:' + u : u); };
function findStreams(html) {
  const text = String(html).replace(/\\\//g, '/');
  const out = [];
  const re = [/['"]url['"]\s*:\s*['"]([^'"]+)['"]/gi, /<(?:audio|source)\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi, /<a\b[^>]*class\s*=\s*["'][^"']*\bplay\b[^"']*["'][^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi,
    /<a\b[^>]*?\ssrc\s*=\s*["']([^"']+)["'][^>]*class\s*=\s*["'][^"']*\bplay\b/gi];
  for (const r of re) for (const m of text.matchAll(r)) { const u = abs(m[1]); if (u && !NOT_STREAM.test(u)) out.push(u); }
  return unique(out);
}

// .pls / .m3u (не HLS) → истинските адреси
async function expand(url) {
  if (!/\.(pls|m3u)(\?|#|$)/i.test(url)) return [url];
  try {
    const r = await get(url, { max: 200000, timeout: 10000 });
    if (/^#EXTM3U/m.test(r.body) && /#EXT-X-/m.test(r.body)) return [url];   // всъщност HLS
    const out = [];
    for (const line of r.body.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:File\d+\s*=\s*)?(https?:\/\/\S+)/i);
      if (m) out.push(httpUrl(new URL(m[1], url).href));
    }
    return out.length ? unique(out) : [url];
  } catch { return [url]; }
}

let stations = null;
function list() {
  if (!stations) {
    stations = JSON.parse(fs.readFileSync(path.join(__dirname, 'radio-stations.json'), 'utf8'))
      .filter(s => s && s.name && s.slug)
      .map(s => ({ name: String(s.name), slug: String(s.slug), logo: httpUrl(s.logo) || '', streams: (s.streams || []).map(abs).filter(Boolean) }));
  }
  return stations;
}

function cacheFile(dataDir) { return path.join(dataDir, 'radio-streams.json'); }
function readCache(dataDir) { try { return JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8')) || {}; } catch { return {}; } }
function writeCache(dataDir, c) { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(cacheFile(dataDir), JSON.stringify(c)); } catch {} }

// връща { streams: [...] } — първо запомнените/вградените, а с force — пресни от radiosbg.com
async function resolve(dataDir, slug, force) {
  const s = list().find(x => x.slug === slug);
  if (!s) return { streams: [] };
  const cache = readCache(dataDir);
  let fresh = [];
  if (force || (!s.streams.length && !(cache[slug] && cache[slug].length))) {
    try {
      fresh = findStreams((await get(SITE + '/radio/' + encodeURI(decodeURI(slug)))).body);
      if (fresh.length) { cache[slug] = fresh; writeCache(dataDir, cache); }
    } catch {}
  }
  const raw = unique([...fresh, ...(cache[slug] || []), ...s.streams]);
  const out = [];
  for (const u of raw) out.push(...await expand(u));
  return { streams: unique(out).slice(0, 8) };
}

module.exports = { list, resolve, findStreams, expand, httpUrl, SITE };
