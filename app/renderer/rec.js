'use strict';
// =========================================================================
// ЗАПИСИ — бутонът ⏺ в плейъра на World TV и раздел „📼 Записи“.
// Използва $, esc, toast, view, render, lib, fmt, play, findItem от app.js и W, wtvLoad, wtvMinimize от worldtv.js.
// =========================================================================
const RS = { st: null, loading: false };
const recHm = (t) => new Date(t).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
function recDay(t) {
  const a = new Date(t); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  const d = Math.round((a - b) / 86400e3);
  return d === 0 ? 'днес' : d === 1 ? 'утре' : d === -1 ? 'вчера' : new Date(t).toLocaleDateString('bg-BG', { weekday: 'short', day: 'numeric', month: 'short' });
}
const recMb = (b) => !b ? '' : b > 1e9 ? (b / 1e9).toFixed(1).replace('.', ',') + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB';
const recMin = (s) => { const m = Math.round((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`; };
const recEp = (r) => [r.ep ? `С${r.ep.s} еп. ${r.ep.e}` : '', r.sub || ''].filter(Boolean).join(' · ');
const recChOf = (c) => c && { url: c.url, name: c.name, tvgId: c.tvgId, country: c.country, ua: c.ua, referrer: c.referrer, logo: c.logo };

async function recLoad() {
  if (RS.loading) return;
  RS.loading = true;
  try { RS.st = await window.api.recState(); } finally { RS.loading = false; }
  recUI();
}
window.api.on('rec-changed', (st) => { RS.st = st; recUI(); });
function recUI() {
  recBtn();
  if (view.name === 'rec' && $('#rec-body')) $('#rec-body').innerHTML = recBody();
  if (!$('#wtv-rec-menu').classList.contains('hidden')) recMenuFill();
}
const recActiveFor = (url) => ((RS.st && RS.st.recs) || []).filter(r => r.status === 'recording' && r.chUrl === url);

// ---- в плейъра -------------------------------------------------------------
function recBtn() {
  const b = $('#wtv-rec');
  if (!b) return;
  const ch = W.list[W.cur];
  const act = ch ? recActiveFor(ch.url) : [];
  b.classList.toggle('on', act.length > 0);
  b.textContent = act.length ? '● Запис ' + fmt(act[0].recorded || 0) : '⏺ Запис';
}
function recMenuToggle() {
  const m = $('#wtv-rec-menu');
  if (!m.classList.contains('hidden')) return m.classList.add('hidden');
  recMenuFill();
  m.classList.remove('hidden');
  if (!RS.st) recLoad();
}
function recMenuFill() {
  const ch = W.list[W.cur], m = $('#wtv-rec-menu');
  if (!ch) return;
  const e = W.epg || {}, p = e.now, nx = (e.next || []).slice(0, 4);
  const rows = [];
  for (const r of recActiveFor(ch.url)) rows.push(`<div data-rec-m="stop" data-id="${esc(r.id)}">⏹ Спри записа на „${esc(r.title)}“</div>`);
  if (p) rows.push(`<div data-rec-m="prog">⏺ Запиши „${esc(p.title)}“ <small>до ${recHm(p.stop)} (+5 мин)</small></div>`);
  rows.push(`<div data-rec-m="now">⏺ Запиши, докато го спра <small>до 4 часа</small></div>`);
  if (p) rows.push(`<div data-rec-m="rule" data-t="${esc(p.title)}">🔁 Записвай „${esc(p.title)}“ винаги</div>`);
  if (nx.length) {
    rows.push('<h5>Следва — натисни, за да се запише</h5>');
    nx.forEach((x, i) => rows.push(`<div data-rec-m="once" data-i="${i}">⏰ ${recHm(x.start)} ${esc(x.title)}</div>`));
  }
  if (!p && !nx.length) rows.push('<h5>Няма програма за този канал — записвай ръчно</h5>');
  rows.push('<div data-rec-m="page">📼 Всички записи и график…</div>');
  m.innerHTML = rows.join('');
}
$('#wtv-rec-menu').addEventListener('click', async (ev) => {
  ev.stopPropagation();
  const t = ev.target.closest('[data-rec-m]');
  if (!t) return;
  const ch = recChOf(W.list[W.cur]), e = W.epg || {}, k = t.dataset.recM;
  $('#wtv-rec-menu').classList.add('hidden');
  let r = null;
  if (k === 'stop') { await window.api.recStop(t.dataset.id); toast('Спирам записа — файлът се запазва…'); }
  else if (k === 'prog') r = await window.api.recNow({ ch, prog: e.now });
  else if (k === 'now') r = await window.api.recNow({ ch });
  else if (k === 'rule') {
    r = await window.api.recAddRule({ ch, title: t.dataset.t });
    if (!r.error) toast(`🔁 Ще записвам всеки епизод на „${t.dataset.t}“ по ${ch.name}. Виж „📼 Записи“.`, 5000);
  } else if (k === 'once') {
    const p = (e.next || [])[+t.dataset.i];
    if (p) { r = await window.api.recOnce({ ch, prog: p }); if (!r.error) toast(`⏰ Ще запиша „${p.title}“ в ${recHm(p.start)}.`, 4000); }
  } else if (k === 'page') { wtvMinimize(); view = { name: 'rec' }; render(); }
  if (r && r.error) toast(r.error, 5000);
  recLoad();
});
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#wtv-rec,#wtv-rec-menu')) $('#wtv-rec-menu').classList.add('hidden');
});

// ---- раздел „Записи“ ----------------------------------------------------------
function recFormChannels() {
  const sel = $('#rec-ch');
  if (!sel || !W.data) return;
  const cur = sel.value;
  const seen = new Set(), opts = [];
  const add = (url, grp) => { const c = W.byUrl.get(url); if (c && !seen.has(url)) { seen.add(url); opts.push({ c, grp }); } };
  if (W.list[W.cur]) add(W.list[W.cur].url, 'Сега');
  for (const u of lib.settings.wtvFavs || []) add(u, 'Любими');
  for (const u of lib.settings.wtvRecent || []) add(u, 'Наскоро гледани');
  for (const c of W.data.channels) if (c.country === 'BG') add(c.url, 'Български');
  const groups = [...new Set(opts.map(o => o.grp))];
  sel.innerHTML = '<option value="">— избери канал —</option>' + groups.map(g => `<optgroup label="${esc(g)}">${opts.filter(o => o.grp === g).map(o => `<option value="${esc(o.c.url)}">${esc(o.c.name)}</option>`).join('')}</optgroup>`).join('');
  if (cur && seen.has(cur)) sel.value = cur;
  else if (W.list[W.cur]) sel.value = W.list[W.cur].url;
  recTitles();
}
async function recTitles() {
  const sel = $('#rec-ch'), dl = $('#rec-titles');
  if (!sel || !dl) return;
  const c = W.byUrl.get(sel.value);
  dl.innerHTML = '';
  if (!c) return;
  const list = await window.api.recTitles(recChOf(c));
  if ($('#rec-ch') && $('#rec-ch').value === c.url) dl.innerHTML = list.map(t => `<option value="${esc(t)}">`).join('');
}

function renderRec() {
  if (!RS.st) recLoad();
  if (!W.data) wtvLoad(false);
  setTimeout(recFormChannels, 0);
  return `<div id="rec-page" class="rec"><h2>📼 Записи</h2>
    <div class="hint">Напиши името на сериала така, както е в програмата на канала, и избери канала. Кинотека следи програмата и записва всеки епизод сама —
      започва 2 минути по-рано и спира 5 минути след края. Рекламите се изрязват сами там, където каналът ги отбелязва в потока;
      иначе след записа се търсят по черните кадри и тишината и ги изрязваш с едно натискане.
      <b>Компютърът и Кинотека трябва да са включени</b> по време на излъчването.</div>
    <div class="rec-add">
      <input id="rec-title" list="rec-titles" placeholder="Име на сериала, напр. Малкълм" autocomplete="off">
      <datalist id="rec-titles"></datalist>
      <select id="rec-ch"><option value="">Зареждам каналите…</option></select>
      <button class="primary" data-rec="add">🔁 Записвай го</button>
    </div>
    <div id="rec-body">${recBody()}</div></div>`;
}

function recBody() {
  const st = RS.st;
  if (!st) return '<div class="hint">Зареждам…</div>';
  const out = [];
  const live = st.recs.filter(r => r.status === 'recording' || r.status === 'saving');
  if (live.length) {
    out.push('<h3>● Записва се сега</h3>');
    for (const r of live) out.push(`<div class="rec-row live"><div class="grow"><b>${esc(r.title)}</b> <span>${esc(recEp(r))}</span>
      <small>${esc(r.chName)} · ${r.status === 'saving' ? 'слепвам файла…' : `${fmt(r.recorded || 0)} записани · ${recMb(r.bytes)} · спира в ${recHm(r.planStop)}`}
      ${r.cuts ? ` · изрязани реклами: ${r.cuts} (${recMin(r.cutSecs)})` : ''}${r.mode === 'ffmpeg' ? ' · без маркери за реклами' : ''}${r.error ? ` · <i class="warn">${esc(r.error)}</i>` : ''}</small></div>
      ${r.status === 'recording' ? `<button data-rec="stop" data-id="${esc(r.id)}">⏹ Спри</button>` : ''}</div>`);
  }
  out.push('<h3>🔁 Сериали, които се записват сами</h3>');
  if (!st.rules.length) out.push('<div class="hint">Още няма. Добави от полето горе или от бутона ⏺ Запис, докато гледаш канал.</div>');
  for (const r of st.rules) out.push(`<div class="rec-row"><div class="grow"><b>${esc(r.title)}</b> <small>${esc(r.ch.name)}${r.epg === false ? ' · <i class="warn">няма програма за този канал — не мога да знам кога върви</i>' : ''}</small></div>
    <button data-rec="repeats" data-id="${esc(r.id)}" title="Дали да записва повторно епизод, който вече е записан">${r.skipRepeats !== false ? 'Повторенията: пропускай' : 'Повторенията: записвай'}</button>
    <button data-rec="unrule" data-id="${esc(r.id)}" title="Спри да го записваш">✕</button></div>`);

  const up = st.upcoming.filter(u => !u.busy);
  out.push(`<h3>⏰ Предстоящи <button class="small" data-rec="refresh" title="Провери програмата наново">⟳</button></h3>`);
  if (!up.length) out.push(`<div class="hint">${st.rules.length ? 'В програмата за следващите часове няма такива предавания.' : 'Нищо не е насрочено.'}</div>`);
  for (const u of up) {
    const why = u.skip ? 'пропуска се' : u.repeat ? 'повторение — вече е записан' : '';
    out.push(`<div class="rec-row${why ? ' off' : ''}"><div class="when">${recDay(u.start)} ${recHm(u.start)}–${recHm(u.stop)}</div>
      <div class="grow"><b>${esc(u.title)}</b> <span>${esc(recEp(u))}</span> <small>${esc(u.ch.name)}${why ? ' · ' + why : ''}</small></div>
      <button data-rec="skip" data-key="${esc(u.key)}">${u.skip ? 'Запиши' : 'Пропусни'}</button></div>`);
  }

  const done = st.recs.filter(r => r.status === 'done' || r.status === 'failed');
  out.push('<h3>🎞 Готови записи</h3>');
  if (!done.length) out.push('<div class="hint">Още няма записи.</div>');
  for (const r of done) {
    const info = r.status === 'failed' ? `<i class="warn">⚠ ${esc(r.err || 'Неуспешен запис')}</i>`
      : [recDay(r.start) + ' ' + recHm(r.start), esc(r.chName), r.recorded ? recMin(r.recorded) : '', recMb(r.bytes),
        r.cuts ? `✂ изрязани реклами: ${r.cuts} (${recMin(r.cutSecs)})` : ''].filter(Boolean).join(' · ');
    const marks = (r.marks || []).map(m => `<div class="rec-mark">Възможна реклама <b>${fmt(m.from)}–${fmt(m.to)}</b> (${recMin(m.to - m.from)})
      <button class="small" data-rec="play" data-id="${esc(r.id)}" data-at="${Math.max(0, m.from - 3)}">▶ Виж</button>
      <button class="small" data-rec="cut" data-id="${esc(r.id)}" data-from="${m.from}" data-to="${m.to}">✂ Изрежи</button></div>`).join('');
    out.push(`<div class="rec-row${r.status === 'failed' ? ' off' : ''}"><div class="grow"><b>${esc(r.title)}</b> <span>${esc(recEp(r))}</span><small>${info}</small>
      ${r.marking ? '<div class="rec-mark">🔎 Търся рекламите…</div>' : marks}</div>
      ${r.status === 'done' ? `<button data-rec="play" data-id="${esc(r.id)}">▶ Пусни</button><button data-rec="show" data-id="${esc(r.id)}" title="Покажи файла">📂</button>` : ''}
      <button data-rec="remove" data-id="${esc(r.id)}" title="${r.status === 'done' ? 'Изтрий записа (отива в кошчето)' : 'Махни от списъка'}">🗑</button></div>`);
  }
  out.push(`<div class="hint rec-dir">Записите се пазят в <b>${esc(st.dir)}</b> и се появяват в раздел „📺 Сериали“. <a data-rec="dir">Смени папката</a></div>`);
  return out.join('');
}

document.addEventListener('change', (ev) => { if (ev.target.id === 'rec-ch') recTitles(); });
document.addEventListener('keydown', (ev) => { if (ev.target.id === 'rec-title' && ev.key === 'Enter') { const b = $('[data-rec="add"]'); if (b) b.click(); } });
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-rec]');
  if (!t || !t.closest('#rec-page')) return;
  const d = t.dataset, a = d.rec;
  let st = null;
  if (a === 'add') {
    const title = $('#rec-title').value.trim(), c = W.byUrl.get($('#rec-ch').value);
    if (!title) return toast('Напиши името на сериала.');
    if (!c) return toast('Избери канал.');
    st = await window.api.recAddRule({ ch: recChOf(c), title });
    if (st.error) return toast(st.error);
    $('#rec-title').value = '';
    toast(`🔁 Ще записвам „${title}“ по ${c.name}.`);
  }
  else if (a === 'stop') { await window.api.recStop(d.id); toast('Спирам записа — файлът се запазва…'); }
  else if (a === 'unrule') st = await window.api.recRemoveRule(d.id);
  else if (a === 'repeats') st = await window.api.recRuleRepeats(d.id);
  else if (a === 'skip') st = await window.api.recSkip(d.key);
  else if (a === 'refresh') { toast('Проверявам програмата…'); st = await window.api.recRefresh(); }
  else if (a === 'show') window.api.recShow(d.id);
  else if (a === 'dir') st = await window.api.recDir();
  else if (a === 'remove') {
    const r = RS.st.recs.find(x => x.id === d.id);
    if (r && r.status === 'done' && !confirm(`Да изтрия ли записа „${r.title}“? Файлът отива в кошчето.`)) return;
    st = await window.api.recRemove(d.id);
  }
  else if (a === 'cut') {
    if (!confirm(`Да изрежа ли частта от ${fmt(+d.from)} до ${fmt(+d.to)}? Това не може да се върне.`)) return;
    t.disabled = true; toast('Изрязвам…');
    const r = await window.api.recCut({ id: d.id, from: +d.from, to: +d.to });
    toast(r.error ? 'Не стана: ' + r.error : '✂ Изрязано.');
  }
  else if (a === 'play') {
    const r = await window.api.recPlay(d.id);
    if (r.error) return toast(r.error);
    if (r.external) return toast('Записът още не е в библиотеката — отворих го с друга програма.');
    if (!findItem(r.libId)) lib = await window.api.getLibrary();
    play(r.libId, d.at !== undefined ? { at: +d.at } : {});
  }
  if (st && !st.error) { RS.st = st; recUI(); }
});

recLoad();
