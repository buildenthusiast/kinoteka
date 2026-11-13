'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const scanner = require('./lib/scanner');
const media = require('./lib/media');
const tmdb = require('./lib/tmdb');
const intro = require('./lib/intro');
const opensubs = require('./lib/opensubs');
const updater = require('./lib/updater');
const worldtv = require('./lib/worldtv');
const epg = require('./lib/epg');
const subsync = require('./lib/subsync');
const radio = require('./lib/radio');
const recorder = require('./lib/recorder');
const stremio = require('./lib/stremio');
const crypto = require('crypto');

let win, server;
const DATA = () => app.getPath('userData');
const DB_FILE = () => path.join(DATA(), 'library.json');
const THUMBS = () => path.join(DATA(), 'thumbs');

let db = { folders: [], movies: [], series: [], progress: {}, meta: {}, intros: {}, stats: { total: 0, byItem: {}, byDay: {} }, settings: { tmdbKey: '', autoNext: true, subSize: 100 } };
const index = { files: new Map(), images: new Map() };

function load() {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE(), 'utf8'))); } catch {}
  db.settings = Object.assign({ tmdbKey: '', autoNext: true, subSize: 100, favs: [], watch: [] }, db.settings);
  db.intros = db.intros || {};
  db.stats = Object.assign({ total: 0, byItem: {}, byDay: {} }, db.stats);
  if (!Array.isArray(db.profiles) || !db.profiles.length) db.profiles = [{ id: 'main', name: 'Аз', color: '#f5b83d' }];
  if (!db.profiles.some(p => p.id === db.curProfile)) db.curProfile = db.profiles[0].id;
  db.profileData = db.profileData || {};
  db.recRules = db.recRules || []; db.recs = db.recs || []; db.recOnce = db.recOnce || []; db.recSkip = db.recSkip || {};
  rebuildIndex();
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA(), { recursive: true });
    const tmp = DB_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE());
  }, 300);
}

function rebuildIndex() {
  index.files.clear(); index.images.clear();
  for (const m of db.movies) index.files.set(m.id, m.file);
  for (const s of db.series) for (const e of s.episodes) index.files.set(e.id, e.file);
}
function imageFor(id) {
  // id = "<itemId>:<kind>" kind: poster | thumb | backdrop
  const [itemId, kind] = String(id).split(':');
  const meta = db.meta[itemId] || {};
  if (kind === 'thumb') return path.join(THUMBS(), itemId + '.jpg');
  if (kind === 'backdrop') return meta.backdrop || null;
  const item = db.movies.find(m => m.id === itemId) || db.series.find(s => s.id === itemId);
  return (item && item.localPoster) || meta.poster || null;
}

function notify(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }

// ---- сканиране и метаданни --------------------------------------------
let scanning = false;
async function rescan() {
  if (scanning) return;
  scanning = true;
  notify('scan-status', { phase: 'files' });
  const roots = db.folders.filter(f => fs.existsSync(f));
  const { movies, series } = scanner.scanLibrary(roots);
  // запазваме продължителността от предишното сканиране
  const oldDur = new Map();
  for (const m of db.movies) if (m.duration) oldDur.set(m.id, m.duration);
  for (const s of db.series) for (const e of s.episodes) if (e.duration) oldDur.set(e.id, e.duration);
  for (const m of movies) m.duration = oldDur.get(m.id) || 0;
  for (const s of series) for (const e of s.episodes) e.duration = oldDur.get(e.id) || 0;
  db.movies = movies; db.series = series;
  rebuildIndex(); save();
  notify('library-changed');
  scanning = false;
  backgroundWork();
}

const metaKey = (i) => i.title + '|' + (i.year || '') + '|v2';
let working = false;
async function backgroundWork() {
  if (working) return;
  working = true;
  try {
    fs.mkdirSync(THUMBS(), { recursive: true });
    const jobs = [];
    for (const m of db.movies) jobs.push(m);
    for (const s of db.series) for (const e of s.episodes) jobs.push(e);
    const todo = jobs.filter(j => !j.duration || !fs.existsSync(path.join(THUMBS(), j.id + '.jpg')));
    let done = 0;
    const worker = async () => {
      while (todo.length) {
        const j = todo.shift();
        if (!j.duration) { const info = await media.probe(j.file); if (info) j.duration = info.duration; }
        const out = path.join(THUMBS(), j.id + '.jpg');
        if (!fs.existsSync(out)) await media.thumbnail(j.file, out, Math.max(5, Math.min(600, (j.duration || 600) * 0.12)));
        done++;
        if (done % 6 === 0) { save(); notify('library-changed'); }
        notify('scan-status', { phase: 'thumbs', done, total: done + todo.length });
      }
    };
    await Promise.all([worker(), worker()]);
    save(); notify('library-changed');

    if (db.settings.tmdbKey) {
      const items = [...db.movies, ...db.series].filter(i => !db.meta[i.id] || db.meta[i.id].key !== metaKey(i));
      let n = 0;
      for (const it of items) {
        n++;
        notify('scan-status', { phase: 'meta', done: n, total: items.length });
        try {
          const r = await tmdb.lookup(db.settings.tmdbKey, it.type, it.title, it.year);
          const meta = { key: metaKey(it) };
          if (r) {
            Object.assign(meta, { titleBg: r.titleBg, overview: r.overview, rating: r.rating, tmdbYear: r.year, tmdbId: r.tmdbId, genres: r.genres });
            if (r.posterPath) meta.poster = await tmdb.download(r.posterPath, 'w342', path.join(THUMBS(), it.id + '-poster.jpg'));
            if (r.backdropPath) meta.backdrop = await tmdb.download(r.backdropPath, 'w1280', path.join(THUMBS(), it.id + '-backdrop.jpg'));
          }
          db.meta[it.id] = meta;
          if (n % 5 === 0) { save(); notify('library-changed'); }
        } catch (e) {
          if (/HTTP 401/.test(e.message)) { notify('toast', 'TMDB ключът е невалиден.'); break; }
        }
      }
      save(); notify('library-changed');
    }
  } finally {
    working = false;
    notify('scan-status', { phase: 'idle' });
  }
}

// ---- IPC ---------------------------------------------------------------
function libraryForRenderer() {
  const img = (id, kind) => `${server.base}/img?k=${server.token}&id=${encodeURIComponent(id + ':' + kind)}`;
  const decorate = (it) => {
    const meta = db.meta[it.id] || {};
    const hasPoster = !!(it.localPoster || meta.poster);
    return { ...it, displayTitle: meta.titleBg || it.title, overview: meta.overview || '', rating: meta.rating || null, genres: meta.genres || [],
      poster: hasPoster ? img(it.id, 'poster') : null, backdrop: meta.backdrop ? img(it.id, 'backdrop') : null };
  };
  return {
    folders: db.folders,
    settings: db.settings,
    stats: db.stats,
    progress: db.progress,
    profiles: db.profiles,
    curProfile: db.curProfile,
    movies: db.movies.map(m => ({ ...decorate(m), thumb: img(m.id, 'thumb') })),
    series: db.series.map(s => ({ ...decorate(s), thumb: s.episodes[0] ? img(s.episodes[0].id, 'thumb') : null,
      episodes: s.episodes.map(e => ({ ...e, thumb: img(e.id, 'thumb') })) }))
  };
}

ipcMain.handle('library:get', () => libraryForRenderer());

// ---- профили -----------------------------------------------------------
// Всеки профил има свои любими, „за гледане“, прогрес, статистика, канали и радиа.
// Данните на текущия профил стоят на обичайните места (db.progress, db.settings.favs …),
// а тези на останалите — в db.profileData[id].
const PROFILE_KEYS = ['favs', 'watch', 'contHidden', 'wtvFavs', 'wtvRecent', 'radioFavs'];
function stashProfile() {
  const d = { progress: db.progress, stats: db.stats };
  for (const k of PROFILE_KEYS) d[k] = db.settings[k];
  db.profileData[db.curProfile] = d;
}
function loadProfile(id) {
  const d = db.profileData[id] || {};
  db.progress = d.progress || {};
  db.stats = Object.assign({ total: 0, byItem: {}, byDay: {} }, d.stats);
  for (const k of PROFILE_KEYS) db.settings[k] = d[k] !== undefined ? d[k] : (k === 'contHidden' ? {} : []);
  delete db.profileData[id];
  db.curProfile = id;
}
ipcMain.handle('profile:switch', (_e, id) => {
  if (id === db.curProfile || !db.profiles.some(p => p.id === id)) return libraryForRenderer();
  stashProfile(); loadProfile(id); save();
  return libraryForRenderer();
});
ipcMain.handle('profile:save', (_e, p) => {
  const name = String((p && p.name) || '').trim().slice(0, 30);
  if (!name) return { error: 'Въведи име.' };
  const ex = db.profiles.find(x => x.id === p.id);
  if (ex) Object.assign(ex, { name, kids: !!p.kids });
  else db.profiles.push({ id: 'p' + Date.now().toString(36), name, kids: !!p.kids, color: ['#5aa9e6', '#7fc8a9', '#e86a92', '#b28dff', '#ff9f43'][db.profiles.length % 5] });
  save();
  return libraryForRenderer();
});
ipcMain.handle('profile:remove', (_e, id) => {
  if (db.profiles.length < 2 || !db.profiles.some(p => p.id === id)) return libraryForRenderer();
  if (id === db.curProfile) loadProfile(db.profiles.find(p => p.id !== id).id);
  db.profiles = db.profiles.filter(p => p.id !== id);
  delete db.profileData[id];
  save();
  return libraryForRenderer();
});
ipcMain.handle('library:addFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Избери папка с филми или сериали', properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled) return false;
  for (const f of r.filePaths) if (!db.folders.includes(f)) db.folders.push(f);
  save(); rescan();
  return true;
});
ipcMain.handle('library:removeFolder', (_e, f) => { db.folders = db.folders.filter(x => x !== f); save(); rescan(); return true; });
ipcMain.handle('library:rescan', () => { rescan(); return true; });
ipcMain.handle('settings:set', (_e, s) => {
  const keyChanged = s.tmdbKey !== undefined && s.tmdbKey !== db.settings.tmdbKey;
  db.settings = Object.assign(db.settings, s); save();
  if (keyChanged) { db.meta = {}; backgroundWork(); }
  return db.settings;
});
ipcMain.handle('progress:set', (_e, { id, pos, dur, done }) => {
  const p = db.progress[id] || {};
  if (pos !== undefined) p.pos = pos;
  if (dur) p.dur = dur;
  if (done !== undefined) p.done = done;
  p.at = Date.now();
  db.progress[id] = p; save();
  return p;
});
// ---- онлайн филми (добавки на Stremio) -----------------------------------
// webItems: id "web:<хеш>" → { url, headers, title, subs: [{url, lang, label}] }
const webItems = new Map();
const isWeb = (id) => String(id || '').startsWith('web:');
const webFile = (id) => { const w = webItems.get(id); return w ? w.url : null; };
const LANGS3 = { bul: 'Български', eng: 'Английски', rus: 'Руски', ger: 'Немски', fre: 'Френски', spa: 'Испански', ita: 'Италиански', tur: 'Турски', gre: 'Гръцки', ell: 'Гръцки', srp: 'Сръбски', scc: 'Сръбски', mac: 'Македонски', rum: 'Румънски', ron: 'Румънски' };
ipcMain.handle('stremio:addons', async () => {
  await stremio.ensureDefaults(db, save);
  return { addons: stremio.state(db).addons.map(stremio.summary), catalogs: stremio.catalogs(db) };
});
ipcMain.handle('stremio:add', async (_e, url) => {
  try { await stremio.add(db, save, url); } catch (e) { return { error: e.message }; }
  return { addons: stremio.state(db).addons.map(stremio.summary), catalogs: stremio.catalogs(db) };
});
ipcMain.handle('stremio:remove', (_e, url) => { stremio.remove(db, save, url); return { addons: stremio.state(db).addons.map(stremio.summary), catalogs: stremio.catalogs(db) }; });
ipcMain.handle('stremio:defaults', async () => { await stremio.restoreDefaults(db, save); return { addons: stremio.state(db).addons.map(stremio.summary), catalogs: stremio.catalogs(db) }; });
ipcMain.handle('stremio:refresh', async () => { await stremio.refreshManifests(db, save); return { addons: stremio.state(db).addons.map(stremio.summary), catalogs: stremio.catalogs(db) }; });
ipcMain.handle('stremio:catalog', async (_e, q) => { try { return { metas: await stremio.catalog(db, q || {}) }; } catch (e) { return { error: e.message, metas: [] }; } });
ipcMain.handle('stremio:meta', async (_e, q) => { try { return { meta: await stremio.meta(db, q || {}) }; } catch (e) { return { error: e.message }; } });
ipcMain.handle('stremio:streams', async (_e, q) => { try { return await stremio.streams(db, q || {}); } catch (e) { return { error: e.message, results: [] }; } });
// подготвя поток за плейъра: { url, headers, title, type, id (на видеото), subtitles }
ipcMain.handle('stremio:prepare', async (_e, o) => {
  if (!o || !/^https?:\/\//i.test(o.url || '')) return { error: 'Невалиден адрес.' };
  // какво всъщност е адресът: уеб страница → браузъра, грешка → ясно съобщение
  const hdr = o.headers && typeof o.headers === 'object' ? o.headers : {};
  if (!/\.m3u8(\?|$)/i.test(o.url)) {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(o.url, { headers: { ...hdr, Range: 'bytes=0-0' }, signal: ctl.signal, redirect: 'follow' });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      try { r.body && r.body.cancel(); } catch {}
      if (r.status >= 400) return { error: `Видеото не е достъпно (сървърът върна грешка ${r.status}). Пробвай друг източник.` };
      if (/text\/html|application\/xhtml/.test(ct)) return { external: r.url || o.url };
    } catch (e) {
      if (e.name === 'AbortError') return { error: 'Сървърът на видеото не отговаря. Пробвай друг източник.' };
      return { error: 'Не мога да се свържа със сървъра на видеото. Пробвай друг източник.' };
    } finally { clearTimeout(tm); }
  }
  const id = 'web:' + crypto.createHash('sha1').update(String(o.videoId || o.url)).digest('hex').slice(0, 16);
  let subs = [];
  if (o.type && o.videoId) { try { subs = await stremio.subtitles(db, { type: o.type, id: o.videoId }); } catch {} }
  subs = [...(o.subtitles || []).map(s => ({ ...s, addon: 'Потокът' })), ...subs].filter(s => s && /^https?:\/\//i.test(s.url || ''));
  // българските най-отгоре
  const bg = (s) => /^(bul|bg)$/i.test(s.lang) ? 0 : 1;
  subs.sort((a, b) => bg(a) - bg(b));
  const seen = {};
  subs = subs.slice(0, 60).map(s => { const l = LANGS3[(s.lang || '').toLowerCase()] || s.lang || 'Субтитри'; seen[l] = (seen[l] || 0) + 1; return { url: s.url, lang: /^(bul|bg)$/i.test(s.lang) ? 'bul' : s.lang, label: `${l} ${seen[l]}${s.addon ? ' · ' + s.addon : ''}` }; });
  webItems.set(id, { url: o.url, headers: hdr, forceStream: !!o.notWeb, title: String(o.title || ''), subs });
  return { id };
});

ipcMain.handle('media:open', async (_e, id) => {
  if (isWeb(id)) {
    const w = webItems.get(id); if (!w) return null;
    const isHls = /\.m3u8(\?|$)/i.test(w.url);
    let info = isHls ? null : await media.probe(w.url, w.headers);
    if (!info) info = { duration: 0, format: isHls ? 'hls' : '', video: {}, audio: [], subs: [], unknown: true };
    const noHdr = !Object.keys(w.headers).length && !w.forceStream;
    let pseudo = null;   // име, по което canPlayDirect познава контейнера
    if (info.unknown) pseudo = /\.(mp4|m4v|webm)(\?|$)/i.test(w.url) ? 'x.mp4' : null;
    else if (/mp4|mov/.test(info.format)) pseudo = 'x.mp4';
    else if (/webm/.test(info.format) && info.video && ['vp8', 'vp9', 'av1'].includes(info.video.codec)) pseudo = 'x.webm';
    const q = `k=${server.token}&id=${id}`;
    return {
      id, file: w.url, name: w.title, info, web: true,
      hls: isHls && noHdr ? w.url : null,
      direct: !!(noHdr && !isHls && pseudo && (info.unknown || media.canPlayDirect(pseudo, info))),
      directUrl: w.url,
      streamUrl: `${server.base}/stream?${q}`,
      externalSubs: w.subs.map((s, i) => ({ i, label: s.label, lang: s.lang }))
    };
  }
  const file = index.files.get(id);
  if (!file) return null;
  const info = await media.probe(file);
  const ext = scanner.findExternalSubs(file);
  if (info) {
    const n = info.audio.length;
    scanner.findExternalAudio(file).forEach((a, i) => info.audio.push({ index: n + i, codec: a.codec, lang: a.lang, title: a.title, external: true, ai: a.ai }));
  }
  const q = `k=${server.token}&id=${id}`;
  return {
    id, file, name: path.basename(file),
    info,
    direct: media.canPlayDirect(file, info),
    directUrl: `${server.base}/direct?${q}`,
    streamUrl: `${server.base}/stream?${q}`,
    externalSubs: ext.map((s, i) => ({ i, label: s.label, lang: s.lang }))
  };
});
ipcMain.handle('media:subs', async (_e, { id, kind, index: i }) => {
  if (isWeb(id)) {
    const w = webItems.get(id), s = w && kind === 'ext' && w.subs[i];
    if (!s) return [];
    try {
      const r = await fetch(s.url); if (!r.ok) return [];
      const text = media.decodeText(Buffer.from(await r.arrayBuffer()));
      return /^\s*\[Script Info\]/i.test(text) ? media.parseAss(text) : media.parseSrtVtt(text);
    } catch { return []; }
  }
  const file = index.files.get(id);
  if (!file) return [];
  if (kind === 'ext') { const s = scanner.findExternalSubs(file)[i]; return s ? media.readExternalSubs(s.path) : []; }
  return media.extractEmbeddedSubs(file, i);
});
ipcMain.handle('media:loadSubFile', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Зареди субтитри', filters: [{ name: 'Субтитри', extensions: ['srt', 'vtt', 'ass', 'ssa'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  return media.readExternalSubs(r.filePaths[0]);
});
// ---- интро / надписи --------------------------------------------------
const introJobs = new Map();
async function durationOf(ep) {
  if (!ep.duration) { const info = await media.probe(ep.file); if (info) ep.duration = info.duration; }
  return ep.duration || 0;
}
ipcMain.handle('intro:get', async (_e, id) => {
  if (db.intros[id]) return db.intros[id];
  const s = db.series.find(x => x.episodes.some(e => e.id === id));
  if (!s || s.episodes.length < 2) return null;
  if (introJobs.has(id)) return introJobs.get(id);
  const i = s.episodes.findIndex(e => e.id === id);
  const ep = s.episodes[i];
  // съсед от същия сезон (ако има), иначе какъвто и да е
  const same = s.episodes.filter(e => e.season === ep.season && e.id !== id);
  const other = same.find(e => e.episode > ep.episode) || same[same.length - 1] || s.episodes[i + 1] || s.episodes[i - 1];
  const job = (async () => {
    try {
      const r = await intro.analyzePair(media.FFMPEG, ep.file, await durationOf(ep), other.file, await durationOf(other));
      db.intros[id] = r.a;
      if (!db.intros[other.id]) db.intros[other.id] = r.b;
      save();
      return r.a;
    } catch { return null; } finally { introJobs.delete(id); }
  })();
  introJobs.set(id, job);
  return job;
});

// ---- статистика --------------------------------------------------------
ipcMain.handle('stats:add', (_e, { id, secs }) => {
  if (!(secs > 0) || secs > 600) return;
  const s = db.series.find(x => x.episodes.some(e => e.id === id));
  const key = s ? s.id : id;
  const day = new Date().toISOString().slice(0, 10);
  db.stats.total += secs;
  db.stats.byItem[key] = (db.stats.byItem[key] || 0) + secs;
  db.stats.byDay[day] = (db.stats.byDay[day] || 0) + secs;
  save();
});

// ---- субтитри онлайн ---------------------------------------------------
function subItem(id) {
  const m = db.movies.find(x => x.id === id);
  if (m) return { file: m.file, kind: 'movie', title: m.title, year: m.year, tmdbId: (db.meta[m.id] || {}).tmdbId };
  for (const s of db.series) {
    const e = s.episodes.find(x => x.id === id);
    if (e) return { file: e.file, kind: 'episode', title: s.title, year: s.year, season: e.season, episode: e.episode, tmdbId: (db.meta[s.id] || {}).tmdbId };
  }
  return null;
}
ipcMain.handle('subs:search', async (_e, id) => {
  if (isWeb(id)) return { error: 'Субтитрите за онлайн филмите идват от добавките (напр. OpenSubtitles v3).' };
  if (!db.settings.osKey) return { error: 'nokey' };
  const it = subItem(id); if (!it) return { error: 'Файлът не е намерен.' };
  try { return { results: await opensubs.search(db.settings, it) }; } catch (e) { return { error: e.message }; }
});
ipcMain.handle('subs:download', async (_e, { id, fileId }) => {
  const it = subItem(id); if (!it) return { error: 'Файлът не е намерен.' };
  try {
    const r = await opensubs.download(db.settings, fileId, it.file);
    return { cues: media.readExternalSubs(r.path), remaining: r.remaining, name: path.basename(r.path) };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('subs:autosync', async (_e, { id, cues, audio }) => {
  if (isWeb(id)) return { error: 'не работи за онлайн филми — използвай G / H' };
  const file = index.files.get(id);
  if (!file || !Array.isArray(cues)) return { error: 'Файлът не е намерен.' };
  try {
    const info = await media.probe(file);
    const n = info ? info.audio.length : 0;
    const r = await subsync.sync(media.FFMPEG, file, cues.map(c => ({ start: +c.start, end: +c.end })), audio < n ? audio : 0);
    return r || { error: 'Няма достатъчно реплики или говор за сравнение.' };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('media:stop', () => { server.stopAll(); return true; });
ipcMain.handle('shell:showFile', (_e, id) => { const f = index.files.get(id); if (f) shell.showItemInFolder(f); });
ipcMain.handle('shell:openExternal', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('app:restart', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('app:version', () => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch { return ''; } });
ipcMain.handle('app:checkUpdate', () => checkUpdate(true));

// ---- автоматично обновяване ---------------------------------------------
let updateReady = null;
async function checkUpdate(manual) {
  if (updateReady) { notify('update-ready', updateReady); return updateReady; }
  try {
    const r = await updater.check(__dirname, db.settings.updateUrl || updater.DEFAULT_BASE);
    if (r.updated) { updateReady = r; notify('update-ready', r); }
    else if (manual) notify('toast', `Имаш последната версия (${r.version}).`);
    return r;
  } catch (e) {
    if (manual) notify('toast', 'Не мога да проверя за обновления: ' + e.message);
    return { updated: false, error: e.message };
  }
}

// ---- World TV (iptv-org) -------------------------------------------------
// Каналите се пускат в самата програма (hls.js). Много сървъри не пращат CORS заглавки
// и искат определен Referer/User-Agent — затова ги добавяме за заявките на главния прозорец.
let wtvCache = null, wtvHdr = null;
ipcMain.handle('wtv:list', async (_e, force) => {
  if (!wtvCache || force) {
    const r = await worldtv.load(DATA(), !!force);
    if (r.channels.length || !wtvCache) wtvCache = r;
    else wtvCache = { ...wtvCache, error: r.error };
  }
  return wtvCache;
});
ipcMain.handle('wtv:play', (_e, ch) => {
  wtvHdr = ch ? { referrer: worldtv.httpUrl(ch.referrer) || '', ua: String(ch.ua || '').slice(0, 300) } : null;
  if (!ch) { server.stopAll(); return null; }
  const u = worldtv.httpUrl(ch.url);
  if (!u) return null;
  const q = new URLSearchParams({ k: server.token, u, ref: wtvHdr.referrer, ua: wtvHdr.ua });
  return { liveUrl: `${server.base}/live?${q}` };   // резервен път през ffmpeg
});
ipcMain.handle('wtv:check', (_e, chans) => worldtv.check(DATA(), Array.isArray(chans) ? chans.slice(0, 200) : []));
ipcMain.handle('wtv:health', () => worldtv.known(DATA()));
ipcMain.handle('wtv:mark', (_e, { url, ok }) => worldtv.mark(DATA(), String(url), !!ok));
ipcMain.handle('wtv:epg', async (_e, ch) => { try { return await epg.forChannel(DATA(), ch || {}); } catch { return null; } });
function setupWtvRequests() {
  const isLocal = (u) => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(u);
  const ours = (d) => win && !win.isDestroyed() && d.webContentsId === win.webContents.id && /^https?:/i.test(d.url) && !isLocal(d.url);
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (d, cb) => {
    if (!ours(d) || !wtvHdr) return cb({});
    const h = { ...d.requestHeaders };
    if (wtvHdr.referrer) h.Referer = wtvHdr.referrer;
    if (wtvHdr.ua) h['User-Agent'] = wtvHdr.ua;
    cb({ requestHeaders: h });
  });
  session.defaultSession.webRequest.onHeadersReceived(filter, (d, cb) => {
    if (!ours(d)) return cb({});
    const h = {};
    for (const [k, v] of Object.entries(d.responseHeaders || {})) if (!/^access-control-allow-/i.test(k)) h[k] = v;
    h['Access-Control-Allow-Origin'] = ['*'];
    h['Access-Control-Allow-Headers'] = ['*'];
    h['Access-Control-Allow-Methods'] = ['GET, HEAD, OPTIONS'];
    cb({ responseHeaders: h });
  });
}

// ---- Радио (radiosbg.com) -------------------------------------------------
ipcMain.handle('radio:list', () => ({ stations: radio.list() }));
ipcMain.handle('radio:resolve', async (_e, slug, force) => {
  const r = await radio.resolve(DATA(), String(slug || ''), !!force);
  // резервен път през ffmpeg за потоци, които Chromium не пуска сам
  r.live = r.streams.map(u => `${server.base}/live?${new URLSearchParams({ k: server.token, u, ref: '', ua: '' })}`);
  return r;
});

// ---- Запис на телевизия ----------------------------------------------------
// Ръчен запис (⏺ в плейъра) и автоматичен: правила „записвай този сериал по този канал“,
// по които програмата (EPG) се гледа на всеки 15 минути. Записът почва 2 мин по-рано
// и свършва 5 мин по-късно, защото каналите рядко спазват програмата точно.
const REC_PRE = 2 * 60e3, REC_POST = 5 * 60e3, REC_MAX = 4 * 3600e3;
const recDir = () => db.settings.recDir || path.join(app.getPath('videos'), 'Kinoteka записи');
const recWork = (id) => path.join(DATA(), 'rec-tmp', id);
const recActive = new Map();   // id -> { r, rec }
let recUpcoming = [], recBlocker = null, recNotifyT = null, recEpgAt = 0;
const MONTHS = ['яну', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];
const normTitle = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const safeName = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 80);
function recCh(ch) {
  const url = worldtv.httpUrl(ch && ch.url);
  if (!url) return null;
  return { url, name: String(ch.name || '').slice(0, 120), tvgId: String(ch.tvgId || '').slice(0, 120), country: String(ch.country || '').slice(0, 4),
    ua: String(ch.ua || '').slice(0, 300), referrer: worldtv.httpUrl(ch.referrer) || '', logo: worldtv.httpUrl(ch.logo) || '' };
}
function recDedupe(p) {
  const t = normTitle(p.title);
  if (p.ep) return t + '|' + p.ep.s + 'x' + p.ep.e;
  if (p.sub) return t + '|sub:' + normTitle(p.sub);
  if (p.desc && p.desc.length > 40) return t + '|desc:' + normTitle(p.desc).slice(0, 120);
  return null;
}
function recMatches(rule, p) { const r = normTitle(rule.title); return !!r && (' ' + normTitle(p.title) + ' ').includes(' ' + r + ' '); }
const recBusy = (key) => key && (db.recs.some(r => r.key === key && ['recording', 'saving', 'done'].includes(r.status)));
const recRepeat = (dd) => dd && db.recs.some(r => r.dedupe === dd && r.status === 'done' && r.file && fs.existsSync(r.file));

function recState() {
  const live = (r) => { const a = recActive.get(r.id); return a ? { ...r, ...a.r.info() } : r; };
  return {
    dir: recDir(), rules: db.recRules, recs: db.recs.slice(0, 150).map(live),
    upcoming: recUpcoming.map(u => ({ ...u, ch: { name: u.ch.name, url: u.ch.url }, skip: !!db.recSkip[u.key], busy: !!recBusy(u.key) }))
  };
}
function recNotify() { clearTimeout(recNotifyT); recNotifyT = setTimeout(() => notify('rec-changed', recState()), 400); }

async function recRefresh() {
  recEpgAt = Date.now();
  const now = Date.now(), out = [];
  const byCh = new Map();
  for (const rule of db.recRules) { const k = rule.ch.url; if (!byCh.has(k)) byCh.set(k, { ch: rule.ch, rules: [] }); byCh.get(k).rules.push(rule); }
  for (const { ch, rules } of byCh.values()) {
    let progs = null;
    try { progs = await epg.programmes(DATA(), ch); } catch {}
    for (const rule of rules) rule.epg = !!(progs && progs.length);
    for (const p of progs || []) {
      if (p.stop + REC_POST <= now) continue;
      const rule = rules.find(r => recMatches(r, p));
      if (!rule) continue;
      const dedupe = recDedupe(p);
      out.push({ key: ch.url + '|' + p.start, title: p.title, sub: p.sub || '', ep: p.ep || null, start: p.start, stop: p.stop, ch, ruleId: rule.id, dedupe,
        repeat: rule.skipRepeats !== false && !!recRepeat(dedupe) });
    }
  }
  db.recOnce = db.recOnce.filter(o => o.stop + REC_POST > now);
  for (const o of db.recOnce) if (!out.some(u => u.key === o.key)) out.push({ ...o, once: true });
  for (const k of Object.keys(db.recSkip)) if (db.recSkip[k] < now - 86400e3) delete db.recSkip[k];
  recUpcoming = out.sort((a, b) => a.start - b.start).slice(0, 80);
  save(); recNotify();
  recTick();
}
function recTick() {
  const now = Date.now();
  for (const u of recUpcoming) {
    if (db.recSkip[u.key] || u.repeat || recBusy(u.key)) continue;
    if (now >= u.start - REC_PRE && now < u.stop + REC_POST) recStart({ ch: u.ch, title: u.title, sub: u.sub, ep: u.ep, key: u.key, dedupe: u.dedupe, ruleId: u.ruleId, stopAt: u.stop + REC_POST });
  }
  if (Date.now() - recEpgAt > 15 * 60e3) recRefresh();
}
function recPower() {
  if (recActive.size && recBlocker === null) recBlocker = powerSaveBlocker.start('prevent-app-suspension');
  else if (!recActive.size && recBlocker !== null) { powerSaveBlocker.stop(recBlocker); recBlocker = null; }
}
function recStart(o) {
  const ch = recCh(o.ch);
  if (!ch) return null;
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = { id, key: o.key || null, title: String(o.title || ch.name).slice(0, 200), sub: o.sub || '', ep: o.ep || null, dedupe: o.dedupe || null,
    chName: ch.name, chUrl: ch.url, start: Date.now(), planStop: o.stopAt, status: 'recording', ruleId: o.ruleId || null, manual: !o.ruleId };
  db.recs.unshift(rec);
  db.recs = db.recs.slice(0, 300);
  save();
  const r = new recorder.Recording({ ch, workDir: recWork(id), stopAt: o.stopAt, ffmpeg: media.FFMPEG });
  recActive.set(id, { r, rec });
  r.on('progress', recNotify);
  recPower(); recNotify();
  notify('toast', '⏺ Записвам „' + rec.title + '“ (' + ch.name + ')');
  r.run().then(parts => recFinish(rec, parts));
  return rec;
}
function recOutBase(rec) {
  const show = safeName(rec.title) || 'Запис';
  const dir = path.join(recDir(), show);
  let s = 1, e = 1;
  if (rec.ep && rec.ep.s < 100 && rec.ep.e < 1000) { s = rec.ep.s; e = rec.ep.e; }
  else {
    try { for (const f of fs.readdirSync(dir)) { const m = f.match(/ - S01E(\d+) - /); if (m) e = Math.max(e, +m[1] + 1); } } catch {}
  }
  const d = new Date(rec.start), p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p2(d.getHours())}ч${p2(d.getMinutes())}`;
  let base = path.join(dir, `${show} - S${p2(s)}E${p2(e)} - ${rec.sub ? safeName(rec.sub).slice(0, 60) + ' - ' : ''}${stamp}`);
  const taken = (b) => ['.mp4', '.mkv', '.ts'].some(x => fs.existsSync(b + x));
  for (let i = 2; taken(base); i++) base = base.replace(/ \(\d+\)$/, '') + ` (${i})`;
  return base;
}
async function recFinish(rec, parts) {
  const a = recActive.get(rec.id);
  if (a) Object.assign(rec, a.r.info());
  rec.status = 'saving'; rec.end = Date.now(); recNotify();
  try {
    rec.file = await recorder.finalize(media.FFMPEG, parts, recWork(rec.id), recOutBase(rec));
    rec.status = 'done'; rec.err = '';
    rec.libId = scanner.idFor(rec.file);
    try { rec.bytes = fs.statSync(rec.file).size; } catch {}
    notify('toast', '✅ Записът „' + rec.title + '“ е готов' + (rec.cuts ? ` — изрязани реклами: ${rec.cuts}` : '') + '.');
  } catch (e) {
    rec.status = 'failed'; rec.err = rec.error || e.message;
    notify('toast', '⚠ Записът „' + rec.title + '“ не стана: ' + rec.err);
  }
  recActive.delete(rec.id); recPower();
  try { fs.rmSync(recWork(rec.id), { recursive: true, force: true }); } catch {}
  save(); recNotify();
  if (rec.status !== 'done') return;
  // в библиотеката (раздел Сериали)
  const dir = recDir();
  if (!db.folders.some(f => path.resolve(f).toLowerCase() === path.resolve(dir).toLowerCase() || path.resolve(dir).toLowerCase().startsWith(path.resolve(f).toLowerCase() + path.sep))) db.folders.push(dir);
  save(); rescan();
  // без маркери в потока — търсим вероятните реклами по черни кадри и тишина
  if (!rec.markers || !rec.cuts) {
    rec.marking = true; recNotify();
    try { rec.marks = await recorder.findBreaks(media.FFMPEG, rec.file); } catch { rec.marks = []; }
    rec.marking = false; save(); recNotify();
  }
}
// записи, прекъснати от спиране на програмата — слепваме каквото е записано
function recRecover() {
  for (const rec of db.recs) {
    if (!['recording', 'saving'].includes(rec.status)) continue;
    let parts = [];
    try { parts = fs.readdirSync(recWork(rec.id)).filter(f => /^part\d+.*\.(ts|mp4)$/.test(f)).sort().map(f => ({ file: path.join(recWork(rec.id), f), secs: 0 })); } catch {}
    rec.err = 'Програмата беше затворена по време на записа.';
    recFinish(rec, parts);
  }
}

ipcMain.handle('rec:state', () => recState());
ipcMain.handle('rec:now', (_e, o) => {
  const ch = recCh(o && o.ch);
  if (!ch) return { error: 'Няма канал.' };
  const now = Date.now();
  const prog = o.prog && o.prog.stop > now ? o.prog : null;
  const key = prog ? ch.url + '|' + prog.start : null;
  if (key && recBusy(key)) return { error: 'Това предаване вече се записва.' };
  const rec = recStart({ ch, title: prog ? prog.title : ch.name, sub: prog && prog.sub, ep: prog && prog.ep, key, dedupe: prog && recDedupe(prog),
    stopAt: prog ? Math.min(prog.stop + REC_POST, now + REC_MAX) : now + REC_MAX });
  return rec ? { ok: true, id: rec.id } : { error: 'Не мога да запиша този канал.' };
});
ipcMain.handle('rec:stop', (_e, id) => { const a = recActive.get(id); if (a) a.r.stop(); return true; });
ipcMain.handle('rec:addRule', (_e, o) => {
  const ch = recCh(o && o.ch), title = String((o && o.title) || '').trim().slice(0, 120);
  if (!ch || !title) return { error: 'Напиши името на сериала и избери канал.' };
  if (!db.recRules.some(r => r.ch.url === ch.url && normTitle(r.title) === normTitle(title)))
    db.recRules.push({ id: 'q' + Date.now().toString(36), title, ch, skipRepeats: o.skipRepeats !== false });
  save(); recRefresh();
  return recState();
});
ipcMain.handle('rec:removeRule', (_e, id) => { db.recRules = db.recRules.filter(r => r.id !== id); save(); recRefresh(); return recState(); });
ipcMain.handle('rec:ruleRepeats', (_e, id) => { const r = db.recRules.find(x => x.id === id); if (r) r.skipRepeats = r.skipRepeats === false; save(); recRefresh(); return recState(); });
ipcMain.handle('rec:once', (_e, o) => {
  const ch = recCh(o && o.ch), p = o && o.prog;
  if (!ch || !p || !(p.stop > Date.now())) return { error: 'Предаването вече е минало.' };
  const key = ch.url + '|' + p.start;
  if (!db.recOnce.some(x => x.key === key)) db.recOnce.push({ key, ch, title: String(p.title || ch.name).slice(0, 200), sub: p.sub || '', ep: p.ep || null, start: +p.start, stop: +p.stop, dedupe: recDedupe(p) });
  delete db.recSkip[key];
  save(); recRefresh();
  return { ok: true };
});
ipcMain.handle('rec:skip', (_e, key) => {
  if (db.recSkip[key]) delete db.recSkip[key];
  else { db.recSkip[key] = Date.now(); db.recOnce = db.recOnce.filter(o => o.key !== key); }
  save(); recRefresh();
  return recState();
});
ipcMain.handle('rec:refresh', () => recRefresh().then(recState));
ipcMain.handle('rec:remove', async (_e, id) => {
  const rec = db.recs.find(r => r.id === id);
  if (!rec || recActive.has(id)) return recState();
  if (rec.file && fs.existsSync(rec.file)) { try { await shell.trashItem(rec.file); } catch { try { fs.unlinkSync(rec.file); } catch {} } }
  db.recs = db.recs.filter(r => r.id !== id);
  save(); if (rec.file) rescan(); recNotify();
  return recState();
});
ipcMain.handle('rec:cut', async (_e, { id, from, to }) => {
  const rec = db.recs.find(r => r.id === id);
  if (!rec || !rec.file || !fs.existsSync(rec.file) || !(to > from)) return { error: 'Файлът не е намерен.' };
  try {
    await recorder.cut(media.FFMPEG, rec.file, +from, +to, path.join(DATA(), 'rec-tmp', 'cut-' + id));
    const d = to - from;
    rec.marks = (rec.marks || []).filter(m => !(m.from === from && m.to === to)).map(m => m.from >= to ? { from: m.from - d, to: m.to - d } : m);
    rec.cuts = (rec.cuts || 0) + 1; rec.cutSecs = (rec.cutSecs || 0) + d;
    try { rec.bytes = fs.statSync(rec.file).size; } catch {}
    for (const s of db.series) for (const e of s.episodes) if (e.id === rec.libId) e.duration = 0;
    try { fs.unlinkSync(path.join(THUMBS(), rec.libId + '.jpg')); } catch {}
    save(); recNotify(); backgroundWork();
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('rec:titles', async (_e, c) => {
  const ch = recCh(c); if (!ch) return [];
  try { const l = await epg.programmes(DATA(), ch); return [...new Set((l || []).filter(p => p.stop > Date.now()).map(p => p.title))].slice(0, 200); } catch { return []; }
});
ipcMain.handle('rec:show', (_e, id) => { const rec = db.recs.find(r => r.id === id); if (rec && rec.file) shell.showItemInFolder(rec.file); });
ipcMain.handle('rec:play', (_e, id) => {
  const rec = db.recs.find(r => r.id === id);
  if (!rec || !rec.file || !fs.existsSync(rec.file)) return { error: 'Файлът не е намерен.' };
  if (rec.libId && index.files.has(rec.libId)) return { libId: rec.libId };
  shell.openPath(rec.file);
  return { external: true };
});
ipcMain.handle('rec:dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Папка за записите', properties: ['openDirectory', 'createDirectory'] });
  if (!r.canceled && r.filePaths[0]) { db.settings.recDir = r.filePaths[0]; save(); }
  return recState();
});

ipcMain.handle('win:fullscreen', (_e, v) => { win.setFullScreen(v === undefined ? !win.isFullScreen() : !!v); return win.isFullScreen(); });

// ---- прозорец ----------------------------------------------------------
if (process.env.KINOTEKA_DATA) app.setPath('userData', process.env.KINOTEKA_DATA);

app.whenReady().then(async () => {
  load();
  server = await media.startServer({ resolveFile: (id) => isWeb(id) ? webFile(id) : index.files.get(id), resolveImage: imageFor, resolveHeaders: (id) => (webItems.get(id) || {}).headers });
  Menu.setApplicationMenu(null);
  setupWtvRequests();
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 900, minHeight: 600, backgroundColor: '#0d0f14', title: 'Кинотека',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  win.on('enter-full-screen', () => notify('fullscreen', true));
  win.on('leave-full-screen', () => notify('fullscreen', false));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // затваряне по време на запис: питаме и слепваме записаното преди изход
  let closing = false;
  win.on('close', (e) => {
    if (closing || !recActive.size) return;
    e.preventDefault();
    const n = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Спри записа и затвори', 'Не затваряй'], defaultId: 1, cancelId: 1, title: 'Кинотека',
      message: 'В момента се записва телевизия.', detail: 'Ако затвориш програмата, записът спира. Записаното досега ще се запази.' });
    if (n !== 0) return;
    closing = true;
    const waits = [...recActive.values()].map(a => new Promise(res => { const t = setInterval(() => { if (!recActive.has(a.rec.id)) { clearInterval(t); res(); } }, 300); }));
    for (const a of recActive.values()) a.r.stop();
    Promise.race([Promise.all(waits), new Promise(r => setTimeout(r, 60000))]).then(() => { if (!win.isDestroyed()) win.destroy(); });
  });
  if (process.env.KINOTEKA_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  if (db.folders.length) rescan();
  recRecover();
  setTimeout(recRefresh, 5000);
  setInterval(recTick, 30000);
  if (!process.env.KINOTEKA_NO_UPDATE) {
    setTimeout(() => checkUpdate(false), 8000);
    setInterval(() => checkUpdate(false), 3 * 3600 * 1000);
  }
});
app.on('window-all-closed', () => { if (server) server.stopAll(); app.quit(); });
