'use strict';
// =========================================================================
// ОНЛАЙН ФИЛМИ — клиент за протокола на добавките на Stremio
// (manifest.json → catalog / meta / stream / subtitles).
// Пускаме само потоци с директен адрес (http/https, вкл. HLS). Торенти
// (infoHash) не се поддържат и се показват като „не се поддържа“.
// =========================================================================

// Официални добавки на Stremio, които идват с програмата. Няма торент добавки.
const DEFAULT_ADDONS = [
  'https://v3-cinemeta.strem.io/manifest.json',      // каталози и информация за филми/сериали
  'https://opensubtitles-v3.strem.io/manifest.json'  // субтитри
];
// WatchHub беше стандартна в 0.8.0, но данните ѝ са само за клиенти с разрешение от Stremio — махаме я
const DROPPED = ['https://watchhub.strem.io/manifest.json'];

// stremio://… → https://…, добавя /manifest.json, ако липсва
function normUrl(u) {
  u = String(u || '').trim();
  if (!u) throw new Error('Постави адрес на добавка.');
  u = u.replace(/^stremio:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const url = new URL(u);
  if (!/\/manifest\.json$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/+$/, '') + '/manifest.json';
  return url.toString();
}
const baseOf = (manifestUrl) => manifestUrl.replace(/\/manifest\.json(\?.*)?$/i, '');

async function getJson(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' }, redirect: 'follow' });
    if (!r.ok) throw new Error('Сървърът върна грешка ' + r.status);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Добавката не отговаря.');
    throw e;
  } finally { clearTimeout(t); }
}

async function fetchManifest(url) {
  const m = await getJson(url);
  if (!m || typeof m !== 'object' || !m.id || !Array.isArray(m.resources)) throw new Error('Това не е добавка на Stremio (липсва manifest).');
  return m;
}

// поддържа ли добавката ресурса за този тип и id?
function supports(m, resource, type, id) {
  for (const r of m.resources || []) {
    const name = typeof r === 'string' ? r : r && r.name;
    if (name !== resource) continue;
    const types = (typeof r === 'object' && r.types) || m.types || [];
    const prefixes = (typeof r === 'object' && r.idPrefixes) || m.idPrefixes;
    if (types.length && !types.includes(type)) continue;
    if (id && Array.isArray(prefixes) && prefixes.length && !prefixes.some(p => String(id).startsWith(p))) continue;
    return true;
  }
  return false;
}

function resUrl(manifestUrl, resource, type, id, extra) {
  let u = `${baseOf(manifestUrl)}/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
  const e = Object.entries(extra || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (e.length) u += '/' + e.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return u + '.json';
}

// ---- съхранение ----------------------------------------------------------
// db.stremio = { addons: [{ url, manifest, builtin }], seeded: true }
function state(db) {
  if (!db.stremio) db.stremio = { addons: [] };
  return db.stremio;
}

async function ensureDefaults(db, save) {
  const st = state(db);
  if (st.addons.some(a => a.builtin && DROPPED.includes(a.url))) { st.addons = st.addons.filter(a => !(a.builtin && DROPPED.includes(a.url))); save(); }
  if (st.seeded) return;
  for (const url of DEFAULT_ADDONS) {
    if (st.addons.some(a => a.url === url)) continue;
    try { st.addons.push({ url, manifest: await fetchManifest(url), builtin: true }); } catch {}
  }
  if (st.addons.length) { st.seeded = true; save(); }
}

async function refreshManifests(db, save) {
  const st = state(db);
  await Promise.all(st.addons.map(async a => { try { a.manifest = await fetchManifest(a.url); } catch {} }));
  save();
}

async function add(db, save, rawUrl) {
  const url = normUrl(rawUrl);
  const st = state(db);
  const m = await fetchManifest(url);
  const old = st.addons.find(a => a.url === url || (a.manifest && a.manifest.id === m.id));
  if (old) { old.url = url; old.manifest = m; } else st.addons.push({ url, manifest: m });
  save();
  return m;
}

function remove(db, save, url) {
  const st = state(db);
  st.addons = st.addons.filter(a => a.url !== url);
  st.seeded = true;
  save();
}

function restoreDefaults(db, save) { state(db).seeded = false; return ensureDefaults(db, save); }

const summary = (a) => {
  const m = a.manifest || {};
  const res = (m.resources || []).map(r => typeof r === 'string' ? r : r.name);
  return { url: a.url, builtin: !!a.builtin, id: m.id, name: m.name || m.id, version: m.version, description: m.description || '', logo: m.logo || m.icon || '',
    resources: res, types: m.types || [], catalogs: (m.catalogs || []).length, p2p: !!(m.behaviorHints && m.behaviorHints.p2p) };
};

// каталози за разглеждане (без тези, които искат задължителни данни без избор)
function catalogs(db) {
  const out = [];
  for (const a of state(db).addons) {
    const m = a.manifest; if (!m) continue;
    for (const c of m.catalogs || []) {
      const extra = c.extra || (c.extraSupported || []).map(name => ({ name, isRequired: (c.extraRequired || []).includes(name) }));
      const req = extra.filter(e => e.isRequired);
      if (req.some(e => e.name !== 'genre' || !(e.options && e.options.length))) continue;
      const genre = extra.find(e => e.name === 'genre');
      out.push({
        addon: a.url, addonName: m.name, type: c.type, id: c.id, name: c.name || m.name,
        search: extra.some(e => e.name === 'search'), skip: extra.some(e => e.name === 'skip'),
        genres: genre && genre.options ? genre.options : [], genreRequired: !!(genre && genre.isRequired)
      });
    }
  }
  return out;
}

async function catalog(db, { addon, type, id, extra }) {
  const a = state(db).addons.find(x => x.url === addon);
  if (!a) throw new Error('Добавката не е намерена.');
  const r = await getJson(resUrl(a.url, 'catalog', type, id, extra));
  return (r && Array.isArray(r.metas) ? r.metas : []).filter(m => m && m.id).map(cleanMeta);
}

function cleanMeta(m) {
  return {
    id: String(m.id), type: m.type, name: m.name || '', poster: m.poster || '', background: m.background || '', logo: m.logo || '',
    description: m.description || '', releaseInfo: m.releaseInfo || (m.year ? String(m.year) : ''), imdbRating: m.imdbRating || '',
    genres: m.genres || m.genre || [], runtime: m.runtime || '', cast: m.cast || [], director: m.director || [],
    videos: Array.isArray(m.videos) ? m.videos.map(v => ({ id: String(v.id), title: v.title || v.name || '', season: v.season, episode: v.episode != null ? v.episode : v.number,
      released: v.released || '', thumbnail: v.thumbnail || '', overview: v.overview || v.description || '' })) : undefined,
    trailers: (m.trailers || []).filter(t => t && t.source).map(t => t.source)
  };
}

async function meta(db, { type, id, addon }) {
  const list = state(db).addons.filter(a => a.manifest && supports(a.manifest, 'meta', type, id));
  // първо добавката, от която дойде заглавието (ако дава meta), после останалите
  list.sort((x, y) => (y.url === addon) - (x.url === addon));
  for (const a of list) {
    try { const r = await getJson(resUrl(a.url, 'meta', type, id)); if (r && r.meta) return cleanMeta(r.meta); } catch {}
  }
  return null;
}

function classify(s, addonName) {
  const base = { addon: addonName, name: s.name || addonName, title: s.title || s.description || '' };
  const bh = s.behaviorHints || {};
  if (s.url && /^https?:\/\//i.test(s.url)) {
    const hdr = (bh.proxyHeaders && bh.proxyHeaders.request) || {};
    return { ...base, kind: 'play', url: s.url, headers: hdr, notWeb: !!bh.notWebReady, subtitles: (s.subtitles || []).filter(x => x && x.url).map(x => ({ url: x.url, lang: x.lang || '' })) };
  }
  if (s.ytId) return { ...base, kind: 'external', url: 'https://www.youtube.com/watch?v=' + encodeURIComponent(s.ytId), label: 'YouTube' };
  if (s.externalUrl && /^https:\/\//i.test(s.externalUrl)) return { ...base, kind: 'external', url: s.externalUrl, label: (() => { try { return new URL(s.externalUrl).hostname.replace(/^www\./, ''); } catch { return 'сайт'; } })() };
  if (s.infoHash || (s.url && /^magnet:/i.test(s.url))) return { ...base, kind: 'unsupported', why: 'торент — не се поддържа' };
  return { ...base, kind: 'unsupported', why: 'неизвестен вид поток' };
}

async function streams(db, { type, id }) {
  const list = state(db).addons.filter(a => a.manifest && supports(a.manifest, 'stream', type, id));
  const res = await Promise.all(list.map(async a => {
    try {
      const r = await getJson(resUrl(a.url, 'stream', type, id), 25000);
      return { addon: a.manifest.name, streams: (r && Array.isArray(r.streams) ? r.streams : []).map(s => classify(s, a.manifest.name)) };
    } catch (e) { return { addon: a.manifest.name, error: e.message, streams: [] }; }
  }));
  return { sources: list.length, results: res };
}

async function subtitles(db, { type, id }) {
  const list = state(db).addons.filter(a => a.manifest && supports(a.manifest, 'subtitles', type, id));
  const res = await Promise.all(list.map(async a => {
    try {
      const r = await getJson(resUrl(a.url, 'subtitles', type, id), 15000);
      return (r && Array.isArray(r.subtitles) ? r.subtitles : []).filter(s => s && s.url && /^https?:\/\//i.test(s.url)).map(s => ({ url: s.url, lang: s.lang || '', addon: a.manifest.name }));
    } catch { return []; }
  }));
  return res.flat();
}

module.exports = { DEFAULT_ADDONS, normUrl, baseOf, supports, resUrl, classify, ensureDefaults, refreshManifests, add, remove, restoreDefaults, summary, catalogs, catalog, meta, streams, subtitles, state };
