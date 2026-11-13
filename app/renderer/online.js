'use strict';
// =========================================================================
// ОНЛАЙН ФИЛМИ — каталози и видео от добавки на Stremio.
// Каталог → страница на заглавието → списък с потоци → вградения плейър.
// Торент потоци (infoHash) не се поддържат — показват се като такива.
// Използва $, esc, toast, view, render, play, fmt от app.js.
// =========================================================================
const O = {
  data: null, loading: false, panel: 'browse',
  cat: null, genre: {}, metas: [], skip: 0, more: false, busy: false, err: '',
  q: '', results: null, searching: false, searchTok: 0,
  detail: null, season: null, video: null, streams: null, sBusy: false,
  found: new Map()   // web:id → { item, title, list }
};
const OTYPE = { movie: 'Филми', series: 'Сериали', channel: 'Канали', tv: 'Телевизия', anime: 'Аниме', other: 'Други' };
const OCAT = { Popular: 'Популярни', New: 'Нови', Featured: 'Препоръчани', 'Top': 'Топ', Trending: 'Набиращи популярност' };
const OGENRE = { Action: 'Екшън', Adventure: 'Приключенски', Animation: 'Анимация', Biography: 'Биография', Comedy: 'Комедия', Crime: 'Криминален', Documentary: 'Документален',
  Drama: 'Драма', Family: 'Семеен', Fantasy: 'Фентъзи', History: 'Исторически', Horror: 'Ужаси', Mystery: 'Мистерия', Romance: 'Романтичен', 'Sci-Fi': 'Фантастика',
  Sport: 'Спорт', Thriller: 'Трилър', War: 'Военен', Western: 'Уестърн', Music: 'Музика', Musical: 'Мюзикъл', 'Reality-TV': 'Риалити', 'Talk-Show': 'Токшоу', 'Game-Show': 'Игри', News: 'Новини' };
const oGenre = (g) => OGENRE[g] || g;
const catKey = (c) => c.addon + '|' + c.type + '|' + c.id;
const catLabel = (c) => `${OCAT[c.name] || c.name} ${OTYPE[c.type] ? OTYPE[c.type].toLowerCase() : c.type}${c.addonName && c.addonName !== c.name ? ' · ' + c.addonName : ''}`;

function onlineFound(id) { return O.found.get(id) || null; }

function oSet(d) {
  O.data = d;
  if (!O.cat || !d.catalogs.some(c => catKey(c) === O.cat)) { O.cat = d.catalogs[0] ? catKey(d.catalogs[0]) : null; O.metas = []; O.skip = 0; }
}
function onlineLoad() {
  if (O.loading) return;
  O.loading = true;
  window.api.stAddons().then(d => { O.loading = false; oSet(d); if (view.name === 'online') { render(); oLoadCatalog(); } })
    .catch(e => { O.loading = false; toast('Грешка: ' + e.message); });
}
const curCat = () => O.data && O.data.catalogs.find(c => catKey(c) === O.cat);

async function oLoadCatalog(more) {
  const c = curCat(); if (!c || O.busy) return;
  if (!more) { O.metas = []; O.skip = 0; }
  O.busy = true; O.err = ''; oUpdateGrid();
  const extra = {};
  const g = O.genre[O.cat] || (c.genreRequired ? c.genres[0] : '');
  if (g) extra.genre = g;
  if (O.skip) extra.skip = O.skip;
  const key = O.cat;
  const r = await window.api.stCatalog({ addon: c.addon, type: c.type, id: c.id, extra });
  if (key !== O.cat) { O.busy = false; return; }
  O.busy = false;
  if (r.error) O.err = r.error;
  const seen = new Set(O.metas.map(m => m.id));
  const add = (r.metas || []).filter(m => !seen.has(m.id));
  O.metas.push(...add);
  O.skip = O.metas.length;
  O.more = c.skip && add.length > 0;
  oUpdateGrid();
}

function oCard(m) {
  const art = m.poster ? `<img src="${esc(m.poster)}" loading="lazy" referrerpolicy="no-referrer" data-fallback="hide">` : '';
  return `<div class="card" data-ometa="${esc(m.type)}|${esc(m.id)}" title="${esc(m.name)}">
    <div class="art">${art}${m.poster ? '' : `<div class="fallback"><span>${esc(m.name)}</span></div>`}${m.imdbRating ? `<div class="badge">★ ${esc(m.imdbRating)}</div>` : ''}</div>
    <div class="meta"><div class="t">${esc(m.name)}</div><div class="s">${esc([m.releaseInfo, OTYPE[m.type] && m.type !== 'movie' ? OTYPE[m.type] : ''].filter(Boolean).join(' · '))}</div></div></div>`;
}

function oGridHtml() {
  if (O.results) {
    const secs = O.results.filter(s => s.metas.length);
    if (O.searching && !secs.length) return '<div class="hint">Търся…</div>';
    if (!secs.length) return '<div class="empty">Нищо не е намерено.</div>';
    return secs.map(s => `<h2>${esc(s.label)}</h2><div class="grid">${s.metas.map(oCard).join('')}</div>`).join('') + (O.searching ? '<div class="hint">Търся още…</div>' : '');
  }
  if (!O.data.catalogs.length) return '<div class="empty">Няма добавка с каталози. Отвори „🧩 Добавки“ и добави или върни стандартните.</div>';
  let h = O.metas.length ? `<div class="grid">${O.metas.map(oCard).join('')}</div>` : '';
  if (O.busy) h += '<div class="hint" style="margin-top:14px">Зареждам…</div>';
  else if (O.err) h += `<div class="empty">Грешка: ${esc(O.err)}</div>`;
  else if (!O.metas.length) h += '<div class="empty">Каталогът е празен.</div>';
  else if (O.more) h += '<div class="actions" style="justify-content:center;margin:20px 0"><button data-oact="more">Зареди още</button></div>';
  return h;
}
function oUpdateGrid() { const g = $('#online-grid'); if (g) g.innerHTML = oGridHtml(); }

function renderOnline() {
  if (!O.data) { onlineLoad(); return '<div id="online-page"><h2>🍿 Онлайн филми</h2><div class="hint">Зареждам добавките…</div></div>'; }
  if (view.name === 'odetail') return `<div id="online-page" class="wtv">${oDetailHtml()}</div>`;
  if (O.panel === 'addons') return `<div id="online-page" class="wtv">${oAddonsHtml()}</div>`;
  const c = curCat();
  const g = c && c.genres.length ? `<select id="o-genre" title="Жанр">${c.genreRequired ? '' : '<option value="">Всички</option>'}${c.genres.map(x => `<option value="${esc(x)}"${(O.genre[O.cat] || (c.genreRequired ? c.genres[0] : '')) === x ? ' selected' : ''}>${esc(oGenre(x))}</option>`).join('')}</select>` : '';
  if (!O.metas.length && !O.busy && !O.err && c && !O.results) setTimeout(() => oLoadCatalog(), 0);
  return `<div id="online-page" class="wtv"><h2>🍿 Онлайн филми <small>${O.data.addons.length} добавки</small></h2>
    <div class="wtv-bar">
      <input id="o-q" type="search" placeholder="Търси филм или сериал… (Enter)" value="${esc(O.q)}" autocomplete="off">
      <select id="o-cat" title="Каталог">${O.data.catalogs.map(x => `<option value="${esc(catKey(x))}"${catKey(x) === O.cat ? ' selected' : ''}>${esc(catLabel(x))}</option>`).join('')}</select>
      ${g}
      <button data-oact="addons">🧩 Добавки</button>
    </div>
    <div id="online-grid">${oGridHtml()}</div></div>`;
}

async function oSearch(q) {
  O.q = q;
  if (!q.trim()) { O.results = null; return render(); }
  const cats = O.data.catalogs.filter(c => c.search);
  if (!cats.length) { toast('Нито една добавка не поддържа търсене.'); return; }
  const tok = O.searchTok = (O.searchTok || 0) + 1;
  // по един каталог за търсене на добавка и тип (иначе Cinemeta връща същото 3 пъти)
  const uniq = new Map(); for (const c of cats) if (!uniq.has(c.addon + '|' + c.type)) uniq.set(c.addon + '|' + c.type, c);
  O.results = [...uniq.values()].map(c => ({ label: `${OTYPE[c.type] || c.type}${O.data.addons.length > 1 ? ' · ' + c.addonName : ''}`, metas: [] }));
  O.searching = true; render();
  await Promise.all([...uniq.values()].map(async (c, i) => {
    const r = await window.api.stCatalog({ addon: c.addon, type: c.type, id: c.id, extra: { search: q } });
    if (tok !== O.searchTok) return;
    O.results[i].metas = r.metas || []; oUpdateGrid();
  }));
  if (tok !== O.searchTok) return;
  O.searching = false; oUpdateGrid();
}

// ---- добавки ---------------------------------------------------------------
const ORES = { catalog: 'каталози', meta: 'информация', stream: 'видео', subtitles: 'субтитри', addon_catalog: 'списък с добавки' };
function oAddonsHtml() {
  const list = O.data.addons.map(a => `<div class="o-addon">
      <div class="o-logo">${a.logo ? `<img src="${esc(a.logo)}" referrerpolicy="no-referrer" data-fallback="remove">` : '🧩'}</div>
      <div class="grow"><div class="o-name">${esc(a.name)} <small>${esc(a.version || '')}${a.builtin ? ' · стандартна' : ''}</small></div>
        <div class="o-desc">${esc(a.description)}</div>
        <div class="genres" style="margin:6px 0 0">${a.resources.map(r => `<span>${esc(ORES[r] || r)}</span>`).join('')}${a.p2p ? '<span class="warn">торент — видеото няма да тръгне</span>' : ''}</div></div>
      <button data-oremove="${esc(a.url)}" title="Махни добавката">✕ Махни</button></div>`).join('');
  return `<button class="back" data-oact="browse">← Назад към каталога</button>
    <h2>🧩 Добавки</h2>
    <div class="hint">Добавките са като в Stremio. Постави адреса на добавката (завършва на <b>manifest.json</b>, може и <b>stremio://…</b>) и натисни „Добави“.
      Пускат се видеа с директен адрес (http/https, вкл. .m3u8). Торент потоци не се поддържат и се показват като „не се поддържа“.
      Използвай само добавки със съдържание, което имаш право да гледаш.</div>
    <div class="wtv-bar"><input id="o-url" type="search" placeholder="https://…/manifest.json" autocomplete="off"><button class="primary" data-oact="add">＋ Добави</button></div>
    <div class="o-addons">${list || '<div class="empty">Няма добавки.</div>'}</div>
    <div class="actions"><button data-oact="defaults">↺ Върни стандартните добавки</button><button data-oact="refresh">↻ Обнови добавките</button></div>`;
}

// ---- страница на заглавие --------------------------------------------------
async function oOpen(type, id) {
  O.detail = { type, id, meta: null, loading: true }; O.streams = null; O.video = null; O.season = null;
  view = { name: 'odetail', prev: { name: 'online' } }; $('#view').scrollTop = 0; render();
  const r = await window.api.stMeta({ type, id });
  if (!O.detail || O.detail.id !== id) return;
  const fromList = [...O.metas, ...(O.results || []).flatMap(s => s.metas)].find(m => m.id === id);
  O.detail.meta = r.meta || fromList || { id, type, name: id };
  O.detail.loading = false;
  const vids = O.detail.meta.videos || [];
  if (type === 'movie' || !vids.length) oLoadStreams(id);
  else { const ss = oSeasons(vids); O.season = ss.find(s => s > 0) ?? ss[0]; }
  if (view.name === 'odetail') render();
}
const oSeasons = (vids) => [...new Set(vids.map(v => v.season ?? 0))].sort((a, b) => a - b);

async function oLoadStreams(videoId) {
  const d = O.detail; if (!d) return;
  O.video = videoId; O.streams = null; O.sBusy = true; oUpdateStreams();
  const r = await window.api.stStreams({ type: d.type, id: videoId });
  if (O.detail !== d || O.video !== videoId) return;
  O.sBusy = false; O.streams = r; oUpdateStreams();
}

function oStreamsHtml() {
  if (!O.video) return '';
  if (O.sBusy) return '<div class="hint">Търся видео в добавките…</div>';
  const r = O.streams || { results: [] };
  if (!r.sources) return '<div class="empty" style="padding:30px">Нито една от добавките ти не дава видео за това заглавие.<br>Добави добавка с видео от „🧩 Добавки“.</div>';
  const all = r.results.flatMap(x => x.streams);
  const errs = r.results.filter(x => x.error).map(x => `${esc(x.addon)}: ${esc(x.error)}`);
  if (!all.length) return `<div class="empty" style="padding:30px">Добавките не намериха видео за това заглавие.${errs.length ? '<br><small>' + errs.join('<br>') + '</small>' : ''}</div>`;
  const order = { play: 0, external: 1, unsupported: 2 };
  const sorted = all.map((s, i) => ({ s, i })).sort((a, b) => order[a.s.kind] - order[b.s.kind] || a.i - b.i);
  O.flat = all;
  return `<div class="o-streams">${sorted.map(({ s, i }) => {
    const btn = s.kind === 'play' ? `<button class="primary" data-ostream="${i}">▶ Пусни</button>`
      : s.kind === 'external' ? `<button data-oext="${i}" title="${esc(s.url)}">↗ Отвори в ${esc(s.label)}</button>`
        : `<span class="o-unsup">${esc(s.why)}</span>`;
    return `<div class="o-stream${s.kind === 'unsupported' ? ' off' : ''}"><div class="grow"><div class="o-sname">${esc(s.name).replace(/\n/g, ' ')} <small>· ${esc(s.addon)}</small></div><div class="o-stitle">${esc(s.title).replace(/\n/g, '<br>')}</div></div>${btn}</div>`;
  }).join('')}</div>${errs.length ? `<div class="hint">${errs.join('<br>')}</div>` : ''}`;
}
function oUpdateStreams() { const el = $('#o-streams'); if (el) el.innerHTML = oStreamsHtml(); if (O.video && view.name === 'odetail') oMarkVideo(); }
function oMarkVideo() { document.querySelectorAll('[data-ovideo]').forEach(e => e.classList.toggle('sel', e.dataset.ovideo === O.video)); }

function oDetailHtml() {
  const d = O.detail;
  if (!d || d.loading) return '<button class="back" data-oact="browse">← Назад</button><div class="hint">Зареждам…</div>';
  const m = d.meta;
  let h = `<button class="back" data-oact="browse">← Назад</button><div class="detail-hero">
    <div class="bg" style="background-image:url('${esc(m.background || m.poster)}')"></div>
    <div class="poster">${m.poster ? `<img src="${esc(m.poster)}" referrerpolicy="no-referrer" data-fallback="remove">` : ''}</div>
    <div><h1>${esc(m.name)}</h1>
    <div class="sub">${[m.releaseInfo, m.imdbRating ? '★ ' + m.imdbRating : '', m.runtime, OTYPE[m.type]].filter(Boolean).map(esc).join(' · ')}</div>
    ${m.genres.length ? `<div class="genres">${m.genres.map(g => `<span>${esc(oGenre(g))}</span>`).join('')}</div>` : ''}
    ${m.description ? `<p>${esc(m.description)}</p>` : ''}
    ${m.director.length ? `<div class="sub">Режисьор: ${esc(m.director.join(', '))}</div>` : ''}
    ${m.cast.length ? `<div class="sub">Актьори: ${esc(m.cast.slice(0, 8).join(', '))}</div>` : ''}
    ${m.trailers.length ? `<div class="actions"><button data-otrailer="${esc(m.trailers[0])}">▶ Трейлър (YouTube)</button></div>` : ''}
    </div></div>`;
  const vids = m.videos || [];
  if (d.type !== 'movie' && vids.length) {
    const ss = oSeasons(vids);
    h += `<div class="seasons">${ss.map(s => `<button data-oseason="${s}" class="${s === O.season ? 'active' : ''}">${s === 0 ? 'Специални' : 'Сезон ' + s}</button>`).join('')}</div><div class="o-split"><div class="episodes">`;
    for (const v of vids.filter(v => (v.season ?? 0) === O.season).sort((a, b) => (a.episode || 0) - (b.episode || 0))) {
      const lbl = v.episode != null ? `S${String(v.season ?? 0).padStart(2, '0')}E${String(v.episode).padStart(2, '0')}` : '';
      h += `<div class="ep${v.id === O.video ? ' sel' : ''}" data-ovideo="${esc(v.id)}"><div class="img">${v.thumbnail ? `<img src="${esc(v.thumbnail)}" loading="lazy" referrerpolicy="no-referrer" data-fallback="hide">` : ''}</div>
        <div class="grow"><div class="num">${lbl}</div><div class="name">${esc(v.title || 'Епизод ' + (v.episode ?? ''))}</div><div class="info">${esc(v.released ? new Date(v.released).toLocaleDateString('bg-BG') : '')}</div></div></div>`;
    }
    h += `</div><div id="o-streams">${O.video ? oStreamsHtml() : '<div class="hint">Избери епизод, за да видиш видеата за него.</div>'}</div></div>`;
  } else {
    h += `<h2 style="margin-top:22px">Видео</h2><div id="o-streams">${oStreamsHtml()}</div>`;
  }
  return h;
}

async function oPlay(s) {
  const d = O.detail; if (!d) return;
  const m = d.meta, v = (m.videos || []).find(x => x.id === O.video);
  const title = v && v.episode != null ? `${m.name} — S${String(v.season ?? 0).padStart(2, '0')}E${String(v.episode).padStart(2, '0')}${v.title ? ' · ' + v.title : ''}` : m.name;
  toast('Отварям видеото…');
  const r = await window.api.stPrepare({ url: s.url, headers: s.headers, notWeb: s.notWeb, subtitles: s.subtitles, type: d.type, videoId: O.video, title });
  if (r.error) return toast(r.error);
  O.found.set(r.id, { item: { id: r.id, type: 'web' }, title, list: [] });
  play(r.id);
}

// ---- събития ---------------------------------------------------------------
document.addEventListener('keydown', (ev) => {
  if (ev.target.id === 'o-q' && ev.key === 'Enter') oSearch(ev.target.value);
  if (ev.target.id === 'o-url' && ev.key === 'Enter') $('[data-oact="add"]').click();
  if (ev.key === 'Escape' && view.name === 'odetail' && $('#player').classList.contains('hidden') && ev.target.tagName !== 'INPUT') { view = { name: 'online' }; render(); }
});
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'o-q' && !ev.target.value && O.results) { O.q = ''; O.results = null; O.searchTok++; oUpdateGrid(); }
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'o-cat') { O.cat = ev.target.value; O.results = null; O.q = ''; O.metas = []; render(); }
  if (ev.target.id === 'o-genre') { O.genre[O.cat] = ev.target.value; O.results = null; oLoadCatalog(); }
});
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-ometa],[data-oact],[data-oremove],[data-oseason],[data-ovideo],[data-ostream],[data-oext],[data-otrailer]');
  if (!t || !t.closest('#view')) return;
  const d = t.dataset;
  if (d.ometa) { const [type, ...rest] = d.ometa.split('|'); return oOpen(type, rest.join('|')); }
  if (d.oseason !== undefined) { O.season = +d.oseason; return render(); }
  if (d.ovideo) { oLoadStreams(d.ovideo); return oMarkVideo(); }
  if (d.ostream !== undefined) { const s = O.flat && O.flat[+d.ostream]; if (s) oPlay(s); return; }
  if (d.oext !== undefined) { const s = O.flat && O.flat[+d.oext]; if (s) window.api.openExternal(s.url); return; }
  if (d.otrailer) return window.api.openExternal('https://www.youtube.com/watch?v=' + encodeURIComponent(d.otrailer));
  if (d.oremove) {
    const a = O.data.addons.find(x => x.url === d.oremove);
    if (!a || !confirmInline(t)) return;
    oSet(await window.api.stRemove(d.oremove)); toast(`Махнах „${a.name}“`); return render();
  }
  const act = d.oact;
  if (act === 'more') return oLoadCatalog(true);
  if (act === 'addons') { O.panel = 'addons'; return render(); }
  if (act === 'browse') { O.panel = 'browse'; view = { name: 'online' }; return render(); }
  if (act === 'add') {
    const inp = $('#o-url'); const url = inp && inp.value.trim(); if (!url) return toast('Постави адреса на добавката.');
    t.disabled = true; t.textContent = 'Добавям…';
    const r = await window.api.stAdd(url);
    t.disabled = false; t.textContent = '＋ Добави';
    if (r.error) return toast('Не успях: ' + r.error, 6000);
    oSet(r); toast('✓ Добавката е добавена'); return render();
  }
  if (act === 'defaults') { oSet(await window.api.stDefaults()); toast('Стандартните добавки са върнати'); return render(); }
  if (act === 'refresh') { toast('Обновявам…'); oSet(await window.api.stRefresh()); return render(); }
});
// втори клик потвърждава (без модални прозорци)
function confirmInline(btn) {
  if (btn.dataset.sure) return true;
  btn.dataset.sure = '1'; const old = btn.textContent; btn.textContent = 'Сигурен ли си? Натисни пак';
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.sure; btn.textContent = old; } }, 3000);
  return false;
}
