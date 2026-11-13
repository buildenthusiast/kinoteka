'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (t) => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
const fmtDur = (t) => { if (!t) return ''; const m = Math.round(t / 60); return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`; };
const LANG = { bul: 'Български', bg: 'Български', eng: 'Английски', en: 'Английски', rus: 'Руски', ru: 'Руски', ger: 'Немски', deu: 'Немски', fre: 'Френски', fra: 'Френски', spa: 'Испански', ita: 'Италиански', tur: 'Турски', gre: 'Гръцки', ell: 'Гръцки', srp: 'Сръбски', jpn: 'Японски', kor: 'Корейски', und: '' };
const isBg = (x) => /^(bul|bg)$/i.test(x.lang || '') || /\b(bg|бг|bul|bulgarian|български)\b/i.test(x.title || x.label || '');

// CSP забранява inline onerror — хващаме грешките при зареждане на картинки глобално
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el.tagName !== 'IMG') return;
  if (el.dataset.fallback === 'remove') el.remove(); else el.style.display = 'none';
}, true);
// Поддържа ли Chromium HEVC тук (на Windows — с хардуерно декодиране)?
const HEVC_OK = window.MediaSource && MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"');

let lib = { movies: [], series: [], folders: [], progress: {}, settings: {} };
let view = { name: 'home', param: null };
let seasonSel = {};

function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

async function refresh() {
  lib = await window.api.getLibrary();
  if (!$('#player').classList.contains('hidden')) return; // не пречим на плейъра
  if (view.name === 'wtv' && $('#wtv-grid')) return;      // World TV не зависи от библиотеката — пазим търсачката
  if (view.name === 'radio' && $('#radio-grid')) return;
  if (view.name === 'rec' && $('#rec-page')) return;       // „Записи“ се обновява само
  if ((view.name === 'online' || view.name === 'odetail') && $('#online-page')) return;
  render();
}

// ---------- помощни -------------------------------------------------------
const seriesOf = (ep) => lib.series.find(s => s.id === ep.seriesId);
const allEpisodes = () => lib.series.flatMap(s => s.episodes.map(e => ({ ...e, series: s })));
function prog(id) { return lib.progress[id] || {}; }
function pct(id, dur) { const p = prog(id); const d = p.dur || dur; return d && p.pos ? Math.min(100, p.pos / d * 100) : 0; }
function epLabel(e) { return `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}${e.episodeEnd ? '-E' + String(e.episodeEnd).padStart(2, '0') : ''}`; }
function nextUp(s) {
  // първият недогледан епизод след последния гледан
  let lastIdx = -1, lastAt = 0;
  s.episodes.forEach((e, i) => { const p = prog(e.id); if (p.at && p.at > lastAt) { lastAt = p.at; lastIdx = i; } });
  if (lastIdx < 0) return s.episodes[0];
  const last = s.episodes[lastIdx];
  if (!prog(last.id).done) return last;
  return s.episodes[lastIdx + 1] || null;
}

// ---------- случайно -----------------------------------------------------
const recent = [];   // пуснати наскоро — да не се повтарят
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function freshPool(arr, exclude) {
  // първо негледани и непускани наскоро; ако няма такива — всички
  let pool = arr.filter(x => x.id !== exclude && !recent.includes(x.id) && !prog(x.id).done);
  if (!pool.length) pool = arr.filter(x => x.id !== exclude && !recent.includes(x.id));
  if (!pool.length) pool = arr.filter(x => x.id !== exclude);
  return pool.length ? pool : arr;
}
// mode: { kind: 'ep', seriesId? } | { kind: 'movie' } | { kind: 'pool', ids: [...] } (от филтрите)
function pickRandom(mode, exclude) {
  if (mode.kind === 'pool') {
    const items = mode.ids.map(id => lib.movies.find(m => m.id === id) || lib.series.find(s => s.id === id)).filter(Boolean);
    if (!items.length) return null;
    const it = rnd(items);
    return it.type === 'series' ? rnd(freshPool(it.episodes, exclude)) : rnd(freshPool(items.filter(i => i.type === 'movie'), exclude));
  }
  if (mode.kind === 'movie') return lib.movies.length ? rnd(freshPool(lib.movies, exclude)) : null;
  const list = mode.seriesId ? lib.series.filter(s => s.id === mode.seriesId) : lib.series.filter(s => s.episodes.length);
  if (!list.length) return null;
  const s = rnd(list);  // всеки сериал с еднакъв шанс, независимо колко епизода има
  return rnd(freshPool(s.episodes, exclude));
}
function playRandom(mode) {
  const it = pickRandom(mode);
  if (!it) return toast(mode.kind === 'movie' ? 'Няма филми в библиотеката.' : 'Няма сериали в библиотеката.');
  return play(it.id, { shuffle: mode });
}

// ---------- любими / за гледане -----------------------------------------
const inList = (k, id) => (lib.settings[k] || []).includes(id);
async function toggleList(k, id) {
  const l = new Set(lib.settings[k] || []);
  if (l.has(id)) l.delete(id); else l.add(id);
  lib.settings = await window.api.setSettings({ [k]: [...l] });
  toast(k === 'favs' ? (l.has(id) ? '♥ Добавено в любими' : 'Махнато от любими') : (l.has(id) ? '🕒 Добавено в „За гледане“' : 'Махнато от „За гледане“'));
  render();
}
const byIds = (ids) => (ids || []).map(id => lib.movies.find(m => m.id === id) || lib.series.find(s => s.id === id)).filter(Boolean);

function allGenres() {
  const g = new Set();
  for (const it of [...lib.movies, ...lib.series]) for (const x of it.genres || []) g.add(x);
  return [...g].sort((a, b) => a.localeCompare(b, 'bg'));
}
function syncGenreSelect() {
  const sel = $('#f-genre'), cur = sel.value, gs = allGenres();
  const html = '<option value="">Всички жанрове</option>' + gs.map(g => `<option ${g === cur ? 'selected' : ''}>${esc(g)}</option>`).join('');
  if (sel.dataset.h !== html) { sel.innerHTML = html; sel.dataset.h = html; }
  sel.style.display = gs.length ? '' : 'none';
}

function filtered(items) {
  const q = $('#search').value.trim().toLowerCase();
  let out = items;
  if (q) out = out.filter(i => (i.displayTitle + ' ' + i.title).toLowerCase().includes(q));
  const g = $('#f-genre').value, y = $('#f-year').value, r = $('#f-rating').value;
  if (g) out = out.filter(i => (i.genres || []).includes(g));
  if (y !== '') out = out.filter(i => i.year && (+y === 0 ? i.year < 1980 : i.year >= +y && i.year < +y + 10));
  if (r) out = out.filter(i => (i.rating || 0) >= +r);
  const sort = $('#sort').value;
  out = [...out];
  if (sort === 'title') out.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle, 'bg'));
  else if (sort === 'year') out.sort((a, b) => (b.year || 0) - (a.year || 0));
  else if (sort === 'rating') out.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  else out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return out;
}

function posterCard(it) {
  const sub = it.type === 'series'
    ? `${it.year ? it.year + ' · ' : ''}${new Set(it.episodes.map(e => e.season)).size} сез. · ${it.episodes.length} еп.`
    : `${it.year || ''}${it.duration ? (it.year ? ' · ' : '') + fmtDur(it.duration) : ''}`;
  const p = it.type === 'movie' ? pct(it.id, it.duration) : 0;
  const done = it.type === 'movie' && prog(it.id).done;
  const art = it.poster
    ? `<img src="${esc(it.poster)}" loading="lazy">`
    : `<img class="thumb-under" src="${esc(it.thumb || '')}" loading="lazy" data-fallback="remove"><div class="fallback"><span>${esc(it.displayTitle)}</span></div>`;
  return `<div class="card" data-open="${it.type}:${it.id}">
    <div class="art">${art}${inList('favs', it.id) ? '<div class="heart">♥</div>' : ''}${it.rating ? `<div class="badge">★ ${it.rating.toFixed(1)}</div>` : ''}${done ? '<div class="badge ok">✓</div>' : ''}${p ? `<div class="bar"><div style="width:${p}%"></div></div>` : ''}</div>
    <div class="meta"><div class="t" title="${esc(it.displayTitle)}">${esc(it.displayTitle)}</div><div class="s">${esc(sub)}</div></div></div>`;
}

function wideCard(entry) {
  // entry: { item (movie|episode), series? }
  const it = entry.item, s = entry.series;
  const title = s ? s.displayTitle : it.displayTitle;
  const sub = s ? `${epLabel(it)}${it.title ? ' · ' + it.title : ''}` : (it.year || '');
  const p = pct(it.id, it.duration);
  return `<div class="card" data-play="${it.id}">
    <div class="art"><img src="${esc(it.thumb)}" loading="lazy" data-fallback="hide"><button class="x" data-dismiss="${s ? s.id : it.id}" title="Махни от „Продължи да гледаш“">✕</button>${p ? `<div class="bar"><div style="width:${p}%"></div></div>` : ''}</div>
    <div class="meta"><div class="t">${esc(title)}</div><div class="s">${esc(sub)}</div></div></div>`;
}

// ---------- изгледи -------------------------------------------------------
// ---------- профили --------------------------------------------------------
function curProfile() { return (lib.profiles || []).find(p => p.id === lib.curProfile) || { id: 'main', name: 'Аз' }; }
const avatar = (p) => `<i class="avatar" style="background:${esc(p.color || '#f5b83d')}">${esc((p.name || '?').slice(0, 1).toUpperCase())}</i>`;
function renderProfileBtn() {
  const p = curProfile();
  $('#profile-btn').innerHTML = `${avatar(p)}<span>${esc(p.name)}${p.kids ? ' 🧒' : ''}</span><b>▾</b>`;
  $('#profile-menu').innerHTML = (lib.profiles || []).map(x => `<div data-profile="${esc(x.id)}" class="${x.id === p.id ? 'sel' : ''}">${avatar(x)} ${esc(x.name)}${x.kids ? ' 🧒' : ''}</div>`).join('') +
    '<div class="sep"></div><div data-profile="manage">⚙️ Управлявай профилите</div>';
}
$('#profile-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#profile-menu').classList.toggle('hidden'); });
$('#profile-menu').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-profile]'); if (!d) return;
  $('#profile-menu').classList.add('hidden');
  if (d.dataset.profile === 'manage') { view = { name: 'settings' }; return render(); }
  if (d.dataset.profile === lib.curProfile) return;
  lib = await window.api.profileSwitch(d.dataset.profile);
  toast(`Профил: ${curProfile().name}`);
  render();
});
document.addEventListener('click', (e) => { if (!e.target.closest('#profile-wrap')) $('#profile-menu').classList.add('hidden'); });
function profilesBox() {
  const ps = lib.profiles || [];
  return `<div class="box" id="profiles-box"><b>Профили</b>
    <div class="hint" style="margin:6px 0 10px">Всеки профил има свои любими, „За гледане“, докъде е стигнал, статистика, канали и радиа. Детският профил (🧒) показва в World TV само детски и семейни канали.</div>
    ${ps.map(p => `<div class="folder"><span style="display:flex;gap:8px;align-items:center;flex:1">${avatar(p)}<input type="text" data-pname="${esc(p.id)}" value="${esc(p.name)}" style="max-width:220px"></span>
      <label class="chk" style="margin:0"><input type="checkbox" data-pkids="${esc(p.id)}" ${p.kids ? 'checked' : ''}> 🧒 детски</label>
      ${p.id === lib.curProfile ? '<span class="hint" style="margin:0">текущ</span>' : `<button data-pswitch="${esc(p.id)}">Влез</button>`}
      ${ps.length > 1 ? `<button data-premove="${esc(p.id)}" title="Изтрий профила и данните му">✕</button>` : ''}</div>`).join('')}
    <div class="actions"><input type="text" id="new-profile" placeholder="Име на нов профил" style="flex:1"><label class="chk" style="margin:0"><input type="checkbox" id="new-profile-kids"> 🧒 детски</label><button class="primary" data-action="add-profile">＋ Добави</button></div></div>`;
}
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-pswitch],[data-premove]'); if (!t) return;
  if (t.dataset.pswitch) { lib = await window.api.profileSwitch(t.dataset.pswitch); toast(`Профил: ${curProfile().name}`); return render(); }
  const p = (lib.profiles || []).find(x => x.id === t.dataset.premove);
  if (p && t.dataset.sure) { lib = await window.api.profileRemove(p.id); toast(`Профилът „${p.name}“ е изтрит.`); return render(); }
  if (p) { t.dataset.sure = '1'; t.textContent = 'Сигурен ли си? Изтрий'; }
});
document.addEventListener('change', async (e) => {
  const n = e.target.dataset.pname, k = e.target.dataset.pkids;
  if (!n && !k) return;
  const p = (lib.profiles || []).find(x => x.id === (n || k)); if (!p) return;
  const r = await window.api.profileSave({ id: p.id, name: n ? e.target.value : p.name, kids: k ? e.target.checked : p.kids });
  if (r.error) return toast(r.error);
  lib = r; renderProfileBtn(); if (W.data) wtvUpdateGrid();
});

function render() {
  renderProfileBtn();
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view.name || (view.name === 'odetail' && b.dataset.view === 'online') || (view.name === 'detail' && b.dataset.view === (view.param.type === 'series' ? 'series' : 'movies'))));
  $('#top').style.display = ['home', 'movies', 'series', 'favs', 'watch'].includes(view.name) ? '' : 'none';
  syncGenreSelect();
  const v = $('#view');
  const keepScroll = v.dataset.view === view.name + JSON.stringify(view.param || '');
  const st = v.scrollTop;
  v.innerHTML = ({ home: renderHome, movies: () => renderGrid('movies'), series: () => renderGrid('series'), detail: renderDetail, settings: renderSettings,
    favs: () => renderList('♥ Любими', byIds(lib.settings.favs), 'Натисни „♥ Любим“ в страницата на филм или сериал, за да го добавиш тук.'),
    watch: () => renderList('🕒 За гледане', byIds(lib.settings.watch), 'Натисни „🕒 За гледане“ в страницата на филм или сериал, за да го запазиш за по-късно.'),
    stats: renderStats, wtv: () => renderWtv(), radio: () => renderRadio(), rec: () => renderRec(), online: () => renderOnline(), odetail: () => renderOnline() })[view.name]();
  v.dataset.view = view.name + JSON.stringify(view.param || '');
  if (keepScroll) v.scrollTop = st;
}

function emptyState() {
  return `<div class="empty"><h1>Добре дошъл в Кинотека</h1>
    <div>Избери папката, в която държиш филмите и сериалите си. Програмата сама ще ги подреди в каталог —<br>филми отделно, сериали по сезони и епизоди.</div>
    <button class="primary" data-action="add">＋ Добави папка с филми</button></div>`;
}

function renderHome() {
  if (!lib.movies.length && !lib.series.length) return lib.folders.length ? `<div class="empty"><h1>Сканирам…</h1><div>Не намерих видеофайлове още. Ако папката е правилна, изчакай малко.</div></div>` : emptyState();
  const q = $('#search').value.trim() || $('#f-genre').value || $('#f-year').value || $('#f-rating').value;
  if (q) return `<h2>Резултати</h2><div class="grid">${filtered([...lib.movies, ...lib.series]).map(posterCard).join('') || '<div class="s">Нищо не е намерено.</div>'}</div>`;
  const cont = [], hidden = lib.settings.contHidden || {};
  for (const m of lib.movies) { const p = prog(m.id); if (p.pos > 20 && !p.done && !(hidden[m.id] >= p.at)) cont.push({ item: m, at: p.at }); }
  for (const s of lib.series) {
    const n = nextUp(s); if (!n) continue;
    const at = Math.max(...s.episodes.map(e => prog(e.id).at || 0));
    if (at && !(hidden[s.id] >= at)) cont.push({ item: n, series: s, at });
  }
  cont.sort((a, b) => b.at - a.at);
  const watchList = byIds(lib.settings.watch);
  const recentMovies = [...lib.movies].sort((a, b) => b.mtime - a.mtime).slice(0, 20);
  const recentSeries = [...lib.series].sort((a, b) => b.mtime - a.mtime).slice(0, 20);
  let h = '';
  if (cont.length) h += `<h2>Продължи да гледаш</h2><div class="row wide">${cont.slice(0, 20).map(wideCard).join('')}</div>`;
  if (watchList.length) h += `<h2>За гледане</h2><div class="row">${watchList.map(posterCard).join('')}</div>`;
  if (recentMovies.length) h += `<h2>Последно добавени филми</h2><div class="row">${recentMovies.map(posterCard).join('')}</div>`;
  if (recentSeries.length) h += `<h2>Сериали</h2><div class="row">${recentSeries.map(posterCard).join('')}</div>`;
  return h;
}

function renderList(title, all, hint) {
  const items = filtered(all);
  if (!all.length) return `<h2>${title}</h2><div class="empty" style="padding:40px 20px">${esc(hint)}</div>`;
  return `<h2>${title} <span style="color:var(--mute);font-weight:400">(${items.length})</span></h2><div class="grid">${items.map(posterCard).join('') || '<div class="s">Нищо не отговаря на филтрите.</div>'}</div>`;
}

function renderGrid(kind) {
  const items = filtered(lib[kind]);
  if (!lib.movies.length && !lib.series.length) return emptyState();
  return `<h2>${kind === 'movies' ? 'Филми' : 'Сериали'} <span style="color:var(--mute);font-weight:400">(${items.length})</span></h2><div class="grid">${items.map(posterCard).join('') || '<div class="s">Нищо не е намерено.</div>'}</div>`;
}

function renderDetail() {
  const { type, id } = view.param;
  const it = (type === 'series' ? lib.series : lib.movies).find(x => x.id === id);
  if (!it) return '<div class="empty">Заглавието вече не е в библиотеката.</div>';
  const bg = it.backdrop || it.thumb;
  const poster = it.poster || it.thumb;
  let h = `<button class="back" data-action="back">← Назад</button><div class="detail-hero">
    <div class="bg" style="background-image:url('${esc(bg)}')"></div>
    <div class="poster">${poster ? `<img src="${esc(poster)}" data-fallback="remove">` : ''}</div>
    <div><h1>${esc(it.displayTitle)}</h1>
    <div class="sub">${[it.year, it.rating ? '★ ' + it.rating.toFixed(1) : '', it.displayTitle !== it.title ? it.title : '', type === 'movie' ? fmtDur(it.duration) : `${it.episodes.length} епизода`].filter(Boolean).map(esc).join(' · ')}</div>
    ${(it.genres || []).length ? `<div class="genres">${it.genres.map(g => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
    ${it.overview ? `<p>${esc(it.overview)}</p>` : ''}
    <div class="actions">`;
  const listBtns = `<button data-list="favs:${it.id}" class="${inList('favs', it.id) ? 'on' : ''}">${inList('favs', it.id) ? '♥ В любими' : '♡ Любим'}</button>
    <button data-list="watch:${it.id}" class="${inList('watch', it.id) ? 'on' : ''}">${inList('watch', it.id) ? '✓ За гледане' : '🕒 За гледане'}</button>`;
  if (type === 'movie') {
    const p = prog(it.id);
    h += p.pos > 20 && !p.done ? `<button class="primary" data-play="${it.id}">▶ Продължи от ${fmt(p.pos)}</button><button data-play-start="${it.id}">Отначало</button>` : `<button class="primary" data-play-start="${it.id}">▶ Пусни</button>`;
    h += `<button data-toggle-done="${it.id}">${p.done ? 'Маркирай като негледан' : '✓ Гледан'}</button>${listBtns}<button data-show="${it.id}">📁 Покажи файла</button></div></div></div>`;
    return h;
  }
  const n = nextUp(it) || it.episodes[0];  // всичко е гледано -> отначало
  if (n) h += `<button class="primary" data-play="${n.id}">▶ ${prog(n.id).pos > 20 ? 'Продължи' : 'Пусни'} ${epLabel(n)}</button>`;
  h += `<button data-random-series="${it.id}" title="Случайни епизоди само от този сериал">🎲 Случаен епизод</button>${listBtns}`;
  h += `</div></div></div>`;
  const seasons = [...new Set(it.episodes.map(e => e.season))].sort((a, b) => a - b);
  const sel = seasonSel[it.id] ?? (n ? n.season : seasons[0]);
  h += `<div class="seasons">${seasons.map(s => `<button data-season="${s}" class="${s === sel ? 'active' : ''}">${s === 0 ? 'Специални' : 'Сезон ' + s}</button>`).join('')}
    <div style="flex:1"></div><button data-season-done="${sel}">✓ Маркирай сезона като гледан</button></div><div class="episodes">`;
  for (const e of it.episodes.filter(e => e.season === sel)) {
    const p = prog(e.id), pc = pct(e.id, e.duration);
    h += `<div class="ep" data-play="${e.id}"><div class="img"><img src="${esc(e.thumb)}" loading="lazy" data-fallback="hide">${pc ? `<div class="bar"><div style="width:${pc}%"></div></div>` : ''}${p.done ? '<div class="badge ok">✓</div>' : ''}</div>
      <div class="grow"><div class="num">${epLabel(e)}</div><div class="name">${esc(e.title || 'Епизод ' + e.episode)}</div><div class="info">${[fmtDur(e.duration), p.pos > 20 && !p.done ? 'спрян на ' + fmt(p.pos) : ''].filter(Boolean).join(' · ')}</div></div>
      <button data-toggle-done="${e.id}" title="Гледан / негледан">${p.done ? '↺' : '✓'}</button></div>`;
  }
  return h + '</div>';
}

function fmtHours(sec) { const h = sec / 3600; return h >= 10 ? Math.round(h) + ' ч' : h >= 1 ? h.toFixed(1).replace('.', ',') + ' ч' : sec > 0 && sec < 60 ? '< 1 мин' : Math.round(sec / 60) + ' мин'; }
function renderStats() {
  const st = lib.stats || { total: 0, byItem: {}, byDay: {} };
  const day = (d) => d.toISOString().slice(0, 10);
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); days.push({ k: day(d), d }); }
  const week = days.slice(-7).reduce((a, x) => a + (st.byDay[x.k] || 0), 0);
  const today = st.byDay[day(new Date())] || 0;
  const epDone = lib.series.reduce((a, s) => a + s.episodes.filter(e => prog(e.id).done).length, 0);
  const mvDone = lib.movies.filter(m => prog(m.id).done).length;
  const max = Math.max(1, ...days.map(x => st.byDay[x.k] || 0));
  const top = Object.entries(st.byItem).map(([id, secs]) => ({ it: lib.series.find(s => s.id === id) || lib.movies.find(m => m.id === id), secs }))
    .filter(x => x.it).sort((a, b) => b.secs - a.secs).slice(0, 10);
  const tmax = top.length ? top[0].secs : 1;
  const wd = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  return `<div class="stats"><h2>📊 Статистика</h2>
    <div class="tiles">
      <div class="tile"><div class="v">${fmtHours(st.total)}</div><div class="l">гледани общо</div></div>
      <div class="tile"><div class="v">${fmtHours(week)}</div><div class="l">последните 7 дни</div></div>
      <div class="tile"><div class="v">${epDone}</div><div class="l">изгледани епизода</div></div>
      <div class="tile"><div class="v">${mvDone}</div><div class="l">изгледани филма</div></div>
    </div>
    <h2>Последните 14 дни <span style="color:var(--mute);font-weight:400;font-size:13px">· днес ${fmtHours(today)}</span></h2>
    <div class="days">${days.map(x => { const v = st.byDay[x.k] || 0; return `<div class="d" style="height:${v / max * 100}%" data-t="${fmtHours(v)}"><span>${wd[x.d.getDay()]} ${x.d.getDate()}</span></div>`; }).join('')}</div>
    <h2>Най-гледани</h2>
    <div class="top">${top.map(x => `<div class="r"><div class="n" data-goto="${x.it.type}:${x.it.id}">${x.it.type === 'series' ? '📺' : '🎬'} ${esc(x.it.displayTitle)}</div><div class="b"><div style="width:${x.secs / tmax * 100}%"></div></div><div class="h">${fmtHours(x.secs)}</div></div>`).join('') || '<div class="r" style="color:var(--mute)">Още няма гледани неща. Статистиката се събира от сега нататък.</div>'}</div>
  </div>`;
}

function renderSettings() {
  const s = lib.settings;
  window.api.version().then(v => { const el = $('#app-ver'); if (el) el.textContent = v; });
  return `<div class="settings"><h2>Настройки</h2>
  ${profilesBox()}
  <div class="box"><b>Папки в библиотеката</b>
    ${lib.folders.map(f => `<div class="folder"><span>${esc(f)}</span><button data-remove-folder="${esc(f)}">Премахни</button></div>`).join('') || '<div class="hint">Няма добавени папки.</div>'}
    <div class="actions"><button class="primary" data-action="add">＋ Добави папка</button><button data-action="rescan">↻ Сканирай отново</button></div>
    <div class="hint">Подреждането става по имената: <code>Име.Година.mkv</code> за филми и <code>Сериал.S01E02.mkv</code> или папки <code>Сериал/Season 1/…</code> за сериали. Ако до филма има <code>poster.jpg</code> или <code>folder.jpg</code>, ползва се като корица.</div></div>
  <div class="box"><b>Корици и описания на български (по желание)</b>
    <div class="hint" style="margin:6px 0 10px">Постави безплатен ключ от TMDB и програмата ще изтегли постери, рейтинг и описания на български. Без ключ се ползва кадър от самия филм. <a data-ext="https://www.themoviedb.org/settings/api">Вземи ключ →</a></div>
    <input type="text" id="tmdb-key" placeholder="TMDB API ключ или Read Access Token" value="${esc(s.tmdbKey || '')}">
    <div class="actions"><button class="primary" data-action="save-key">Запази</button></div></div>
  <div class="box"><b>Субтитри от интернет (OpenSubtitles)</b>
    <div class="hint" style="margin:6px 0 10px">За търсене на български субтитри от плейъра (💬 → 🔍) е нужен безплатен ключ: регистрирай се в OpenSubtitles.com и създай „API consumer“. <a data-ext="https://www.opensubtitles.com/en/consumers">Вземи ключ →</a> Потребител и парола не са задължителни, но дават повече тегления на ден.</div>
    <input type="text" id="os-key" placeholder="API ключ" value="${esc(s.osKey || '')}">
    <div class="actions" style="margin-top:8px"><input type="text" id="os-user" placeholder="Потребител (по желание)" value="${esc(s.osUser || '')}" style="flex:1"><input type="password" id="os-pass" placeholder="Парола (по желание)" value="${esc(s.osPass || '')}" style="flex:1;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px 12px;font:inherit"></div>
    <div class="actions"><button class="primary" data-action="save-os">Запази</button></div></div>
  <div class="box"><b>Обновления</b>
    <div class="hint" style="margin:6px 0 10px">Програмата сама проверява за нова версия при пускане и на всеки 3 часа. Версия: <span id="app-ver"></span></div>
    <div class="actions"><button data-action="check-update">↻ Провери сега</button></div></div>
  <div class="box"><b>Плейър</b>
    <label class="chk"><input type="checkbox" id="auto-next" ${s.autoNext ? 'checked' : ''}> Пускай следващия епизод автоматично</label>
 <label class="chk"><input type="checkbox" id="auto-skip" ${s.autoSkipIntro ? 'checked' : ''}> Прескачай интрото автоматично (иначе се показва бутон)</label>
    <label class="chk"><input type="checkbox" id="prefer-bg" ${s.preferBg !== false ? 'checked' : ''}> Предпочитай български звук; ако няма — български субтитри</label>
    <label class="chk"><input type="checkbox" id="auto-bg-subs" ${s.autoBgSubs !== false ? 'checked' : ''}> Ако няма български субтитри — свали автоматично от OpenSubtitles (нужен е ключът по-горе) и ги синхронизирай</label>
    <label class="chk">Размер на субтитрите <input type="range" id="sub-size" min="60" max="180" step="10" value="${s.subSize || 100}"> <span id="sub-size-v">${s.subSize || 100}%</span></label>
    <div class="hint">Клавиши: Space — пауза, ← → — 10 сек, ↑ ↓ — звук, F — цял екран, M — без звук, S — субтитри, A — аудио, N — следващ епизод, R — друг случаен, G / H — субтитрите по-рано / по-късно, Esc — изход.</div></div>
  </div>`;
}

// ---------- събития ------------------------------------------------------
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-view],[data-open],[data-play],[data-play-start],[data-action],[data-season],[data-season-done],[data-toggle-done],[data-show],[data-remove-folder],[data-ext],[data-random-series],[data-list],[data-dismiss],[data-goto]');
  if (!t || t.id === 'view' || t.closest('#player')) return;   // #view носи data-view само за запомняне на изгледа
  const d = t.dataset;
  if (d.toggleDone) { ev.stopPropagation(); const p = prog(d.toggleDone); await window.api.setProgress({ id: d.toggleDone, done: !p.done, pos: 0 }); return refresh(); }
  if (d.view) { view = { name: d.view }; $('#view').scrollTop = 0; return d.view === 'stats' ? refresh() : render(); }
  if (d.open) { const [type, id] = d.open.split(':'); view = { name: 'detail', param: { type, id }, prev: view }; $('#view').scrollTop = 0; return render(); }
  if (d.dismiss) { ev.stopPropagation(); lib.settings = await window.api.setSettings({ contHidden: { ...(lib.settings.contHidden || {}), [d.dismiss]: Date.now() } }); return render(); }
  if (d.list) { const [k, id] = d.list.split(':'); return toggleList(k, id); }
  if (d.goto) { const [type, id] = d.goto.split(':'); view = { name: 'detail', param: { type, id }, prev: view }; $('#view').scrollTop = 0; return render(); }
  if (d.randomSeries) return playRandom({ kind: 'ep', seriesId: d.randomSeries });
  if (d.play) return play(d.play);
  if (d.playStart) return play(d.playStart, { fromStart: true });
  if (d.season) { seasonSel[view.param.id] = +d.season; return render(); }
  if (d.seasonDone) { const s = lib.series.find(x => x.id === view.param.id); for (const e of s.episodes.filter(e => e.season === +d.seasonDone)) await window.api.setProgress({ id: e.id, done: true, pos: 0 }); return refresh(); }
  if (d.show) return window.api.showFile(d.show);
  if (d.removeFolder) return window.api.removeFolder(d.removeFolder).then(refresh);
  if (d.ext) return window.api.openExternal(d.ext);
  if (d.action === 'add') { if (await window.api.addFolder()) toast('Сканирам папката…'); return; }
  if (d.action === 'rescan') { window.api.rescan(); return toast('Сканирам отново…'); }
  if (d.action === 'back') { view = view.prev || { name: 'home' }; return render(); }
  if (d.action === 'add-profile') {
    const r = await window.api.profileSave({ name: $('#new-profile').value, kids: $('#new-profile-kids').checked });
    if (r.error) return toast(r.error);
    lib = r; toast('Профилът е добавен.'); return render();
  }
  if (d.action === 'check-update') { toast('Проверявам…'); return window.api.checkUpdate(); }
  if (d.action === 'save-os') { lib.settings = await window.api.setSettings({ osKey: $('#os-key').value.trim(), osUser: $('#os-user').value.trim(), osPass: $('#os-pass').value }); return toast('Запазено.'); }
  if (d.action === 'save-key') { await window.api.setSettings({ tmdbKey: $('#tmdb-key').value.trim() }); toast('Запазено. Тегля корици…'); return refresh(); }
});
document.addEventListener('change', async (ev) => {
  if (ev.target.id === 'auto-next') lib.settings = await window.api.setSettings({ autoNext: ev.target.checked });
  if (ev.target.id === 'auto-skip') lib.settings = await window.api.setSettings({ autoSkipIntro: ev.target.checked });
  if (ev.target.id === 'prefer-bg') lib.settings = await window.api.setSettings({ preferBg: ev.target.checked });
  if (ev.target.id === 'auto-bg-subs') lib.settings = await window.api.setSettings({ autoBgSubs: ev.target.checked });
  if (ev.target.id === 'sub-size') lib.settings = await window.api.setSettings({ subSize: +ev.target.value });
});
document.addEventListener('input', (ev) => { if (ev.target.id === 'sub-size') $('#sub-size-v').textContent = ev.target.value + '%'; });
$('#rand-ep').onclick = () => playRandom({ kind: 'ep' });
$('#rand-movie').onclick = () => playRandom({ kind: 'movie' });
$('#add-folder').onclick = async () => { if (await window.api.addFolder()) toast('Сканирам папката…'); };
$('#search').addEventListener('input', () => { if (view.name === 'detail' || view.name === 'settings') view = { name: 'home' }; render(); });
$('#sort').addEventListener('change', render);
for (const id of ['#f-genre', '#f-year', '#f-rating']) $(id).addEventListener('change', () => { if (!['home', 'movies', 'series', 'favs', 'watch'].includes(view.name)) view = { name: 'home' }; render(); });
$('#f-random').onclick = () => {
  const src = { movies: lib.movies, series: lib.series, favs: byIds(lib.settings.favs), watch: byIds(lib.settings.watch) }[view.name] || [...lib.movies, ...lib.series];
  const items = filtered(src);
  if (!items.length) return toast('Няма заглавия с тези филтри.');
  return playRandom({ kind: 'pool', ids: items.map(i => i.id) });
};

window.api.on('library-changed', () => { clearTimeout(refresh._t); refresh._t = setTimeout(refresh, 250); });
window.api.on('toast', toast);
window.api.on('update-ready', (u) => {
  $('#update-text').textContent = `✨ Кинотека е обновена до версия ${u.version}.${u.notes ? ' ' + u.notes : ''}`;
  $('#update-bar').classList.remove('hidden');
});
$('#update-restart').onclick = () => { if (!$('#player').classList.contains('hidden')) saveProgress(true); window.api.restart(); };
$('#update-later').onclick = () => $('#update-bar').classList.add('hidden');
window.api.on('scan-status', (s) => {
  const el = $('#scan-status');
  if (s.phase === 'files') el.textContent = 'Търся видеофайлове…';
  else if (s.phase === 'thumbs') el.textContent = `Миниатюри ${s.done}/${s.total}`;
  else if (s.phase === 'meta') el.textContent = `Корици ${s.done}/${s.total}`;
  else el.textContent = '';
});

// =========================================================================
// ПЛЕЙЪР
// =========================================================================
const video = $('#video');
const P = { item: null, media: null, mode: 'direct', offset: 0, audio: 0, tx: false, dur: 0, cues: [], subSel: null, list: [], saveT: 0, nextTimer: null };

function findItem(id) {
  if (String(id).startsWith('web:')) return (typeof onlineFound === 'function' && onlineFound(id)) || null;
  const m = lib.movies.find(x => x.id === id);
  if (m) return { item: m, title: m.displayTitle, list: [] };
  for (const s of lib.series) {
    const i = s.episodes.findIndex(e => e.id === id);
    if (i >= 0) {
      const e = s.episodes[i];
      // след последния епизод на сезона идва първият от следващия; след последния сезон — отначало
      const next = s.episodes[i + 1] || (s.episodes.length > 1 ? s.episodes[0] : null);
      return { item: e, series: s, title: `${s.displayTitle} — ${epLabel(e)}${e.title ? ' · ' + e.title : ''}`, next, wrapped: !s.episodes[i + 1] };
    }
  }
  return null;
}

function curTime() { return P.mode !== 'stream' ? video.currentTime : P.offset + video.currentTime; }

async function play(id, opts = {}) {
  const found = findItem(id);
  if (!found) return toast('Файлът не е намерен.');
  flushStats();
  P.shuffle = opts.shuffle || null;
  if (P.shuffle) { found.next = pickRandom(P.shuffle, id); found.wrapped = false; }
  recent.push(id); if (recent.length > 30) recent.shift();
  const media = await window.api.open(id);
  if (!media || !media.info) return toast('Не мога да отворя файла (повреден или липсва).');
  const v = media.info.video;
  const needTx = v && v.codec === 'hevc' && !HEVC_OK;
  Object.assign(P, { item: found.item, found, media, dur: media.info.duration || found.item.duration || 0, tx: needTx, cues: [], subSel: null, nextDismissed: false,
    intro: null, introSkipped: false, countdown: null, subDelay: subDelays[id] || 0, lastTick: 0 });
  clearInterval(P.cdTimer);
  $('#p-skip').classList.add('hidden'); $('#p-sleep-msg').classList.add('hidden');
  if (found.series) window.api.intro(id).then(r => { if (P.item && P.item.id === id) P.intro = r; }).catch(() => {});
  $('#p-title').textContent = found.title;
  $('#p-nextep').classList.toggle('hidden', !found.next);
  $('#p-nextep').title = P.shuffle ? 'Следващ случаен (N)' : 'Следващ епизод (N)';
  $('#p-shuffle').classList.toggle('hidden', !(found.series || found.item.type === 'movie'));
  $('#p-shuffle').classList.toggle('on', !!P.shuffle);
  $('#p-title').textContent = (P.shuffle ? '🎲 ' : '') + found.title;
  if (lib.settings.volume != null) { video.volume = lib.settings.volume; $('#p-vol').value = video.volume; }
  $('#p-next').classList.add('hidden');
  $('#subtitle').textContent = '';
  $('#subtitle').style.setProperty('--sub-scale', (lib.settings.subSize || 100) / 100);
  $('#player').classList.remove('hidden');
  // аудио: български, ако има
  const preferBg = lib.settings.preferBg !== false;
  const a = media.info.audio;
  let ai = a.findIndex(x => x.default); if (ai < 0) ai = 0;
  if (preferBg) {
    // истински български звук > AI войсоувър > друго
    let bg = a.findIndex(x => isBg(x) && !x.ai);
    if (bg < 0) bg = a.findIndex(isBg);
    if (bg >= 0) ai = bg;
  }
  P.audio = Math.max(0, ai);
  buildMenus();
  // субтитри: български, ако звукът не е български
  if (preferBg && !(a[P.audio] && isBg(a[P.audio]))) {
    const ext = media.externalSubs.findIndex(isBg);
    const emb = media.info.subs.findIndex(s => s.text && isBg(s));
    if (ext >= 0) selectSubs({ kind: 'ext', index: ext });
    else if (emb >= 0) selectSubs({ kind: 'emb', index: emb });
    else if (media.externalSubs.length === 1) selectSubs({ kind: 'ext', index: 0 });
    else autoBgSubs(id).catch(() => {});
  }
  const p = prog(id);
  const start = opts.at != null ? opts.at : !opts.fromStart && p.pos > 20 && !p.done && p.pos < P.dur - 10 ? p.pos : 0;
  if (start) toast('Продължава от ' + fmt(start));
  P.mode = media.hls && P.audio === 0 ? 'hls' : media.direct && P.audio === 0 ? 'direct' : 'stream';
  load(start);
  showControls();
}

function load(t) {
  $('#spinner').classList.remove('hidden');
  if (P.hls) { try { P.hls.destroy(); } catch {} P.hls = null; }
  if (P.mode === 'hls' && window.Hls && Hls.isSupported()) {
    // онлайн HLS поток (.m3u8) — hls.js сам избира качеството
    P.offset = 0;
    const h = P.hls = new Hls({ startPosition: t || -1, maxBufferLength: 60, enableWorker: false });
    h.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal || P.hls !== h) return;
      const at = video.currentTime || t || 0;
      try { h.destroy(); } catch {} P.hls = null;
      toast('Превключвам на резервен начин за пускане…');
      P.mode = 'stream'; load(at);
    });
    h.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    h.loadSource(P.media.hls); h.attachMedia(video);
    return;
  }
  if (P.mode === 'hls') P.mode = 'stream';
  if (P.mode === 'direct') {
    P.offset = 0;
    video.src = P.media.directUrl;
    video.addEventListener('loadedmetadata', function f() { video.removeEventListener('loadedmetadata', f); if (t) video.currentTime = t; }, { once: true });
  } else {
    P.offset = t;
    video.src = `${P.media.streamUrl}&t=${t.toFixed(2)}&a=${P.audio}${P.tx ? '&tx=1' : ''}`;
  }
  video.play().catch(() => {});
}

function seek(t) {
  t = Math.max(0, Math.min(P.dur ? P.dur - 1 : t, t));
  if (P.mode !== 'stream') video.currentTime = t;
  else load(t);
  renderSubs(t);
  updateUI();
}

video.addEventListener('error', () => {
  if (!P.media || $('#player').classList.contains('hidden')) return;
  const t = curTime();
  if (P.mode === 'hls') return;   // hls.js сам съобщава за грешките си
  if (P.mode === 'direct') { P.mode = 'stream'; return load(t); }
  if (!P.tx) { P.tx = true; toast('Прекодирам видеото за този файл…'); return load(t); }
  $('#spinner').classList.add('hidden');
  if (P.media.web) {   // онлайн: връщаме към списъка с източници
    closePlayer();
    return toast('Това видео не може да се пусне (адресът не е видео или е изтекъл). Пробвай друг източник.', 7000);
  }
  toast('Този файл не може да се пусне. ' + (video.error ? video.error.message : ''), 6000);
});
// онлайн видео без известна дължина (напр. HLS) — взимаме я от плейъра
video.addEventListener('durationchange', () => { if (P.media && !P.dur && P.mode !== 'stream' && isFinite(video.duration) && video.duration > 0) P.dur = video.duration; });
video.addEventListener('waiting', () => $('#spinner').classList.remove('hidden'));
video.addEventListener('playing', () => $('#spinner').classList.add('hidden'));
video.addEventListener('canplay', () => $('#spinner').classList.add('hidden'));
video.addEventListener('play', updateUI);
video.addEventListener('pause', () => { updateUI(); saveProgress(true); showControls(); });
video.addEventListener('timeupdate', () => {
  const t = curTime();
  updateUI(); renderSubs(t);
  if (Date.now() - P.saveT > 5000) saveProgress();
  // звук върви, но няма картина → кодекът не се поддържа, прекодираме
  if (P.media.info.video && video.currentTime > 1.5 && video.videoWidth === 0 && !P.tx) {
    P.tx = true; if (P.mode !== 'stream') P.mode = 'stream';
    toast('Прекодирам видеото за този файл…'); return load(t);
  }
  tickStats();
  tickSleep();
  // интро: бутон или автоматично прескачане
  const ir = P.intro && P.intro.intro;
  const inIntro = ir && t >= ir[0] - 1 && t < ir[1] - 2;
  if (inIntro && lib.settings.autoSkipIntro && !P.introSkipped) { P.introSkipped = true; toast('Прескачам интрото'); return seek(ir[1]); }
  $('#p-skip').classList.toggle('hidden', !inIntro || !$('#p-next').classList.contains('hidden'));
  // надписи в края: преминаване към следващия
  const outro = P.intro && P.intro.outro && P.intro.outro[0];
  if (P.found && P.found.next && !P.nextDismissed && $('#p-next').classList.contains('hidden')) {
    if (outro && t >= outro && P.dur - t > 3) showNext(lib.settings.autoNext && !sleepBlocksNext() ? 10 : 0);
    else if (P.dur && P.dur - t < 25 && P.dur - t > 0) showNext();
  }
});
$('#p-skip').onclick = () => { if (P.intro && P.intro.intro) { P.introSkipped = true; seek(P.intro.intro[1]); } };
video.addEventListener('ended', () => {
  if (P.media && P.media.web && curTime() < 3) {   // онлайн „видео“, което свършва веднага — не е истинско видео
    closePlayer();
    return toast('Това видео не може да се пусне (адресът не е видео или е изтекъл). Пробвай друг източник.', 7000);
  }
  saveProgress(true, true);
  if (sleep && sleep.mode === 'ep') return sleepStop();
  if (P.found.next && lib.settings.autoNext) return playNext();
  if (!P.found.next) closePlayer();
});

function saveProgress(force, ended) {
  if (!P.item) return;
  P.saveT = Date.now();
  const t = curTime();
  const done = ended || (P.dur && t / P.dur > 0.93);
  const pos = done ? 0 : t;
  lib.progress[P.item.id] = Object.assign(lib.progress[P.item.id] || {}, { pos, dur: P.dur, done: !!done, at: Date.now() });
  window.api.setProgress({ id: P.item.id, pos, dur: P.dur, done: !!done });
}

function nextLabel(n) {
  if (n.type === 'movie') return n.displayTitle;
  const s = seriesOf(n);
  const same = s && P.found.series && s.id === P.found.series.id;
  return `${same ? '' : (s ? s.displayTitle + ' — ' : '')}${epLabel(n)}${n.title ? ' · ' + n.title : ''}`;
}
function showNext(countdown = 0) {
  const n = P.found.next;
  const pre = P.shuffle ? 'Следва случаен: ' : P.found.wrapped ? 'Отначало: ' : (P.found.series && n.season !== P.found.item.season ? `Сезон ${n.season}: ` : 'Следва: ');
  const label = pre + nextLabel(n);
  $('#p-next-label').textContent = label;
  $('#p-next').classList.remove('hidden');
  $('#p-skip').classList.add('hidden');
  clearInterval(P.cdTimer);
  if (countdown > 0) {
    // надписите започнаха: след няколко секунди пускаме следващия
    P.countdown = countdown;
    $('#p-next-label').textContent = `${label} (след ${P.countdown} сек)`;
    P.cdTimer = setInterval(() => {
      if (video.paused) return;
      P.countdown--;
      $('#p-next-label').textContent = `${label} (след ${P.countdown} сек)`;
      if (P.countdown <= 0) { clearInterval(P.cdTimer); saveProgress(true, true); playNext(); }
    }, 1000);
  }
}
function playNext() {
  const n = P.found.next; if (!n) return;
  // по ред — отначало; случаен — продължава, ако е започнат
  play(n.id, { fromStart: !P.shuffle, shuffle: P.shuffle });
}
$('#p-next-btn').onclick = () => { saveProgress(true, true); playNext(); };
$('#p-next-cancel').onclick = () => { clearInterval(P.cdTimer); P.nextDismissed = true; $('#p-next').classList.add('hidden'); };
$('#p-nextep').onclick = () => { if (P.found.next) { saveProgress(true, true); playNext(); } };
$('#p-shuffle').onclick = () => {
  // друг случаен от същия вид (без да маркира текущия като гледан)
  const mode = P.shuffle || (P.found.item.type === 'movie' ? { kind: 'movie' } : { kind: 'ep' });
  const it = pickRandom(mode, P.item.id); if (!it) return;
  saveProgress(true); play(it.id, { shuffle: mode });
};

// ---- статистика: броим реално гледаните секунди ------------------------
function tickStats() {
  const now = performance.now();
  if (P.lastTick && !video.paused && now - P.lastTick < 2000) P.watched = (P.watched || 0) + (now - P.lastTick) / 1000;
  P.lastTick = now;
  if (P.watched >= 30) flushStats();
}
function flushStats() {
  if (P.item && P.watched > 1) window.api.addStats({ id: P.item.id, secs: Math.round(P.watched) });
  P.watched = 0; P.lastTick = 0;
}

// ---- таймер за сън ------------------------------------------------------
let sleep = null;   // { mode: 'ep' } | { until: ms }
const sleepBlocksNext = () => !!(sleep && sleep.mode === 'ep');
function tickSleep() {
  if (!sleep || !sleep.until) return;
  const left = (sleep.until - Date.now()) / 1000;
  if (left <= 0) return sleepStop();
  if (left < 10) { if (sleep.vol == null) sleep.vol = video.volume; video.volume = sleep.vol * left / 10; }   // плавно заглъхване
}
function sleepStop() {
  const vol = sleep && sleep.vol;
  sleep = null; updateSleepBtn();
  video.pause();
  if (vol != null) video.volume = vol;
  clearInterval(P.cdTimer); $('#p-next').classList.add('hidden');
  window.api.fullscreen(false);
  $('#p-sleep-msg').innerHTML = '🌙 Лека нощ!<div style="font-size:13px;color:var(--mute);margin:8px 0 14px">Таймерът спря възпроизвеждането.</div><button id="p-sleep-resume">▶ Продължи</button>';
  $('#p-sleep-msg').classList.remove('hidden');
  $('#p-sleep-resume').onclick = () => { $('#p-sleep-msg').classList.add('hidden'); if (video.ended && P.found.next) playNext(); else video.play(); };
}
function updateSleepBtn() {
  $('#p-sleep-btn').classList.toggle('on', !!sleep);
  $('#p-sleep-btn').textContent = sleep ? (sleep.mode === 'ep' ? '🌙 след еп.' : `🌙 ${Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000))} мин`) : '🌙';
}
setInterval(() => { if (sleep && sleep.until) updateSleepBtn(); }, 30000);
function buildSleepMenu() {
  const cur = sleep ? (sleep.mode === 'ep' ? 'ep' : 'min') : 'off';
  const opts = [['off', 'Изключен'], ['ep', P.found && P.found.series ? 'След този епизод' : 'След края на филма'], ...[15, 30, 45, 60, 90, 120].map(m => [String(m), m + ' минути']) ];
  $('#p-sleep').innerHTML = '<div class="lbl">Спри след…</div>' + opts.map(([v, l]) => `<div data-sleep="${v}" class="${(v === cur) ? 'sel' : ''}">${l}</div>`).join('');
}
$('#p-sleep-btn').onclick = (e) => { e.stopPropagation(); closeMenus('#p-sleep'); buildSleepMenu(); $('#p-sleep').classList.toggle('hidden'); };
$('#p-sleep').onclick = (e) => {
  const d = e.target.closest('[data-sleep]'); if (!d) return;
  const v = d.dataset.sleep;
  sleep = v === 'off' ? null : v === 'ep' ? { mode: 'ep' } : { until: Date.now() + (+v) * 60000 };
  updateSleepBtn(); $('#p-sleep').classList.add('hidden');
  toast(sleep ? (sleep.mode === 'ep' ? '🌙 Ще спре след края' : `🌙 Ще спре след ${v} минути`) : 'Таймерът е изключен');
};
function closeMenus(except) { for (const m of document.querySelectorAll('#player .menu')) if (!except || !m.matches(except)) m.classList.add('hidden'); }

// ---- закъснение на субтитрите ------------------------------------------
const subDelays = {};
function shiftSubs(d) {
  P.subDelay = Math.round(((P.subDelay || 0) + d) * 100) / 100;
  subDelays[P.item.id] = P.subDelay;
  toast(`Субтитри: ${P.subDelay > 0 ? '+' : ''}${P.subDelay.toFixed(2).replace('.', ',')} сек ${P.subDelay > 0 ? '(по-късно)' : P.subDelay < 0 ? '(по-рано)' : ''}`, 1500);
  renderSubs(curTime());
  if (!$('#p-subs').classList.contains('hidden')) buildMenus();
}

function closePlayer() {
  saveProgress(true);
  flushStats(); clearInterval(P.cdTimer);
  if (P.hls) { try { P.hls.destroy(); } catch {} P.hls = null; }
  video.pause(); video.removeAttribute('src'); video.load();
  window.api.stop();
  window.api.fullscreen(false);
  $('#player').classList.add('hidden');
  P.item = null; P.nextDismissed = false; $('#p-sleep-msg').classList.add('hidden');
  refresh();
}
$('#p-back').onclick = closePlayer;

function updateUI() {
  const t = curTime(), d = P.dur || video.duration || 0;
  $('#p-play').textContent = video.paused ? '▶' : '❚❚';
  $('#p-time').textContent = `${fmt(t)} / ${fmt(d)}`;
  const pc = d ? t / d * 100 : 0;
  $('#p-played').style.width = pc + '%';
  $('#p-handle').style.left = pc + '%';
  let b = 0;
  try { if (video.buffered.length) b = (P.mode !== 'stream' ? 0 : P.offset) + video.buffered.end(video.buffered.length - 1); } catch {}
  $('#p-buffer').style.width = (d ? Math.min(100, b / d * 100) : 0) + '%';
  $('#p-mute').textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
}

const seekBar = $('#p-seek');
const seekPos = (ev) => { const r = seekBar.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (P.dur || 0); };
seekBar.addEventListener('mousemove', (ev) => { const ht = $('#p-hover-time'); ht.textContent = fmt(seekPos(ev)); ht.style.left = (ev.clientX - seekBar.getBoundingClientRect().left) + 'px'; });
seekBar.addEventListener('click', (ev) => seek(seekPos(ev)));

$('#p-play').onclick = () => video.paused ? video.play() : video.pause();
video.addEventListener('click', () => video.paused ? video.play() : video.pause());
video.addEventListener('dblclick', () => window.api.fullscreen());
$('#p-rew').onclick = () => seek(curTime() - 10);
$('#p-fwd').onclick = () => seek(curTime() + 10);
$('#p-fs').onclick = () => window.api.fullscreen();
$('#p-mute').onclick = () => { video.muted = !video.muted; updateUI(); };
$('#p-vol').oninput = (e) => { video.volume = +e.target.value; video.muted = false; updateUI(); };
video.addEventListener('volumechange', () => {
  clearTimeout(video._vt);
  video._vt = setTimeout(async () => { if (lib.settings.volume !== video.volume) lib.settings = await window.api.setSettings({ volume: video.volume }); }, 800);
});

// ---- менюта аудио / субтитри --------------------------------------------
function trackName(x, i, kind) {
  const lang = LANG[(x.lang || '').toLowerCase()] ?? x.lang;
  const parts = [x.title, lang].filter(Boolean);
  if (kind === 'audio' && x.external) return parts.join(' · ') + ' · външен файл';
  if (kind === 'audio') parts.push((x.codec || '').toUpperCase() + (x.channels ? ` ${x.channels > 2 ? (x.channels - 1) + '.1' : x.channels === 1 ? 'моно' : 'стерео'}` : ''));
  return parts.length ? parts.join(' · ') : `Пътечка ${i + 1}`;
}
function buildMenus() {
  const a = P.media.info.audio;
  $('#p-audio').innerHTML = a.length ? a.map((x, i) => `<div data-audio="${i}" class="${i === P.audio ? 'sel' : ''}">${esc(trackName(x, i, 'audio'))}</div>`).join('') : '<div>Няма аудио</div>';
  const subs = [`<div data-sub="off" class="${!P.subSel ? 'sel' : ''}">Без субтитри</div>`];
  P.media.externalSubs.forEach((s, i) => subs.push(`<div data-sub="ext:${i}" class="${P.subSel && P.subSel.kind === 'ext' && P.subSel.index === i ? 'sel' : ''}">📄 ${esc(s.label)}</div>`));
  P.media.info.subs.forEach((s, i) => { if (s.text) subs.push(`<div data-sub="emb:${i}" class="${P.subSel && P.subSel.kind === 'emb' && P.subSel.index === i ? 'sel' : ''}">${esc(trackName(s, i, 'sub'))}</div>`); });
  if (P.media.info.subs.some(s => !s.text)) subs.push(`<div style="color:var(--mute);cursor:default">(има и графични субтитри — не се поддържат)</div>`);
  subs.push('<div class="sep"></div><div data-sub="online">🔍 Търси български субтитри онлайн</div><div data-sub="file">📂 Зареди .srt файл…</div>');
  if (P.cues.length) subs.push('<div data-sub="autosync">🎯 Синхронизирай автоматично</div>');
  subs.push(`<div class="sep"></div><div class="row2">Закъснение: <button data-shift="-0.5">−0,5</button><b style="min-width:52px;text-align:center">${(P.subDelay || 0).toFixed(1).replace('.', ',')} с</b><button data-shift="0.5">+0,5</button>${P.subDelay ? '<button data-shift="reset">0</button>' : ''}</div>`);
  $('#p-subs').innerHTML = subs.join('');
}
$('#p-audio-btn').onclick = (e) => { e.stopPropagation(); closeMenus('#p-audio'); $('#p-audio').classList.toggle('hidden'); };
$('#p-subs-btn').onclick = (e) => { e.stopPropagation(); closeMenus('#p-subs'); buildMenus(); $('#p-subs').classList.toggle('hidden'); };
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
$('#p-audio').onclick = (e) => {
  const d = e.target.closest('[data-audio]'); if (!d) return;
  const i = +d.dataset.audio; if (i === P.audio) return;
  const t = curTime(); P.audio = i; P.mode = 'stream'; load(t); buildMenus();
  $('#p-audio').classList.add('hidden');
};
$('#p-subs').onclick = async (e) => {
  const sh = e.target.closest('[data-shift]');
  if (sh) { e.stopPropagation(); return shiftSubs(sh.dataset.shift === 'reset' ? -(P.subDelay || 0) : +sh.dataset.shift); }
  const os = e.target.closest('[data-os]');
  if (os) {
    e.stopPropagation();
    if (os.dataset.os === 'back') return buildMenus();
    $('#p-subs').classList.add('hidden'); toast('Тегля субтитрите…');
    const r = await window.api.downloadSubs({ id: P.item.id, fileId: +os.dataset.os });
    if (r.error) return toast('Грешка: ' + r.error, 6000);
    P.cues = r.cues || []; P.subSel = { kind: 'file' }; buildMenus();
    return toast(`✓ ${r.name} — запазени до видеото${r.remaining != null ? ` (остават ${r.remaining} тегления днес)` : ''}`, 5000);
  }
  const d = e.target.closest('[data-sub]'); if (!d) return;
  if (d.dataset.sub === 'online') { e.stopPropagation(); return searchOnline(); }
  if (d.dataset.sub === 'autosync') { $('#p-subs').classList.add('hidden'); return autoSync(); }
  $('#p-subs').classList.add('hidden');
  const v = d.dataset.sub;
  if (v === 'off') { P.subSel = null; P.cues = []; $('#subtitle').textContent = ''; return buildMenus(); }
  if (v === 'file') { const cues = await window.api.loadSubFile(); if (cues) { P.cues = cues; P.subSel = { kind: 'file' }; buildMenus(); toast(`Заредени ${cues.length} реплики`); } return; }
  const [kind, index] = v.split(':');
  selectSubs({ kind, index: +index });
};
// автоматично синхронизиране: сравнява кога се говори с репликите
async function autoSync(quiet) {
  const id = P.item && P.item.id, cues = P.cues;
  if (!id || !cues.length) return;
  if (!quiet) toast('🎯 Синхронизирам субтитрите (слушам звука)…', 20000);
  const r = await window.api.autosyncSubs({ id, cues: cues.map(c => ({ start: c.start, end: c.end })), audio: P.audio });
  if (!P.item || P.item.id !== id || P.cues !== cues) return;
  if (!r || r.error) return quiet ? null : toast('Не успях да синхронизирам: ' + ((r && r.error) || 'грешка'), 5000);
  if (r.confidence < 0.25) return quiet ? null : toast('Не съм сигурен за отместването — остават както са. Можеш да ги местиш с G / H.', 5000);
  shiftSubs(r.offset - (P.subDelay || 0));
  toast(Math.abs(r.offset) < 0.15 ? '🎯 Субтитрите вече са в синхрон.' : `🎯 Субтитрите са преместени с ${r.offset > 0 ? '+' : ''}${r.offset.toFixed(1).replace('.', ',')} сек.`, 4000);
}
// автоматично сваляне на български субтитри, ако филмът няма такива
async function autoBgSubs(id) {
  if (!lib.settings.osKey || lib.settings.autoBgSubs === false) return;
  const r = await window.api.searchSubs(id);
  if (!P.item || P.item.id !== id || P.cues.length || P.subSel || !r || r.error || !r.results.length) return;
  const best = r.results[0];
  toast('Свалям български субтитри…');
  const d = await window.api.downloadSubs({ id, fileId: best.fileId });
  if (!P.item || P.item.id !== id || P.subSel || d.error) return d && d.error ? toast('Субтитри: ' + d.error, 5000) : null;
  P.cues = d.cues || []; P.subSel = { kind: 'file' }; buildMenus();
  toast(`✓ Български субтитри: ${d.name}`, 4000);
  if (!best.exact && P.cues.length) autoSync(true);
}
async function searchOnline() {
  const m = $('#p-subs');
  m.innerHTML = '<div class="lbl">Търся български субтитри…</div>';
  const id = P.item.id;
  const r = await window.api.searchSubs(id);
  if (!P.item || P.item.id !== id) return;
  if (r.error === 'nokey') { m.classList.add('hidden'); buildMenus(); return toast('Първо сложи безплатен ключ от OpenSubtitles в Настройки → Субтитри от интернет.', 7000); }
  if (r.error) { m.innerHTML = `<div class="lbl">Грешка: ${esc(r.error)}</div><div data-os="back">← Назад</div>`; return; }
  if (!r.results.length) { m.innerHTML = '<div class="lbl">Не намерих български субтитри.</div><div data-os="back">← Назад</div>'; return; }
  m.innerHTML = '<div data-os="back">← Назад</div><div class="sep"></div>' + r.results.map(x => `<div data-os="${x.fileId}" title="${esc(x.name)}">${x.exact ? '✅ ' : ''}${esc(x.name.length > 60 ? x.name.slice(0, 57) + '…' : x.name)} <span style="color:var(--mute)">· ${x.downloads}↓</span></div>`).join('')
    + '<div class="lbl">✅ = точно за този файл</div>';
}
async function selectSubs(sel) {
  P.subSel = sel; buildMenus();
  if (sel.kind === 'emb') toast('Зареждам субтитрите…');
  const cues = await window.api.subs({ id: P.item.id, kind: sel.kind, index: sel.index });
  if (P.subSel !== sel) return;
  P.cues = cues || [];
  if (!P.cues.length) toast('Субтитрите са празни или не могат да се прочетат.');
}
function renderSubs(t) {
  t -= P.subDelay || 0;
  const el = $('#subtitle');
  if (!P.cues.length) { if (el.textContent) el.textContent = ''; return; }
  // двоично търсене
  let lo = 0, hi = P.cues.length - 1, found = [];
  while (lo <= hi) { const m = (lo + hi) >> 1; if (P.cues[m].start <= t) lo = m + 1; else hi = m - 1; }
  for (let i = Math.max(0, hi - 3); i <= hi; i++) if (P.cues[i] && P.cues[i].start <= t && P.cues[i].end >= t) found.push(P.cues[i].text);
  const txt = found.join('\n').replace(/<\/?[ibu]>/g, '');
  if (el.textContent !== txt) el.textContent = txt;
}

// ---- скриване на контролите ----------------------------------------------
let idleT;
function showControls() {
  $('#player').classList.remove('idle');
  clearTimeout(idleT);
  idleT = setTimeout(() => { if (!video.paused && !document.querySelector('.menu:not(.hidden)')) $('#player').classList.add('idle'); }, 2800);
}
$('#player').addEventListener('mousemove', showControls);

document.addEventListener('keydown', (e) => {
  if ($('#player').classList.contains('hidden')) {
    if (e.key === 'Escape' && view.name === 'detail') { view = view.prev || { name: 'home' }; render(); }
    return;
  }
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'k') { video.paused ? video.play() : video.pause(); }
  else if (k === 'arrowleft') seek(curTime() - (e.shiftKey ? 60 : 10));
  else if (k === 'arrowright') seek(curTime() + (e.shiftKey ? 60 : 10));
  else if (k === 'arrowup') { video.volume = Math.min(1, video.volume + 0.05); $('#p-vol').value = video.volume; }
  else if (k === 'arrowdown') { video.volume = Math.max(0, video.volume - 0.05); $('#p-vol').value = video.volume; }
  else if (k === 'f' || k === 'ф') window.api.fullscreen();
  else if (k === 'm' || k === 'м') video.muted = !video.muted;
  else if (k === 'n' || k === 'н') $('#p-nextep').click();
  else if (k === 'r' || k === 'р') $('#p-shuffle').click();
  else if (k === 'g' || k === 'г') shiftSubs(-0.25);
  else if (k === 'h' || k === 'х') shiftSubs(0.25);
  else if (k === 's' || k === 'с') { $('#p-subs-btn').click(); }
  else if (k === 'a' || k === 'а') { $('#p-audio-btn').click(); }
  else if (k === 'escape') {
    const open = document.querySelector('.menu:not(.hidden)');
    if (open) open.classList.add('hidden'); else closePlayerIfNotFs();
  }
  else return;
  e.preventDefault(); showControls(); updateUI();
});
let isFs = false;
window.api.on('fullscreen', (v) => { isFs = v; });
function closePlayerIfNotFs() { if (isFs) window.api.fullscreen(false); else closePlayer(); }

refresh();
