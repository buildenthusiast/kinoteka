'use strict';
// Телевизионна програма (EPG) за World TV.
// 1) Индекс: guides.json на iptv-org казва за кой канал има програма и от кой източник.
//    Ползваме само източниците, които дават готови XMLTV файлове: i.mjh.nz и epgshare01.online.
// 2) За канал без точно съответствие търсим по име във файла на epgshare01 за неговата държава.
// Файловете се теглят при нужда и се пазят в паметта (и на диска) няколко часа.
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const GUIDES_URL = 'https://raw.githubusercontent.com/iptv-org/api/gh-pages/guides.json';
const INDEX_AGE = 7 * 24 * 3600 * 1000;
const FILE_AGE = 6 * 3600 * 1000;

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Kinoteka', 'Accept-Encoding': 'identity' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return resolve(get(new URL(res.headers.location, url).href, redirects - 1)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error('HTTP ' + res.statusCode)));
    }).on('error', reject).setTimeout(90000, function () { this.destroy(new Error('timeout')); });
  });
}

function sourceUrl(site, siteId) {
  const [file, id] = String(siteId).split('#');
  if (!file || !id) return null;
  if (site === 'i.mjh.nz') return { url: `https://i.mjh.nz/${file}.xml.gz`, id };
  if (site === 'epgshare01.online') return { url: `https://epgshare01.online/epgshare01/epg_ripper_${file}.xml.gz`, id };
  return null;
}

// компактен индекс: { exact: { "BNT1.bg": [{url,id,feed}] }, byCountry: { BG: [url, …] } }
function buildIndex(guides) {
  const exact = {}, byCountry = {};
  for (const g of guides) {
    const s = sourceUrl(g.site, g.site_id);
    if (!s) continue;
    if (g.channel) (exact[g.channel] = exact[g.channel] || []).push({ ...s, feed: g.feed || '' });
    if (g.site === 'epgshare01.online') {
      const m = String(g.site_id).match(/^([A-Z]{2})\d#/);
      if (m) { const c = m[1] === 'UK' ? 'GB' : m[1]; const list = byCountry[c] = byCountry[c] || []; if (!list.includes(s.url)) list.push(s.url); }
    }
  }
  return { exact, byCountry };
}

let index = null, indexP = null;
async function getIndex(dataDir) {
  if (index) return index;
  if (indexP) return indexP;
  indexP = (async () => {
    const file = path.join(dataDir, 'epg-index.json');
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < INDEX_AGE) return (index = JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {}
    try {
      index = buildIndex(JSON.parse((await get(GUIDES_URL)).toString('utf8')));
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(index));
    } catch (e) {
      try { index = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { index = { exact: {}, byCountry: {} }; }
    }
    return index;
  })();
  try { return await indexP; } finally { indexP = null; }
}

const unxml = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&').trim();
// "20261111190000 +0200" -> ms
function xmltvTime(s) {
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
  if (!m) return 0;
  let t = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) { const sign = m[7][0] === '-' ? -1 : 1; t -= sign * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(3), 10)) * 60000; }
  return t;
}

// <episode-num system="xmltv_ns">0.4.</episode-num> (от нула) или onscreen „S1 E5“ -> { s: 1, e: 5 }
function episodeNum(body) {
  for (const m of body.matchAll(/<episode-num[^>]*system="([^"]*)"[^>]*>([\s\S]*?)<\/episode-num>/g)) {
    const v = unxml(m[2]);
    if (m[1] === 'xmltv_ns') {
      const x = v.match(/^\s*(\d+)?\s*(?:\/\s*\d+)?\s*\.\s*(\d+)/);
      if (x) return { s: x[1] ? +x[1] + 1 : 1, e: +x[2] + 1 };
    } else {
      const x = v.match(/s\s*(\d{1,2})\s*[.\s-]*e\s*(\d{1,4})/i);
      if (x) return { s: +x[1], e: +x[2] };
    }
  }
  return null;
}

// парсира XMLTV; пази само предавания от последните 3 часа до следващите 36
function parseXmltv(xml, now = Date.now()) {
  const channels = {}, progs = {};
  const chRe = /<channel\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = chRe.exec(xml))) {
    const names = [...m[2].matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)].map(x => unxml(x[1]));
    channels[unxml(m[1])] = names;
  }
  const pRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  const from = now - 3 * 3600e3, to = now + 36 * 3600e3;
  while ((m = pRe.exec(xml))) {
    const a = m[1];
    const start = xmltvTime((a.match(/start="([^"]*)"/) || [])[1]);
    const stop = xmltvTime((a.match(/stop="([^"]*)"/) || [])[1]);
    if (!start || !stop || stop < from || start > to) continue;
    const ch = unxml((a.match(/channel="([^"]*)"/) || [])[1]);
    const title = unxml((m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
    const desc = unxml((m[2].match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1]).slice(0, 400);
    const p = { start, stop, title, desc };
    const sub = unxml((m[2].match(/<sub-title[^>]*>([\s\S]*?)<\/sub-title>/) || [])[1]);
    if (sub) p.sub = sub.slice(0, 200);
    const ep = episodeNum(m[2]);
    if (ep) p.ep = ep;
    (progs[ch] = progs[ch] || []).push(p);
  }
  for (const k in progs) progs[k].sort((x, y) => x.start - y.start);
  return { channels, progs };
}

const files = new Map();   // url -> { t, data } | Promise
async function loadFile(dataDir, url) {
  const c = files.get(url);
  if (c && c.t && Date.now() - c.t < FILE_AGE) return c.data;
  if (c && c.p) return c.p;
  const p = (async () => {
    const cacheDir = path.join(dataDir, 'epg');
    const file = path.join(cacheDir, url.replace(/[^\w.-]+/g, '_'));
    let buf = null;
    try { const st = fs.statSync(file); if (Date.now() - st.mtimeMs < FILE_AGE) buf = fs.readFileSync(file); } catch {}
    if (!buf) {
      buf = await get(url);
      try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file, buf); } catch {}
    }
    const xml = (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8');
    const data = parseXmltv(xml);
    files.set(url, { t: Date.now(), data });
    return data;
  })();
  files.set(url, { p });
  try { return await p; } catch (e) { files.delete(url); throw e; }
}

const norm = (s) => String(s || '').toLowerCase().replace(/\.[a-z]{2}$/, '').replace(/\b(hd|sd|fhd|uhd|4k|tv)\b/g, '').replace(/[^a-z0-9а-я]+/g, '');

function pick(progs, now) {
  if (!progs || !progs.length) return null;
  const i = progs.findIndex(p => p.stop > now);
  if (i < 0) return null;
  const list = progs.slice(i, i + 6);
  return { now: list[0].start <= now ? list[0] : null, next: list[0].start <= now ? list.slice(1) : list };
}

// всички предавания на канала (от 3 часа назад до 36 напред); ch: { tvgId, name, country }
async function programmes(dataDir, ch) {
  const idx = await getIndex(dataDir);
  const now = Date.now();
  const ok = (l) => l && l.length && l.some(p => p.stop > now);
  const [id, feed] = String(ch.tvgId || '').split('@');
  const exact = (idx.exact[id] || []).slice().sort((a, b) => (b.feed === feed) - (a.feed === feed));
  for (const s of exact.slice(0, 3)) {
    try { const l = (await loadFile(dataDir, s.url)).progs[s.id]; if (ok(l)) return l; } catch {}
  }
  // по име във файла на държавата
  const want = [norm(ch.name), norm(id)].filter(Boolean);
  for (const url of (idx.byCountry[ch.country] || []).slice(0, 2)) {
    try {
      const d = await loadFile(dataDir, url);
      for (const [cid, names] of Object.entries(d.channels)) {
        if ([cid, ...names].some(n => want.includes(norm(n))) && ok(d.progs[cid])) return d.progs[cid];
      }
    } catch {}
  }
  return null;
}
async function forChannel(dataDir, ch) { return pick(await programmes(dataDir, ch), Date.now()); }

module.exports = { forChannel, programmes, episodeNum, parseXmltv, xmltvTime, buildIndex, sourceUrl, norm };
