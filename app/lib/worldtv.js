'use strict';
// World TV: публичният списък с канали на iptv-org (https://github.com/iptv-org/iptv).
// Плейлистата се тегли веднъж и се пази в папката с данни; обновява се на всеки 12 часа или с бутон.
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PLAYLIST_URL = 'https://iptv-org.github.io/iptv/index.m3u';
const MAX_AGE = 12 * 3600 * 1000;

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Kinoteka', 'Cache-Control': 'no-cache' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return resolve(get(new URL(res.headers.location, url).href, redirects - 1)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => res.statusCode === 200 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error('HTTP ' + res.statusCode)));
    }).on('error', reject).setTimeout(60000, function () { this.destroy(new Error('timeout')); });
  });
}

const attr = (line, name) => { const m = line.match(new RegExp('\\b' + name + '="([^"]*)"', 'i')); return m ? m[1].trim() : ''; };
const httpUrl = (u) => { try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };

// държавата от tvg-id: "BNT1.bg@SD" -> "BG" (iptv-org пише "uk" за Обединеното кралство)
function countryOf(id) {
  const m = String(id || '').match(/\.([a-z]{2})(?:@|$)/i);
  if (!m) return '';
  const c = m[1].toUpperCase();
  return c === 'UK' ? 'GB' : c;
}

function parse(text) {
  const out = [];
  let cur = null, opts = {};
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      // #EXTINF:-1 tvg-id="…" tvg-logo="…" group-title="…",Име на канала
      const head = line.match(/^#EXTINF:\s*-?[\d.]*((?:\s*[\w-]+="[^"]*")*)\s*,/i);
      let name = head ? line.slice(head[0].length) : line.slice(line.indexOf(',') + 1);
      const tags = [];
      name = name.replace(/\[([^\]]+)\]/g, (_m, t) => { tags.push(t.trim()); return ''; });
      const qm = name.match(/\((\d{3,4}[pi])\)/);
      if (qm) name = name.replace(qm[0], '');
      const tvgId = attr(line, 'tvg-id');
      cur = {
        name: name.replace(/\s+/g, ' ').trim(),
        tvgId,
        logo: httpUrl(attr(line, 'tvg-logo')) || '',
        groups: attr(line, 'group-title').split(';').map(s => s.trim()).filter(Boolean),
        country: countryOf(tvgId),
        quality: qm ? qm[1] : '',
        tags,
        referrer: attr(line, 'http-referrer'),
        ua: attr(line, 'http-user-agent')
      };
      opts = {};
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const [k, ...v] = line.slice(11).split('=');
      opts[k.trim().toLowerCase()] = v.join('=').trim();
    } else if (!line.startsWith('#') && cur) {
      const url = httpUrl(line);
      if (url && cur.name) {
        if (opts['http-referrer']) cur.referrer = opts['http-referrer'];
        if (opts['http-user-agent']) cur.ua = opts['http-user-agent'];
        if (!cur.groups.length) cur.groups = ['Undefined'];
        cur.url = url;
        if (!cur.groups.includes('XXX')) out.push(cur);
      }
      cur = null; opts = {};
    }
  }
  return out;
}

// връща { channels, updated, fromCache, error? }
async function load(dataDir, force = false) {
  const file = path.join(dataDir, 'worldtv.m3u');
  let st = null;
  try { st = fs.statSync(file); } catch {}
  if (!force && st && Date.now() - st.mtimeMs < MAX_AGE) {
    return { channels: parse(fs.readFileSync(file, 'utf8')), updated: st.mtimeMs, fromCache: true };
  }
  try {
    const text = await get(PLAYLIST_URL);
    const channels = parse(text);
    if (!channels.length) throw new Error('празна плейлиста');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file);
    return { channels, updated: Date.now(), fromCache: false };
  } catch (e) {
    if (st) return { channels: parse(fs.readFileSync(file, 'utf8')), updated: st.mtimeMs, fromCache: true, error: e.message };
    return { channels: [], updated: 0, error: e.message };
  }
}

// ---- проверка дали каналът отговаря (за скриване на мъртвите) -----------------
// Резултатите се пазят 24 часа. „Мъртъв“ = грешка/отказ (вкл. 403 — най-често блокиран за държавата).
const HEALTH_AGE = 24 * 3600 * 1000;
let health = null, healthFile = null, healthSaveT = null;
function healthLoad(dataDir) {
  if (health) return health;
  healthFile = path.join(dataDir, 'worldtv-health.json');
  try { health = JSON.parse(fs.readFileSync(healthFile, 'utf8')); } catch { health = {}; }
  const now = Date.now();
  for (const k in health) if (now - health[k].t > HEALTH_AGE) delete health[k];
  return health;
}
function healthSave() {
  clearTimeout(healthSaveT);
  healthSaveT = setTimeout(() => { try { fs.writeFileSync(healthFile, JSON.stringify(health)); } catch {} }, 2000);
}
function probe(ch) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
    const go = (url, left) => {
      let req;
      try {
        const headers = { 'User-Agent': ch.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' };
        if (ch.referrer) headers.Referer = ch.referrer;
        req = (url.startsWith('https:') ? https : http).get(url, { headers, timeout: 8000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) { res.resume(); return go(new URL(res.headers.location, url).href, left - 1); }
          if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return fin(false); }
          let got = '';
          res.on('data', (c) => { got += c.toString('latin1'); if (got.length > 2048) { res.destroy(); fin(!/\.m3u8?(\?|$)/i.test(url) || got.includes('#EXTM3U')); } });
          res.on('end', () => fin(got.length > 0 && (!/\.m3u8?(\?|$)/i.test(url) || got.includes('#EXTM3U'))));
          res.on('error', () => fin(got.length > 0));
        });
      } catch { return fin(false); }
      req.on('timeout', () => { req.destroy(); fin(false); });
      req.on('error', () => fin(false));
    };
    go(ch.url, 4);
  });
}
// chans: [{url, ua, referrer}] -> { url: true/false }
async function check(dataDir, chans) {
  const h = healthLoad(dataDir), out = {}, todo = [];
  for (const c of chans) { const u = httpUrl(c.url); if (!u) continue; if (h[u]) out[u] = h[u].ok; else todo.push({ ...c, url: u }); }
  let i = 0;
  const worker = async () => { while (i < todo.length) { const c = todo[i++]; const ok = await probe(c); h[c.url] = { ok, t: Date.now() }; out[c.url] = ok; } };
  await Promise.all(Array.from({ length: 10 }, worker));
  if (todo.length) healthSave();
  return out;
}
function known(dataDir) { const h = healthLoad(dataDir), out = {}; for (const k in h) out[k] = h[k].ok; return out; }
function mark(dataDir, url, ok) { const h = healthLoad(dataDir); h[url] = { ok, t: Date.now() }; healthSave(); }

module.exports = { parse, load, countryOf, httpUrl, check, known, mark, PLAYLIST_URL };
