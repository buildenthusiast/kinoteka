'use strict';
// =========================================================================
// WORLD TV — каналите от iptv-org, пускани в програмата (hls.js, а при нужда през ffmpeg)
// Използва $, esc, toast, view, render, lib и isFs от app.js.
// =========================================================================
const W = { data: null, loading: false, q: '', country: '', cat: '', favOnly: false, limit: 240, list: [], shown: [], health: {}, byUrl: new Map(), deadHidden: 0, cur: -1, hls: null, stage: 0, timer: null, token: 0 };

const WTV_CAT = { Animation: 'Анимация', Auto: 'Авто', Business: 'Бизнес', Classic: 'Класика', Comedy: 'Комедия', Cooking: 'Кулинария', Culture: 'Култура',
  Documentary: 'Документални', Education: 'Образование', Entertainment: 'Развлекателни', Family: 'Семейни', General: 'Общи', Kids: 'Детски', Legislative: 'Парламент',
  Lifestyle: 'Лайфстайл', Movies: 'Филми', Music: 'Музика', News: 'Новини', Outdoor: 'Природа и лов', Relax: 'Релакс', Religious: 'Религия', Science: 'Наука',
  Series: 'Сериали', Shop: 'Пазаруване', Sports: 'Спорт', Travel: 'Пътешествия', Weather: 'Времето', Public: 'Обществени', Interactive: 'Интерактивни', Undefined: 'Без категория' };
const wtvCat = (c) => WTV_CAT[c] || c;
let regionNames = null;
try { regionNames = new Intl.DisplayNames(['bg'], { type: 'region' }); } catch {}
const wtvCountry = (c) => { if (!c) return 'Неизвестна'; try { return (regionNames && regionNames.of(c)) || c; } catch { return c; } };

// търсене и на кирилица: „бнт“ намира „BNT“
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya' };
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_.:'’!]+/g, '');
const latin = (s) => s.replace(/[а-я]/g, c => CYR[c] ?? c);

const favs = () => new Set(lib.settings.wtvFavs || []);
const hideDead = () => lib.settings.wtvHideDead !== false;
// детски профил: само детски и семейни канали
const KIDS_CATS = ['Kids', 'Animation', 'Family', 'Education'];
const kidsOnly = () => !!(typeof curProfile === 'function' && curProfile().kids);

function wtvLoad(force) {
  if (W.loading) return;
  W.loading = true;
  if (force) toast('Тегля списъка с канали…');
  window.api.wtvList(!!force).then(d => {
    W.loading = false;
    for (const c of d.channels) c._n = norm(c.name + ' ' + (c.tvgId || '').split('.')[0]);
    W.data = d;
    W.byUrl = new Map(d.channels.map(c => [c.url, c]));
    window.api.wtvHealth().then(h => { W.health = h || {}; if (view.name === 'wtv') wtvUpdateGrid(); });
    if (d.error && !d.channels.length) toast('Не мога да изтегля списъка с канали: ' + d.error, 6000);
    else if (d.error && force) toast('Не мога да обновя списъка — показвам запазения.', 5000);
    else if (force) toast(`Списъкът е обновен: ${d.channels.length} канала.`);
    if (view.name === 'wtv') render();
  }).catch(e => { W.loading = false; toast('Грешка: ' + e.message); });
}

function wtvFilter() {
  const all = W.data ? W.data.channels : [];
  const q = norm(W.q), ql = latin(q), f = favs(), hd = hideDead(), kids = kidsOnly();
  W.deadHidden = 0;
  W.shown = all.filter(c => {
    if (W.country && c.country !== W.country) return false;
    if (W.cat && !c.groups.includes(W.cat)) return false;
    if (kids && !c.groups.some(g => KIDS_CATS.includes(g))) return false;
    if (W.favOnly && !f.has(c.url)) return false;
    if (q && !c._n.includes(q) && !c._n.includes(ql)) return false;
    if (hd && W.health[c.url] === false) { W.deadHidden++; return false; }
    return true;
  });
  if (q) {   // първо тези, които започват с търсеното
    const starts = (c) => c._n.startsWith(q) || c._n.startsWith(ql) ? 0 : 1;
    W.shown.sort((a, b) => starts(a) - starts(b));
  }
  return W.shown;
}

function wtvCard(c, i, f, attr = 'data-wtv-i') {
  const sub = [wtvCountry(c.country), c.groups.map(wtvCat).join(', ')].filter(Boolean).join(' · ');
  const badges = [c.quality, ...c.tags.map(t => /geo/i.test(t) ? '🌍 само в някои държави' : /24\/7/i.test(t) ? 'не денонощно' : t)].filter(Boolean);
  return `<div class="wtv-card${W.health[c.url] === false ? ' dead' : ''}" ${attr}="${i}" data-url="${esc(c.url)}" title="${esc(c.name)}">
    <div class="wtv-logo">${c.logo ? `<img src="${esc(c.logo)}" loading="lazy" referrerpolicy="no-referrer" data-fallback="hide">` : ''}<span>${esc(c.name.slice(0, 2).toUpperCase())}</span></div>
    <div class="wtv-meta"><div class="t">${esc(c.name)}</div><div class="s">${esc(sub)}</div>${badges.length ? `<div class="b">${badges.map(b => `<i>${esc(b)}</i>`).join('')}</div>` : ''}</div>
    ${attr === 'data-wtv-i' ? `<button class="wtv-star${f.has(c.url) ? ' on' : ''}" data-wtv-fav="${i}" title="Любим">${f.has(c.url) ? '★' : '☆'}</button>` : ''}
    <i class="wtv-dead">не работи</i>
  </div>`;
}
function wtvRecent() { return (lib.settings.wtvRecent || []).map(u => W.byUrl.get(u)).filter(c => c && (!kidsOnly() || c.groups.some(g => KIDS_CATS.includes(g)))); }
function wtvRecentHtml() {
  if (W.q || W.country || W.cat || W.favOnly) return '';
  const r = wtvRecent(); if (!r.length) return '';
  return `<h3 class="wtv-h">🕒 Наскоро гледани</h3><div class="wtv-row-recent">${r.map((c, i) => wtvCard(c, i, null, 'data-wtv-r')).join('')}</div>`;
}
// проверява на заден план показаните канали, които още не са проверени
async function wtvCheckVisible() {
  if (W.checking || view.name !== 'wtv' || !$('#wtv-grid')) return;
  W.checking = true;
  try {
    while (view.name === 'wtv') {
      const cards = [...document.querySelectorAll('#wtv-grid .wtv-card[data-url]')].map(el => el.dataset.url).filter(u => !(u in W.health));
      const batch = [...new Set(cards)].slice(0, 40).map(u => W.byUrl.get(u)).filter(Boolean);
      if (!batch.length) break;
      const r = await window.api.wtvCheck(batch.map(c => ({ url: c.url, ua: c.ua, referrer: c.referrer })));
      for (const c of batch) W.health[c.url] = r && c.url in r ? r[c.url] : true;
      for (const el of document.querySelectorAll('#wtv-grid .wtv-card[data-url]')) if (W.health[el.dataset.url] === false) el.classList.add('dead');
    }
  } catch {} finally { W.checking = false; }
}

function wtvGridHtml() {
  const list = wtvFilter(), f = favs();
  const dead = W.deadHidden ? ` · ${W.deadHidden} неработещи са скрити` : '';
  if (!list.length) return wtvRecentHtml() + `<div class="empty">${W.favOnly && !favs().size ? 'Нямаш любими канали още — натисни ☆ на някой канал.' : 'Няма канали с тези филтри.'}${dead}</div>`;
  const shown = list.slice(0, W.limit);
  setTimeout(wtvCheckVisible, 50);
  return wtvRecentHtml() + `<div class="wtv-count">${list.length} канала${list.length > shown.length ? ` · показани ${shown.length}` : ''}${dead}</div>
    <div class="wtv-grid">${shown.map((c, i) => wtvCard(c, i, f)).join('')}</div>
    ${list.length > shown.length ? '<div class="wtv-more"><button data-wtv-act="more">Покажи още</button></div>' : ''}`;
}
function wtvUpdateGrid() { const g = $('#wtv-grid'); if (g) g.innerHTML = wtvGridHtml(); }

function renderWtv() {
  if (!W.data) { wtvLoad(false); return '<h2>🌍 World TV</h2><div class="hint">Тегля списъка с каналите от iptv-org… (първия път може да отнеме няколко секунди)</div>'; }
  const all = W.data.channels;
  const count = (key) => { const m = new Map(); for (const c of all) for (const k of key(c)) m.set(k, (m.get(k) || 0) + 1); return m; };
  const countries = [...count(c => [c.country]).entries()].map(([k, n]) => ({ k, n, name: wtvCountry(k) }))
    .sort((a, b) => (b.k === 'BG') - (a.k === 'BG') || (!a.k) - (!b.k) || a.name.localeCompare(b.name, 'bg'));
  const cats = [...count(c => c.groups).entries()].map(([k, n]) => ({ k, n, name: wtvCat(k) })).sort((a, b) => a.name.localeCompare(b.name, 'bg'));
  const when = W.data.updated ? new Date(W.data.updated).toLocaleString('bg-BG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return `<div class="wtv"><h2>🌍 World TV <small>${all.length} канала от цял свят</small></h2>
    <div class="wtv-bar">
      <input id="wtv-q" type="search" placeholder="Търси канал по име…" value="${esc(W.q)}" autocomplete="off">
      <select id="wtv-country"><option value="">Всички държави</option>${countries.map(c => `<option value="${esc(c.k)}"${c.k === W.country ? ' selected' : ''}>${esc(c.name)} (${c.n})</option>`).join('')}</select>
      <select id="wtv-cat"><option value="">Всички категории</option>${cats.map(c => `<option value="${esc(c.k)}"${c.k === W.cat ? ' selected' : ''}>${esc(c.name)} (${c.n})</option>`).join('')}</select>
      <button id="wtv-favs" class="${W.favOnly ? 'on' : ''}" data-wtv-act="favs">★ Любими</button>
      <button class="${hideDead() ? 'on' : ''}" data-wtv-act="dead" title="Каналите се проверяват на заден план; неработещите (или спрени за България) се скриват за 24 часа">🚫 Скрий неработещите</button>
      <button data-wtv-act="reload" title="Изтегли списъка наново">⟳ Обнови</button>
    </div>
    <div class="hint">Публичен списък с безплатни канали (iptv-org), обновен ${esc(when)}. Каналите са от външни сървъри — някои може да не работят, да са спрени в България или да вървят само в определени часове.
      В плейъра: <b>Page Up / Page Down</b> — друг канал, <b>L</b> — списък с каналите, <b>F</b> — цял екран, <b>Esc</b> или <b>←</b> — смалява канала в ъгъла, за да разглеждаш менюто, без да спира.</div>
    <div id="wtv-grid">${wtvGridHtml()}</div></div>`;
}

// ---- събития в списъка ---------------------------------------------------
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'wtv-q') { W.q = ev.target.value; W.limit = 240; clearTimeout(W.qT); W.qT = setTimeout(wtvUpdateGrid, 120); }
  if (ev.target.id === 'wtv-pq') { W.pq = ev.target.value; wtvSideList(); }
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'wtv-country') { W.country = ev.target.value; W.limit = 240; wtvUpdateGrid(); }
  if (ev.target.id === 'wtv-cat') { W.cat = ev.target.value; W.limit = 240; wtvUpdateGrid(); }
});
async function wtvToggleFav(ch) {
  const f = favs();
  if (f.has(ch.url)) f.delete(ch.url); else f.add(ch.url);
  lib.settings = await window.api.setSettings({ wtvFavs: [...f] });
  return f.has(ch.url);
}
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-wtv-i],[data-wtv-fav],[data-wtv-act]');
  if (!t || !t.closest('#view')) return;
  const d = t.dataset;
  if (d.wtvFav !== undefined) { ev.stopPropagation(); await wtvToggleFav(W.shown[+d.wtvFav]); if (W.favOnly) return wtvUpdateGrid(); const on = favs().has(W.shown[+d.wtvFav].url); t.classList.toggle('on', on); t.textContent = on ? '★' : '☆'; return; }
  if (d.wtvAct === 'more') { W.limit += 480; return wtvUpdateGrid(); }
  if (d.wtvAct === 'favs') { W.favOnly = !W.favOnly; t.classList.toggle('on', W.favOnly); W.limit = 240; return wtvUpdateGrid(); }
  if (d.wtvAct === 'reload') return wtvLoad(true);
  if (d.wtvAct === 'dead') { lib.settings = await window.api.setSettings({ wtvHideDead: !hideDead() }); t.classList.toggle('on', hideDead()); return wtvUpdateGrid(); }
  if (d.wtvR !== undefined) { W.list = wtvRecent(); return wtvOpen(+d.wtvR); }
  if (d.wtvI !== undefined) { W.list = W.shown.slice(); return wtvOpen(+d.wtvI); }
});

// ---- плейър --------------------------------------------------------------
const wv = $('#wtv-video');
const wtvMsg = (html) => { const m = $('#wtv-msg'); m.innerHTML = html || ''; m.classList.toggle('hidden', !html); };
const wtvSpin = (on) => $('#wtv-spinner').classList.toggle('hidden', !on);

function wtvStopMedia() {
  clearTimeout(W.timer);
  if (W.hls) { try { W.hls.destroy(); } catch {} W.hls = null; }
  wv.pause(); wv.removeAttribute('src'); wv.load();
}

async function wtvOpen(i) {
  if (!W.list.length) return;
  i = (i + W.list.length) % W.list.length;
  const ch = W.list[i];
  W.cur = i; W.token++;
  const tok = W.token;
  $('#wtv-player').classList.remove('hidden', 'mini');
  $('#wtv-title').textContent = ch.name;
  $('#wtv-mini-title').textContent = ch.name;
  $('#wtv-sub').textContent = [wtvCountry(ch.country), ch.groups.map(wtvCat).join(', '), ch.quality].filter(Boolean).join(' · ');
  $('#wtv-fav').textContent = favs().has(ch.url) ? '★' : '☆';
  $('#wtv-logo').innerHTML = ch.logo ? `<img src="${esc(ch.logo)}" referrerpolicy="no-referrer" data-fallback="remove">` : '';
  wtvMsg(''); wtvSpin(true); wtvShowControls();
  wtvStopMedia();
  const r = await window.api.wtvPlay(ch);
  if (tok !== W.token) return;
  W.liveUrl = r && r.liveUrl;
  // ред на опитите: hls.js -> директно от браузъра -> през ffmpeg (като VLC)
  const isHls = /\.m3u8?(\?|#|$)/i.test(ch.url) || !/\.(mp4|webm|mkv|ts|mp3|aac)(\?|#|$)/i.test(ch.url);
  W.stages = [...(isHls && window.Hls && Hls.isSupported() ? ['hls'] : []), 'direct', ...(W.liveUrl ? ['ffmpeg'] : [])];
  W.stage = -1;
  wtvAdUI();
  wtvNextStage(tok);
  if (!$('#wtv-side').classList.contains('hidden')) wtvSideList();
  wtvEpgLoad(ch, tok);
}

// ---- програма (какво върви сега и после) ------------------------------------
const hm = (t) => new Date(t).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
async function wtvEpgLoad(ch, tok) {
  clearInterval(W.epgT);
  W.epg = null; wtvEpgUI();
  try { W.epg = await window.api.wtvEpg({ tvgId: ch.tvgId, name: ch.name, country: ch.country }); } catch {}
  if (tok !== W.token) return;
  wtvEpgUI();
  W.epgT = setInterval(wtvEpgUI, 30000);
}
function wtvEpgUI() {
  const el = $('#wtv-epg');
  const e = W.epg, now = Date.now();
  if (e) {   // минава на следващото предаване, когато текущото свърши
    const all = [e.now, ...(e.next || [])].filter(Boolean);
    const i = all.findIndex(p => p.stop > now);
    if (i > 0) { const rest = all.slice(i); e.now = rest[0].start <= now ? rest[0] : null; e.next = e.now ? rest.slice(1) : rest; }
  }
  if (!e || (!e.now && !(e.next || []).length)) { el.innerHTML = ''; el.classList.add('hidden'); $('#wtv-mini-title').title = ''; return; }
  const p = e.now, nx = (e.next || []).slice(0, 3);
  const pct = p ? Math.min(100, Math.max(0, (now - p.start) / (p.stop - p.start) * 100)) : 0;
  el.innerHTML = (p ? `<div class="now" title="${esc(p.desc || '')}"><b>Сега:</b> ${esc(p.title)} <span>${hm(p.start)}–${hm(p.stop)}</span><div class="epg-bar"><div style="width:${pct}%"></div></div></div>` : '') +
    (nx.length ? `<div class="next">${nx.map(x => `<span>${hm(x.start)} ${esc(x.title)}</span>`).join('')}</div>` : '');
  el.classList.remove('hidden');
  $('#wtv-mini-title').title = p ? 'Сега: ' + p.title : '';
}

function wtvNextStage(tok, why) {
  if (tok !== W.token) return;
  wtvStopMedia();
  W.stage++;
  const how = W.stages[W.stage];
  const ch = W.list[W.cur];
  if (!how) {
    wtvSpin(false);
    if (ch) { W.health[ch.url] = false; window.api.wtvMark({ url: ch.url, ok: false }); }
    return wtvMsg(`<b>Каналът не работи в момента.</b><div>${esc(why || 'Сървърът не отговаря или не позволява гледане оттук.')}</div>
      <div class="actions"><button class="primary" data-wtv-p="next">Следващ канал ⏭</button><button data-wtv-p="retry">Опитай пак</button></div>`);
  }
  wtvSpin(true);
  wtvMsg(how === 'ffmpeg' ? '<div>Пробвам през ffmpeg (по-бавно тръгва)…</div>' : '');
  W.timer = setTimeout(() => wtvNextStage(tok, 'Няма картина след дълго чакане.'), how === 'ffmpeg' ? 30000 : 15000);
  if (how === 'hls') {
    const hls = new Hls({ ...(wtvAdOn() ? { pLoader: adLoaderClass() } : {}), enableWorker: false, lowLatencyMode: false, backBufferLength: 30, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 3 });
    W.hls = hls;
    let recovered = false;
    hls.on(Hls.Events.MANIFEST_PARSED, () => { wv.play().catch(() => {}); });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal || W.hls !== hls) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; return hls.recoverMediaError(); }
      const code = data.response && data.response.code;
      // плейлистата изобщо не се отваря — пряко към ffmpeg няма смисъл само при 403/404
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && (code === 403 || code === 404 || code === 410) && /manifest/i.test(data.details)) {
        W.stage = W.stages.length - 1;
        return wtvNextStage(tok, code === 404 || code === 410 ? 'Потокът вече не съществува (грешка ' + code + ').' : 'Достъпът е отказан (403) — вероятно каналът е само за своята държава.');
      }
      wtvNextStage(tok, data.details);
    });
    hls.loadSource(ch.url);
    hls.attachMedia(wv);
  } else {
    wv.src = how === 'ffmpeg' ? W.liveUrl : ch.url;
    wv.play().catch(() => {});
  }
}

// ---- блокиране на рекламите ------------------------------------------------
// Много безплатни канали вмъкват реклами в самия поток (SSAI). Където потокът ги отбелязва
// (EXT-X-CUE-OUT/IN, SCTE-35) или идват от рекламни сървъри, сегментите се маркират като GAP —
// hls.js не ги тегли и не ги показва. Рекламите на живо не могат да се „превъртят“: каналът
// просто изчаква (без реклама) да продължи програмата.
const AD_URL = /(doubleclick\.net|googlesyndication|imasdk|dai\.google|fwmrm\.net|freewheel|springserve|innovid|tremorhub|spotx|adsrvr|unicornmedia|\/ads?\/|adbreak|ad_break|\/creatives?\/|[_\-/]ads?[_\-]\d|\/vast\/)/i;
function stripAds(text) {
  if (!text.includes('#EXTINF')) return { text, n: 0 };
  const out = [];
  let inAd = false, n = 0, block = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (/^#EXT-X-CUE-OUT(?!-CONT)/i.test(l) || (/^#EXT-X-DATERANGE/i.test(l) && /SCTE35-OUT/i.test(l)) || /^#EXT-X-SCTE35:.*CUE-OUT/i.test(l)) inAd = true;
    if (/^#EXT-X-CUE-OUT-CONT/i.test(l)) inAd = true;
    if (/^#EXT-X-CUE-IN/i.test(l) || (/^#EXT-X-DATERANGE/i.test(l) && /SCTE35-IN/i.test(l))) inAd = false;
    if (!l || l.startsWith('#')) { (block.length || l.startsWith('#EXTINF') || /^#EXT-X-(BYTERANGE|DISCONTINUITY|PROGRAM-DATE-TIME|KEY|MAP|GAP|BITRATE)/i.test(l) ? block : out).push(raw); continue; }
    // ред с адрес на сегмент
    if ((inAd || AD_URL.test(l)) && !block.some(b => /^#EXT-X-GAP/i.test(b))) { block.push('#EXT-X-GAP'); n++; }
    out.push(...block, raw); block = [];
  }
  out.push(...block);
  return { text: out.join('\n'), n };
}
function adLoaderClass() {
  const Base = Hls.DefaultConfig.loader;
  return class extends Base {
    load(context, config, callbacks) {
      const ok = callbacks.onSuccess;
      super.load(context, config, { ...callbacks, onSuccess: (resp, stats, ctx, net) => {
        if (typeof resp.data === 'string') {
          const r = stripAds(resp.data);
          if (r.n) { resp.data = r.text; wtvAdsSeen(r.n); }
        }
        ok(resp, stats, ctx, net);
      } });
    }
  };
}
const wtvAdOn = () => lib.settings.wtvAdblock !== false;
function wtvAdsSeen() {
  W.adNow = Date.now();
  const b = $('#wtv-ad'); b.classList.add('hit'); b.title = 'Блокирах реклами в този канал. Натисни, за да ги изключиш/включиш.';
}
function wtvAdUI() { const b = $('#wtv-ad'); b.textContent = wtvAdOn() ? '🛡 Без реклами' : '🛡 Реклами: да'; b.classList.toggle('off', !wtvAdOn()); b.classList.remove('hit'); }

wv.addEventListener('playing', () => {
  clearTimeout(W.timer); wtvSpin(false); wtvMsg(''); wtvUpdateUI();
  const ch = W.list[W.cur];
  if (ch && W.recentFor !== W.token) {
    W.recentFor = W.token;
    if (W.health[ch.url] !== true) { W.health[ch.url] = true; window.api.wtvMark({ url: ch.url, ok: true }); }
    const rec = [ch.url, ...(lib.settings.wtvRecent || []).filter(u => u !== ch.url)].slice(0, 20);
    window.api.setSettings({ wtvRecent: rec }).then(st => { lib.settings = st; });
  }
});
wv.addEventListener('waiting', () => wtvSpin(true));
wv.addEventListener('pause', wtvUpdateUI);
wv.addEventListener('volumechange', wtvUpdateUI);
wv.addEventListener('error', () => {
  if (W.hls || !wv.getAttribute('src')) return;   // при hls.js грешките идват от него
  wtvNextStage(W.token, 'Форматът не се поддържа.');
});

// смаляване в ъгъла: каналът продължава, докато разглеждаш менюто, и спира чак когато пуснеш нещо друго
function wtvMinimize() {
  if (isFs) window.api.fullscreen(false);
  $('#wtv-side').classList.add('hidden'); $('#wtv-pq').blur();
  $('#wtv-player').classList.add('mini');
  $('#wtv-player').classList.remove('idle');
  if (view.name === 'wtv') wtvUpdateGrid();
}
function wtvExpand() { $('#wtv-player').classList.remove('mini'); wtvShowControls(); }
const wtvActive = () => !$('#wtv-player').classList.contains('hidden');

function wtvClose() {
  clearInterval(W.epgT);
  $('#wtv-player').classList.remove('mini');
  W.token++;
  wtvStopMedia();
  window.api.wtvPlay(null);
  if (isFs) window.api.fullscreen(false);
  $('#wtv-player').classList.add('hidden');
  $('#wtv-side').classList.add('hidden');
  if (view.name === 'wtv') wtvUpdateGrid();
}

function wtvUpdateUI() {
  $('#wtv-play').textContent = wv.paused ? '▶' : '❚❚';
  $('#wtv-mute').textContent = $('#wtv-mute2').textContent = wv.muted || wv.volume === 0 ? '🔇' : '🔊';
  $('#wtv-vol').value = wv.muted ? 0 : wv.volume;
}

function wtvSideList() {
  const q = norm(W.pq || ''), ql = latin(q);
  const rows = [];
  W.list.forEach((c, i) => { if (!q || c._n.includes(q) || c._n.includes(ql)) rows.push(i); });
  const shown = q ? rows.slice(0, 400) : rows.slice(Math.max(0, W.cur - 150), Math.max(0, W.cur - 150) + 400);
  $('#wtv-side-list').innerHTML = shown.map(i => `<div class="wtv-row${i === W.cur ? ' cur' : ''}" data-wtv-p-i="${i}">${esc(W.list[i].name)}<small>${esc(wtvCountry(W.list[i].country))}</small></div>`).join('') ||
    '<div class="hint" style="padding:12px">Няма такъв канал.</div>';
  const cur = $('#wtv-side-list .cur'); if (cur && !q) cur.scrollIntoView({ block: 'center' });
}
function wtvToggleSide() {
  const s = $('#wtv-side');
  s.classList.toggle('hidden');
  if (s.classList.contains('hidden')) $('#wtv-pq').blur();
  else { W.pq = ''; $('#wtv-pq').value = ''; wtvSideList(); $('#wtv-pq').focus(); }
}

$('#wtv-player').addEventListener('click', async (ev) => {
  const t = ev.target.closest('button,[data-wtv-p-i]');
  if (!t) return;
  if (t.dataset.wtvPI !== undefined) return wtvOpen(+t.dataset.wtvPI);
  const a = t.dataset.wtvP || t.id;
  if (a === 'wtv-back') wtvMinimize();
  else if (a === 'wtv-close' || a === 'wtv-close2') wtvClose();
  else if (a === 'wtv-expand') wtvExpand();
  else if (a === 'wtv-ad') { lib.settings = await window.api.setSettings({ wtvAdblock: !wtvAdOn() }); toast(wtvAdOn() ? 'Блокирането на реклами е включено.' : 'Блокирането на реклами е изключено.'); wtvOpen(W.cur); }
  else if (a === 'wtv-mute2') { wv.muted = !wv.muted; if (!wv.muted && wv.volume === 0) wv.volume = 0.5; }
  else if (a === 'wtv-play') wv.paused ? wv.play().catch(() => {}) : wv.pause();
  else if (a === 'wtv-prev') wtvOpen(W.cur - 1);
  else if (a === 'wtv-next' || a === 'next') wtvOpen(W.cur + 1);
  else if (a === 'retry') wtvOpen(W.cur);
  else if (a === 'wtv-mute') { wv.muted = !wv.muted; if (!wv.muted && wv.volume === 0) wv.volume = 0.5; }
  else if (a === 'wtv-fs') window.api.fullscreen();
  else if (a === 'wtv-list') wtvToggleSide();
  else if (a === 'wtv-fav') { const on = await wtvToggleFav(W.list[W.cur]); t.textContent = on ? '★' : '☆'; toast(on ? 'Добавен в любими.' : 'Махнат от любими.'); }
});
$('#wtv-vol').addEventListener('input', (e) => { wv.volume = +e.target.value; wv.muted = wv.volume === 0; });
wv.addEventListener('dblclick', () => { if (!$('#wtv-player').classList.contains('mini')) window.api.fullscreen(); });
wv.addEventListener('click', () => {
  if ($('#wtv-player').classList.contains('mini')) return wtvExpand();
  wv.paused ? wv.play().catch(() => {}) : wv.pause();
});
// пускаш филм, сериал или радио — телевизията спира
$('#video').addEventListener('play', () => { if (wtvActive()) wtvClose(); });
{ const ra = $('#radio-audio'); if (ra) ra.addEventListener('play', () => { if (wtvActive()) wtvClose(); }); }

let wtvIdleT;
function wtvShowControls() {
  const p = $('#wtv-player');
  p.classList.remove('idle');
  clearTimeout(wtvIdleT);
  wtvIdleT = setTimeout(() => { if (!p.classList.contains('mini') && !wv.paused && $('#wtv-side').classList.contains('hidden')) p.classList.add('idle'); }, 2800);
}
$('#wtv-player').addEventListener('mousemove', wtvShowControls);

document.addEventListener('keydown', (e) => {
  if ($('#wtv-player').classList.contains('hidden') || $('#wtv-player').classList.contains('mini')) return;
  e.stopImmediatePropagation();
  if (e.target.id === 'wtv-pq' && !$('#wtv-side').classList.contains('hidden')) {
    if (e.key === 'Escape') wtvToggleSide();
    else if (e.key === 'Enter') { const first = $('#wtv-side-list [data-wtv-p-i]'); if (first) wtvOpen(+first.dataset.wtvPI); }
    else return;
    return e.preventDefault();
  }
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'k') wv.paused ? wv.play().catch(() => {}) : wv.pause();
  else if (k === 'pagedown' || k === 'n' || k === 'н') wtvOpen(W.cur + 1);
  else if (k === 'pageup' || k === 'p' || k === 'п') wtvOpen(W.cur - 1);
  else if (k === 'arrowup') { wv.volume = Math.min(1, wv.volume + 0.05); wv.muted = false; }
  else if (k === 'arrowdown') wv.volume = Math.max(0, wv.volume - 0.05);
  else if (k === 'f' || k === 'ф') window.api.fullscreen();
  else if (k === 'm' || k === 'м') wv.muted = !wv.muted;
  else if (k === 'l' || k === 'л') wtvToggleSide();
  else if (k === 'escape') { if (!$('#wtv-side').classList.contains('hidden')) wtvToggleSide(); else if (isFs) window.api.fullscreen(false); else wtvMinimize(); }
  else return;
  e.preventDefault(); wtvShowControls();
}, true);
