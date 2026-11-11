'use strict';
// =========================================================================
// РАДИО — българските радиостанции от radiosbg.com, пускани в програмата.
// Лентата долу продължава да свири, докато разглеждаш другите раздели.
// Използва $, esc, toast, view, render, lib от app.js и norm, latin от worldtv.js.
// =========================================================================
const R = { data: null, loading: false, q: '', favOnly: false, list: [], cur: null, streams: [], si: -1, hls: null, timer: null, token: 0 };
const ra = $('#radio-audio');

const rFavs = () => new Set(lib.settings.radioFavs || []);

function radioLoad() {
  if (R.loading) return;
  R.loading = true;
  window.api.radioList().then(d => {
    R.loading = false;
    for (const s of d.stations) { const n = norm(s.name); s._n = n + ' ' + latin(n); }
    R.data = d;
    if (view.name === 'radio') render();
  }).catch(e => { R.loading = false; toast('Грешка: ' + e.message); });
}

function radioFilter() {
  const all = R.data ? R.data.stations : [];
  const q = norm(R.q), ql = latin(q), f = rFavs();
  R.list = all.filter(s => (!R.favOnly || f.has(s.slug)) && (!q || s._n.includes(q) || s._n.includes(ql)));
  if (q) {
    const starts = (s) => s._n.startsWith(q) || s._n.startsWith(ql) || norm(s.name).replace(/^радио/, '').startsWith(q) ? 0 : 1;
    R.list.sort((a, b) => starts(a) - starts(b));
  }
  return R.list;
}

function radioCard(s, f) {
  const on = R.cur && R.cur.slug === s.slug;
  return `<div class="radio-card${on ? ' cur' : ''}" data-radio="${esc(s.slug)}" title="Слушай ${esc(s.name)}">
    <div class="radio-logo">${s.logo ? `<img src="${esc(s.logo)}" loading="lazy" referrerpolicy="no-referrer" data-fallback="hide">` : ''}<span>📻</span></div>
    <div class="radio-name">${on ? '<b class="eq"><i></i><i></i><i></i></b>' : ''}${esc(s.name)}</div>
    <button class="wtv-star${f.has(s.slug) ? ' on' : ''}" data-radio-fav="${esc(s.slug)}" title="Любимо">${f.has(s.slug) ? '★' : '☆'}</button>
  </div>`;
}

function radioGridHtml() {
  const list = radioFilter(), f = rFavs();
  if (!list.length) return `<div class="empty">${R.favOnly && !f.size ? 'Нямаш любими радиа още — натисни ☆ на някое радио.' : 'Няма радио с такова име.'}</div>`;
  return `<div class="wtv-count">${list.length} радиа</div><div class="radio-grid">${list.map(s => radioCard(s, f)).join('')}</div>`;
}
function radioUpdateGrid() { const g = $('#radio-grid'); if (g) g.innerHTML = radioGridHtml(); }

function renderRadio() {
  if (!R.data) { radioLoad(); return '<h2>📻 Радио</h2><div class="hint">Зареждам…</div>'; }
  return `<div class="wtv radio"><h2>📻 Радио <small>${R.data.stations.length} български радиа</small></h2>
    <div class="wtv-bar">
      <input id="radio-q" type="search" placeholder="Търси радио по име…" value="${esc(R.q)}" autocomplete="off">
      <button class="${R.favOnly ? 'on' : ''}" data-radio-act="favs">★ Любими</button>
    </div>
    <div class="hint">Списъкът е от radiosbg.com, а звукът идва направо от сървърите на радиата. Ако някое не тръгне, програмата пробва следващия му адрес сама.
      Радиото продължава да свири, докато разглеждаш другите раздели, и спира само, когато пуснеш филм или телевизия.</div>
    <div id="radio-grid">${radioGridHtml()}</div></div>`;
}

// ---- събития в списъка ---------------------------------------------------
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'radio-q') { R.q = ev.target.value; clearTimeout(R.qT); R.qT = setTimeout(radioUpdateGrid, 100); }
});
document.addEventListener('keydown', (ev) => {
  if (ev.target.id === 'radio-q' && ev.key === 'Enter') { const first = radioFilter()[0]; if (first) radioPlay(first); }
});
async function radioToggleFav(slug) {
  const f = rFavs();
  if (f.has(slug)) f.delete(slug); else f.add(slug);
  lib.settings = await window.api.setSettings({ radioFavs: [...f] });
  return f.has(slug);
}
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-radio],[data-radio-fav],[data-radio-act]');
  if (!t || !t.closest('#view')) return;
  const d = t.dataset;
  if (d.radioFav !== undefined) { ev.stopPropagation(); const on = await radioToggleFav(d.radioFav); if (R.favOnly) return radioUpdateGrid(); t.classList.toggle('on', on); t.textContent = on ? '★' : '☆'; radioBarUI(); return; }
  if (d.radioAct === 'favs') { R.favOnly = !R.favOnly; t.classList.toggle('on', R.favOnly); return radioUpdateGrid(); }
  if (d.radio !== undefined) {
    const s = R.data && R.data.stations.find(x => x.slug === d.radio);
    if (!s) return;
    if (R.cur && R.cur.slug === s.slug && !ra.paused) return;   // вече свири
    radioPlay(s);
  }
});

// ---- плейър ----------------------------------------------------------------
function radioStopMedia() {
  clearTimeout(R.timer);
  if (R.hls) { try { R.hls.destroy(); } catch {} R.hls = null; }
  ra.pause(); ra.removeAttribute('src'); ra.load();
}
const radioStatus = (txt, err) => { const el = $('#radio-status'); el.textContent = txt || ''; el.classList.toggle('err', !!err); };

async function radioPlay(s, force) {
  if (!force) R.streams = [];
  R.cur = s; R.token++;
  const tok = R.token;
  radioStopMedia();
  $('#radio-bar').classList.remove('hidden');
  document.body.classList.add('radio-on');
  $('#radio-title').textContent = s.name;
  $('#radio-logo').innerHTML = s.logo ? `<img src="${esc(s.logo)}" referrerpolicy="no-referrer" data-fallback="remove">` : '📻';
  radioStatus('Свързвам…');
  radioBarUI(); radioUpdateGrid();
  window.api.setSettings({ radioLast: s.slug }).then(st => { lib.settings = st; });
  let r;
  try { r = await window.api.radioResolve(s.slug, !!force); } catch (e) { r = { streams: [], error: e.message }; }
  if (tok !== R.token) return;
  const streams = (r && r.streams) || [];
  if (force && streams.join() === R.streams.join()) {   // radiosbg.com няма по-нов адрес — няма смисъл да чакаме пак
    radioUpdateGrid(); radioBarUI();
    return radioStatus('Радиото не отговаря в момента. Опитай пак по-късно.', true);
  }
  R.streams = streams;
  R.live = (r && r.live) || [];
  R.si = -1; R.force = !!force;
  radioNext(tok);
}

function radioNext(tok, why) {
  if (tok !== R.token) return;
  radioStopMedia();
  R.si++;
  const total = R.streams.length * 2;   // всеки адрес: направо, после през ffmpeg
  if (R.si >= total) {
    if (!R.force) return radioPlay(R.cur, true);   // още веднъж с пресни адреси от radiosbg.com
    radioUpdateGrid(); radioBarUI();
    return radioStatus('Радиото не отговаря в момента' + (why ? ' (' + why + ')' : '') + '.', true);
  }
  const viaFf = R.si >= R.streams.length;
  const url = viaFf ? R.live[R.si - R.streams.length] : R.streams[R.si];
  if (!url) return radioNext(tok, why);
  radioStatus(viaFf ? 'Пробвам през ffmpeg…' : R.si ? 'Пробвам друг адрес…' : 'Свързвам…');
  R.timer = setTimeout(() => radioNext(tok, 'няма звук'), viaFf ? 25000 : 12000);
  if (!viaFf && /\.m3u8(\?|#|$)/i.test(url) && window.Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: false, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 3 });
    R.hls = hls;
    let recovered = false;
    hls.on(Hls.Events.MANIFEST_PARSED, () => ra.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal || R.hls !== hls) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; return hls.recoverMediaError(); }
      radioNext(tok, data.details);
    });
    hls.loadSource(url);
    hls.attachMedia(ra);
  } else {
    ra.src = url;
    ra.play().catch(() => {});
  }
}

ra.addEventListener('playing', () => { clearTimeout(R.timer); radioStatus('● НА ЖИВО'); radioBarUI(); });
ra.addEventListener('waiting', () => { if (R.cur) radioStatus('Зарежда…'); });
ra.addEventListener('pause', radioBarUI);
ra.addEventListener('volumechange', () => { radioBarUI(); clearTimeout(R.volT); R.volT = setTimeout(() => window.api.setSettings({ radioVol: ra.volume }).then(st => { lib.settings = st; }), 600); });
ra.addEventListener('error', () => { if (R.hls || !ra.getAttribute('src')) return; radioNext(R.token, 'форматът не се поддържа'); });
ra.addEventListener('ended', () => { if (R.cur) radioNext(R.token, 'потокът спря'); });

function radioBarUI() {
  if (!R.cur) return;
  $('#radio-play').textContent = ra.paused ? '▶' : '❚❚';
  $('#radio-mute').textContent = ra.muted || ra.volume === 0 ? '🔇' : '🔊';
  $('#radio-vol').value = ra.muted ? 0 : ra.volume;
  const on = rFavs().has(R.cur.slug);
  $('#radio-fav').textContent = on ? '★' : '☆';
  $('#radio-fav').classList.toggle('on', on);
}

function radioStep(dir) {
  const list = R.list.length ? R.list : (R.data ? R.data.stations : []);
  if (!list.length) return;
  const i = R.cur ? list.findIndex(s => s.slug === R.cur.slug) : -1;
  radioPlay(list[(i + dir + list.length) % list.length]);
}

function radioClose() {
  R.token++; radioStopMedia(); R.cur = null; R.streams = [];
  $('#radio-bar').classList.add('hidden');
  document.body.classList.remove('radio-on');
  radioUpdateGrid();
}

$('#radio-bar').addEventListener('click', async (ev) => {
  const t = ev.target.closest('button');
  if (!t || !R.cur) return;
  if (t.id === 'radio-play') {
    if (!ra.paused) return ra.pause();
    if (!ra.getAttribute('src') && !R.hls) return radioPlay(R.cur);
    // на живо: след пауза започваме отначало, за да не изостава
    return radioPlay(R.cur);
  }
  if (t.id === 'radio-prev') return radioStep(-1);
  if (t.id === 'radio-next') return radioStep(1);
  if (t.id === 'radio-mute') { ra.muted = !ra.muted; if (!ra.muted && ra.volume === 0) ra.volume = 0.5; return; }
  if (t.id === 'radio-fav') { const on = await radioToggleFav(R.cur.slug); toast(on ? 'Добавено в любими.' : 'Махнато от любими.'); radioBarUI(); return radioUpdateGrid(); }
  if (t.id === 'radio-close') return radioClose();
});
$('#radio-vol').addEventListener('input', (e) => { ra.volume = +e.target.value; ra.muted = ra.volume === 0; });
$('#radio-title').addEventListener('click', () => { if (view.name !== 'radio') { view = { name: 'radio' }; render(); } });

// филм или телевизия → радиото спира
for (const id of ['#video', '#wtv-video']) { const el = $(id); if (el) el.addEventListener('play', () => { if (!ra.paused) ra.pause(); }); }

// начална сила на звука
window.api.getLibrary().then(l => { const v = l.settings && l.settings.radioVol; if (typeof v === 'number') ra.volume = Math.min(1, Math.max(0, v)); }).catch(() => {});
