'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const scanner = require('./lib/scanner');
const media = require('./lib/media');
const tmdb = require('./lib/tmdb');
const intro = require('./lib/intro');
const opensubs = require('./lib/opensubs');
const updater = require('./lib/updater');
const tv = require('./lib/tv');

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
    movies: db.movies.map(m => ({ ...decorate(m), thumb: img(m.id, 'thumb') })),
    series: db.series.map(s => ({ ...decorate(s), thumb: s.episodes[0] ? img(s.episodes[0].id, 'thumb') : null,
      episodes: s.episodes.map(e => ({ ...e, thumb: img(e.id, 'thumb') })) }))
  };
}

ipcMain.handle('library:get', () => libraryForRenderer());
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
ipcMain.handle('media:open', async (_e, id) => {
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

// ---- телевизия на живо ---------------------------------------------------
// Каналите се гледат в официалния плейър/сайт на телевизията, в отделен прозорец.
let tvWin = null, tvCur = null;
const tvChannels = () => tv.list(db.settings.tvCustom || []);
function tvLoad(ch, mode) {
  tvCur = { id: ch.id, mode: mode === 'page' || !ch.embed ? 'page' : 'embed' };
  const url = tvCur.mode === 'embed' ? ch.embed : ch.page;
  tvWin.setTitle(ch.name + ' — на живо');
  tvWin.loadURL(url, { httpReferrer: ch.page }).catch(() => {});
}
function openTv(id, mode) {
  const ch = tvChannels().find(c => c.id === id);
  if (!ch) return false;
  if (!tvWin || tvWin.isDestroyed()) {
    tvWin = new BrowserWindow({
      width: 1280, height: 760, minWidth: 480, minHeight: 300, backgroundColor: '#000000', title: ch.name, autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'persist:tv' }
    });
    tvWin.setMenu(null);
    const wc = tvWin.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));   // без изскачащи прозорци/реклами
    wc.on('page-title-updated', (e) => e.preventDefault());
    wc.on('did-finish-load', () => { if (tvCur && tvCur.mode === 'embed') wc.insertCSS(tv.EMBED_CSS).catch(() => {}); });
    wc.on('did-fail-load', (_e, code, _d, _u, isMain) => {
      // вграденият плейър не тръгна — отваряме официалната страница
      if (isMain && code !== -3 && tvCur && tvCur.mode === 'embed') { const c = tvChannels().find(x => x.id === tvCur.id); if (c) tvLoad(c, 'page'); }
    });
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const all = tvChannels(), i = all.findIndex(c => tvCur && c.id === tvCur.id);
      if (input.key === 'F11') { tvWin.setFullScreen(!tvWin.isFullScreen()); e.preventDefault(); }
      else if (input.key === 'Escape' && tvWin.isFullScreen()) { tvWin.setFullScreen(false); e.preventDefault(); }
      else if (input.key === 'F5') { wc.reload(); e.preventDefault(); }
      else if (input.key === 'PageDown' || input.key === 'PageUp') {
        const n = all[(i + (input.key === 'PageDown' ? 1 : -1) + all.length) % all.length];
        if (n) tvLoad(n, 'embed'); e.preventDefault();
      }
    });
    tvWin.on('closed', () => { tvWin = null; tvCur = null; });
  }
  tvLoad(ch, mode);
  tvWin.show(); tvWin.focus();
  return true;
}
ipcMain.handle('tv:list', () => tvChannels());
ipcMain.handle('tv:open', (_e, { id, mode }) => openTv(id, mode));
ipcMain.handle('tv:add', (_e, { name, url }) => {
  const page = tv.httpsOnly(url);
  name = String(name || '').trim().slice(0, 60);
  if (!page) return { error: 'Връзката трябва да започва с https://' };
  if (!name) name = new URL(page).hostname;
  db.settings.tvCustom = [...(db.settings.tvCustom || []), { id: 'c' + Date.now().toString(36), name, page }];
  save();
  return { channels: tvChannels() };
});
ipcMain.handle('tv:remove', (_e, id) => {
  db.settings.tvCustom = (db.settings.tvCustom || []).filter(c => c.id !== id);
  save();
  return tvChannels();
});

ipcMain.handle('win:fullscreen', (_e, v) => { win.setFullScreen(v === undefined ? !win.isFullScreen() : !!v); return win.isFullScreen(); });

// ---- прозорец ----------------------------------------------------------
if (process.env.KINOTEKA_DATA) app.setPath('userData', process.env.KINOTEKA_DATA);

app.whenReady().then(async () => {
  load();
  server = await media.startServer({ resolveFile: (id) => index.files.get(id), resolveImage: imageFor });
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 900, minHeight: 600, backgroundColor: '#0d0f14', title: 'Кинотека',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  win.on('closed', () => { if (tvWin && !tvWin.isDestroyed()) tvWin.close(); });
  win.on('enter-full-screen', () => notify('fullscreen', true));
  win.on('leave-full-screen', () => notify('fullscreen', false));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.KINOTEKA_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  if (db.folders.length) rescan();
  if (!process.env.KINOTEKA_NO_UPDATE) {
    setTimeout(() => checkUpdate(false), 8000);
    setInterval(() => checkUpdate(false), 3 * 3600 * 1000);
  }
});
app.on('window-all-closed', () => { if (server) server.stopAll(); app.quit(); });
