'use strict';
// =========================================================================
// БЕЗПЛАТНИ ЗАКОННИ УСЛУГИ С РЕКЛАМИ — Plex, Pluto TV, Tubi.
// Всяка услуга се държи като добавка на Stremio (catalog / meta / stream),
// но говори с официалните публични адреси, които ползват уеб плейърите им.
// Без вход, без DRM, без заобикаляне на държавни ограничения: ако услугата
// не дава съдържание за държавата, показваме това и линк към сайта ѝ.
// =========================================================================
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function req(url, { method = 'GET', headers = {}, ms = 20000, redirect = 'follow', json = true } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { method, redirect, signal: ctl.signal, headers: { 'User-Agent': UA, ...(json ? { Accept: 'application/json' } : {}), ...headers } });
    if (!json) return r;
    if (!r.ok) { const e = new Error('Сървърът върна грешка ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Услугата не отговаря.');
    throw e;
  } finally { clearTimeout(t); }
}
const arr = (x) => Array.isArray(x) ? x : x ? [x] : [];
const abs = (u, base) => !u ? '' : /^https?:\/\//i.test(u) ? u : base + u;
const tags = (x) => arr(x).map(t => t && (t.tag || t.title || t.name)).filter(Boolean);

// ---- PLEX ----------------------------------------------------------------
// Анонимен ключ от plex.tv (както „Гледай безплатно“ на watch.plex.tv),
// филми/сериали от vod.provider.plex.tv, телевизия от epg.provider.plex.tv.
const PLEX_VOD = 'https://vod.provider.plex.tv';
const PLEX_EPG = 'https://epg.provider.plex.tv';
const PLEX_DISCOVER = 'https://discover.provider.plex.tv';
const plex = {
  id: 'plex', name: 'Plex', site: 'https://watch.plex.tv/',
  logo: 'https://www.plex.tv/wp-content/themes/plex/assets/img/plex-logo.svg',
  st: { token: null, tokenAt: 0, genres: [], channels: null, channelsAt: 0, ok: null, err: '' },
  clientId: crypto.randomUUID(),
  hdr() {
    return { 'X-Plex-Product': 'Plex Mediaverse', 'X-Plex-Client-Identifier': this.clientId, 'X-Plex-Version': '1.0', 'X-Plex-Platform': 'Web',
      'X-Plex-Language': 'bg', ...(this.st.token ? { 'X-Plex-Token': this.st.token } : {}) };
  },
  async token(force) {
    if (this.st.token && !force && Date.now() - this.st.tokenAt < 12 * 3600e3) return this.st.token;
    const r = await req('https://plex.tv/api/v2/users/anonymous', { method: 'POST', headers: { ...this.hdr(), 'X-Plex-Token': '' } });
    if (!r || !r.authToken) throw new Error('Plex не даде достъп.');
    this.st.token = r.authToken; this.st.tokenAt = Date.now();
    return this.st.token;
  },
  async get(base, p, params = {}) {
    await this.token();
    const u = new URL(base + p);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
    try { return await req(u.toString(), { headers: this.hdr() }); } catch (e) {
      if (e.status !== 401) throw e;
      await this.token(true); return req(u.toString(), { headers: this.hdr() });
    }
  },
  img(u) {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    return `${PLEX_VOD}${u}${u.includes('?') ? '&' : '?'}X-Plex-Token=${encodeURIComponent(this.st.token || '')}`;
  },
  async init() {
    try {
      await this.token();
      if (!this.st.genres.length) {
        const r = await this.get(PLEX_VOD, '/library/sections/categories/all');
        const mc = (r && r.MediaContainer) || {};
        this.st.genres = arr(mc.Directory || mc.Metadata).map(d => {
          let g = ''; try { g = new URL(d.key, PLEX_VOD).searchParams.get('genre') || ''; } catch {}
          return { name: d.title, id: g || d.id || d.ratingKey || '' };
        }).filter(g => g.name && g.id);
      }
      this.st.ok = true; this.st.err = '';
    } catch (e) { this.st.ok = false; this.st.err = e.message; }
  },
  status() {
    if (this.st.ok === false) return 'Plex не отговаря в момента: ' + this.st.err;
    return 'Безплатни филми, сериали и канали на живо (с реклами). Работи в България.';
  },
  manifest() {
    const g = this.st.genres.map(x => x.name);
    const extra = [{ name: 'search' }, { name: 'skip' }, ...(g.length ? [{ name: 'genre', options: g }] : [])];
    return {
      id: 'kinoteka.plex', name: 'Plex', version: 'вградена', logo: this.logo,
      description: 'Безплатни законни филми, сериали и телевизия на живо от Plex. Без регистрация, с реклами.',
      resources: ['catalog', { name: 'meta', idPrefixes: ['plex:'] }, { name: 'stream', idPrefixes: ['plex:'] }],
      types: ['movie', 'series', 'tv'], idPrefixes: ['plex:'],
      catalogs: [
        { type: 'movie', id: 'plex-movies', name: 'Безплатни', extra },
        { type: 'series', id: 'plex-shows', name: 'Безплатни', extra },
        { type: 'tv', id: 'plex-live', name: 'На живо', extra: [{ name: 'search' }] }
      ]
    };
  },
  meta1(m) {
    const type = m.type === 'show' ? 'series' : m.type === 'episode' ? 'episode' : 'movie';
    const rk = m.ratingKey || (m.key ? String(m.key).split('/').filter(Boolean).pop() : '');
    return {
      id: 'plex:' + rk, type, name: m.title || '', poster: this.img(m.thumb || m.coverPoster), background: this.img(m.art),
      description: m.summary || m.tagline || '', releaseInfo: m.year ? String(m.year) : '',
      imdbRating: m.audienceRating ? Number(m.audienceRating).toFixed(1) : '',
      genres: tags(m.Genre), runtime: m.duration ? Math.round(m.duration / 60000) + ' мин' : '',
      cast: tags(m.Role), director: tags(m.Director)
    };
  },
  async channels() {
    if (this.st.channels && Date.now() - this.st.channelsAt < 3600e3) return this.st.channels;
    const r = await this.get(PLEX_EPG, '/lineups/plex/channels');
    const list = arr(r && r.MediaContainer && r.MediaContainer.Channel).filter(c => !c.hidden);
    this.st.channels = list.map(c => {
      const part = c.Media && c.Media[0] && c.Media[0].Part && c.Media[0].Part[0];
      return { id: 'plex:live:' + (c.id || c.slug), type: 'tv', name: c.title, poster: abs(c.thumb || c.coverPoster, PLEX_EPG), background: abs(c.art, PLEX_EPG),
        description: c.summary || 'Канал на живо в Plex', part: part && part.key, drm: c.Media && c.Media[0] && c.Media[0].drm };
    }).filter(c => c.part && !c.drm);
    this.st.channelsAt = Date.now();
    return this.st.channels;
  },
  async handle(resource, type, id, extra) {
    if (resource === 'catalog') {
      if (id === 'plex-live') {
        let ch = await this.channels();
        if (extra.search) { const q = extra.search.toLowerCase(); ch = ch.filter(c => c.name.toLowerCase().includes(q)); }
        return { metas: ch.map(({ part, drm, ...c }) => c) };
      }
      const t = type === 'series' ? 'show' : 'movie';
      if (extra.search) {
        await this.token();
        const r = await this.get(PLEX_DISCOVER, '/library/search', { query: extra.search, searchTypes: t === 'show' ? 'tv' : 'movies', searchProviders: 'plexAVOD', limit: 40, includeMetadata: 1 });
        const groups = arr(r && r.MediaContainer && r.MediaContainer.SearchResults);
        const hits = groups.filter(g => g.id === 'plex' || /vod/i.test(g.provider || g.source || '')).flatMap(g => arr(g.SearchResult)).map(x => x.Metadata || x).filter(m => m && m.type === t);
        return { metas: hits.map(m => this.meta1(m)) };
      }
      const g = extra.genre && this.st.genres.find(x => x.name === extra.genre);
      const r = await this.get(PLEX_VOD, '/library/sections/movies/all', { type: t === 'show' ? 2 : 1, availabilityType: 'free', sort: 'ratingCount:desc',
        genre: g ? g.id : '', 'X-Plex-Container-Start': extra.skip || 0, 'X-Plex-Container-Size': 60 });
      return { metas: arr(r && r.MediaContainer && r.MediaContainer.Metadata).filter(m => m.type === t).map(m => this.meta1(m)) };
    }
    const key = String(id).replace(/^plex:/, '');
    if (key.startsWith('live:')) {
      const c = (await this.channels()).find(x => x.id === id);
      if (!c) return resource === 'meta' ? { meta: null } : { streams: [] };
      if (resource === 'meta') { const { part, drm, ...m } = c; return { meta: m }; }
      if (resource === 'stream') return { streams: [{ name: 'Plex · на живо', title: c.name, url: `${PLEX_EPG}${c.part}?X-Plex-Token=${encodeURIComponent(this.st.token)}` }] };
      return {};
    }
    if (resource === 'meta') {
      const r = await this.get(PLEX_VOD, `/library/metadata/${encodeURIComponent(key)}`);
      const m = arr(r && r.MediaContainer && r.MediaContainer.Metadata)[0];
      if (!m) return { meta: null };
      const meta = this.meta1(m);
      if (m.type === 'show') {
        const seasons = arr((await this.get(PLEX_VOD, `/library/metadata/${encodeURIComponent(key)}/children`)).MediaContainer.Metadata);
        const eps = await Promise.all(seasons.map(async s => {
          try {
            const er = await this.get(PLEX_VOD, `/library/metadata/${encodeURIComponent(s.ratingKey)}/children`, { 'X-Plex-Container-Size': 300 });
            return arr(er.MediaContainer.Metadata).map(e => ({ id: 'plex:' + e.ratingKey, title: e.title || '', season: e.parentIndex ?? s.index ?? 0, episode: e.index,
              released: e.originallyAvailableAt || '', thumbnail: this.img(e.thumb), overview: e.summary || '' }));
          } catch { return []; }
        }));
        meta.videos = eps.flat();
        meta.type = 'series';
      }
      return { meta };
    }
    if (resource === 'stream') {
      const r = await this.get(PLEX_VOD, `/library/metadata/${encodeURIComponent(key)}`);
      const m = arr(r && r.MediaContainer && r.MediaContainer.Metadata)[0];
      const media = arr(m && m.Media).filter(x => !x.drm);
      const hls = media.filter(x => x.protocol === 'hls' && x.Part && x.Part[0] && x.Part[0].key);
      const streams = hls.map(x => ({ name: 'Plex · безплатно', title: [x.videoResolution ? x.videoResolution + 'p' : '', 'с реклами'].filter(Boolean).join(' · '),
        url: `${PLEX_VOD}${x.Part[0].key}?X-Plex-Token=${encodeURIComponent(this.st.token)}` }));
      if (!streams.length && m) streams.push({ name: 'Plex', title: 'Отвори в сайта на Plex', externalUrl: `https://watch.plex.tv/${m.type === 'episode' ? 'show' : m.type}/${m.slug || ''}` });
      return { streams };
    }
    return {};
  }
};

// ---- PLUTO TV ------------------------------------------------------------
// boot.pluto.tv дава сесия според държавата. За България в момента
// каталогът е празен — тогава само казваме това. Ако Pluto TV започне да
// показва канали тук (или си в държава, където работи), всичко се включва само.
const pluto = {
  id: 'pluto', name: 'Pluto TV', site: 'https://pluto.tv/',
  logo: 'https://images.pluto.tv/assets/images/default/pluto-tv-logo.png',
  st: { boot: null, bootAt: 0, channels: [], cats: [], vod: [], ok: null, empty: false, err: '' },
  clientId: crypto.randomUUID(),
  async boot(force) {
    if (this.st.boot && !force && Date.now() - this.st.bootAt < 4 * 3600e3) return this.st.boot;
    const u = new URL('https://boot.pluto.tv/v4/start');
    Object.entries({ appName: 'web', appVersion: '9.0.0', deviceVersion: '120.0.0', deviceModel: 'web', deviceMake: 'chrome', deviceType: 'web',
      clientID: this.clientId, clientModelNumber: '1.0.0', serverSideAds: 'false', drmCapabilities: '' }).forEach(([k, v]) => u.searchParams.set(k, v));
    const b = await req(u.toString());
    if (!b || !b.sessionToken) throw new Error('Pluto TV не даде сесия.');
    this.st.boot = b; this.st.bootAt = Date.now();
    return b;
  },
  async api(base, p) {
    const b = await this.boot();
    return req(base + p, { headers: { Authorization: 'Bearer ' + b.sessionToken } });
  },
  img(images, kinds) {
    for (const k of kinds) { const i = arr(images).find(x => x && x.type === k && x.url); if (i) return i.url; }
    return '';
  },
  async init() {
    try {
      const b = await this.boot(true);
      const ch = await this.api('https://service-channels.clusters.pluto.tv', '/v2/guide/channels?channelIds=&offset=0&limit=1000&sort=number:asc');
      const cats = await this.api('https://service-channels.clusters.pluto.tv', '/v2/guide/categories').catch(() => ({ data: [] }));
      const catName = new Map(arr(cats.data).map(c => [c.id, c.name]));
      this.st.channels = arr(ch.data).map(c => ({ id: 'pluto:ch:' + c.id, type: 'tv', name: c.name, number: c.number,
        poster: this.img(c.images, ['colorLogoPNG', 'logo', 'featuredImage']), background: this.img(c.images, ['featuredImage']),
        description: c.summary || 'Канал на живо в Pluto TV', genre: catName.get(c.categoryID) || '' }));
      this.st.cats = [...new Set(this.st.channels.map(c => c.genre).filter(Boolean))];
      const v = await this.api('https://service-vod.clusters.pluto.tv', '/v4/vod/categories?includeItems=true&offset=1000&page=1').catch(() => ({ categories: [] }));
      this.st.vod = arr(v.categories).map(c => ({ name: c.name, items: arr(c.items) }));
      this.st.empty = !this.st.channels.length && !this.st.vod.some(c => c.items.length);
      this.st.country = (b.session && b.session.countryCode) || '';
      this.st.ok = true; this.st.err = '';
    } catch (e) { this.st.ok = false; this.st.err = e.message; }
  },
  status() {
    if (this.st.ok === false) return 'Pluto TV не отговаря в момента: ' + this.st.err;
    if (this.st.empty) return `Pluto TV не предлага съдържание за ${this.st.country === 'BG' ? 'България' : 'твоята държава'} в момента. Програмата проверява при всяко пускане и ще се включи сама, щом го пуснат.`;
    if (this.st.ok) return `${this.st.channels.length} канала на живо и филми при поискване (с реклами).`;
    return '';
  },
  manifest() {
    const cats = this.st.empty || !this.st.ok ? [] : [
      ...(this.st.channels.length ? [{ type: 'tv', id: 'pluto-live', name: 'На живо', extra: [{ name: 'search' }, ...(this.st.cats.length ? [{ name: 'genre', options: this.st.cats }] : [])] }] : []),
      ...(this.st.vod.length ? [{ type: 'movie', id: 'pluto-vod', name: 'При поискване', extra: [{ name: 'search' }, { name: 'genre', options: this.st.vod.map(c => c.name) }] },
        { type: 'series', id: 'pluto-series', name: 'При поискване', extra: [{ name: 'search' }, { name: 'genre', options: this.st.vod.map(c => c.name) }] }] : [])
    ];
    return {
      id: 'kinoteka.pluto', name: 'Pluto TV', version: 'вградена', logo: this.logo,
      description: 'Безплатни законни канали на живо и филми от Pluto TV, с реклами.',
      resources: ['catalog', { name: 'meta', idPrefixes: ['pluto:'] }, { name: 'stream', idPrefixes: ['pluto:'] }],
      types: ['movie', 'series', 'tv'], idPrefixes: ['pluto:'], catalogs: cats
    };
  },
  vodMeta(i) {
    const type = i.type === 'series' ? 'series' : 'movie';
    return { id: `pluto:${type === 'series' ? 'se' : 'ep'}:${i._id || i.id}`, type, name: i.name || '', poster: this.img(i.covers, ['poster', 'screenshot16_9']) || (arr(i.covers)[0] || {}).url || '',
      description: i.description || i.summary || '', releaseInfo: '', genres: i.genre ? [i.genre] : [], runtime: i.duration ? Math.round(i.duration / 60000) + ' мин' : '' };
  },
  stitch(kind, id) {
    const b = this.st.boot;
    return `${b.servers.stitcher}/v2/stitch/hls/${kind}/${encodeURIComponent(id)}/master.m3u8?${b.stitcherParams}&jwt=${encodeURIComponent(b.sessionToken)}&masterJWTPassthrough=true`;
  },
  async handle(resource, type, id, extra) {
    if (resource === 'catalog') {
      const q = (extra.search || '').toLowerCase();
      if (id === 'pluto-live') {
        let ch = this.st.channels;
        if (extra.genre) ch = ch.filter(c => c.genre === extra.genre);
        if (q) ch = ch.filter(c => c.name.toLowerCase().includes(q));
        return { metas: ch };
      }
      const want = id === 'pluto-series' ? 'series' : 'movie';
      const seen = new Set();
      let items = this.st.vod.filter(c => !extra.genre || c.name === extra.genre).flatMap(c => c.items).filter(i => (i.type === 'series' ? 'series' : 'movie') === want);
      items = items.filter(i => !seen.has(i._id) && seen.add(i._id));
      if (q) items = items.filter(i => (i.name || '').toLowerCase().includes(q));
      return { metas: items.map(i => this.vodMeta(i)) };
    }
    const [, kind, pid] = String(id).split(':');
    if (kind === 'ch') {
      const c = this.st.channels.find(x => x.id === id);
      if (resource === 'meta') return { meta: c || null };
      if (resource === 'stream') { await this.boot(); return { streams: [{ name: 'Pluto TV · на живо', title: c ? c.name : '', url: this.stitch('channel', pid) }] }; }
    }
    if (kind === 'ep') {
      if (resource === 'meta') {
        const r = await this.api('https://service-vod.clusters.pluto.tv', `/v4/vod/items?ids=${encodeURIComponent(pid)}`);
        const i = arr(r)[0] || arr(r && r.data)[0];
        return { meta: i ? this.vodMeta(i) : null };
      }
      if (resource === 'stream') { await this.boot(); return { streams: [{ name: 'Pluto TV', title: 'с реклами', url: this.stitch('episode', pid) }] }; }
    }
    if (kind === 'se' && resource === 'meta') {
      const r = await this.api('https://service-vod.clusters.pluto.tv', `/v4/vod/series/${encodeURIComponent(pid)}/seasons?offset=1000&page=1`);
      const meta = this.vodMeta({ ...r, type: 'series', _id: pid });
      meta.videos = arr(r.seasons).flatMap(s => arr(s.episodes).map(e => ({ id: 'pluto:ep:' + (e._id || e.id), title: e.name || '', season: s.number, episode: e.number,
        thumbnail: this.img(e.covers, ['screenshot16_9', 'screenshot4_3']), overview: e.description || '' })));
      return { meta };
    }
    return resource === 'stream' ? { streams: [] } : {};
  }
};

// ---- TUBI ----------------------------------------------------------------
// Tubi сам е спрял услугата за Европа (пренасочва към gdpr.tubi.tv).
// Няма публичен начин за каталог без техния сайт, затова само проверяваме
// дали сайтът работи от тук и даваме линк към него.
const tubi = {
  id: 'tubi', name: 'Tubi', site: 'https://tubitv.com/',
  logo: 'https://tubitv.com/favicon.ico',
  st: { ok: null, blocked: false, err: '' },
  async init() {
    try {
      const r = await req('https://tubitv.com/', { json: false, redirect: 'manual', ms: 12000 });
      const loc = r.headers.get('location') || '';
      this.st.blocked = /gdpr/i.test(loc) || r.status === 451;
      this.st.ok = true; this.st.err = '';
    } catch (e) { this.st.ok = false; this.st.err = e.message; }
  },
  status() {
    if (this.st.blocked) return 'Tubi не работи в Европа — самите те са спрели услугата за ЕС. Програмата проверява при всяко пускане.';
    if (this.st.ok === false) return 'Tubi не отговаря: ' + this.st.err;
    if (this.st.ok) return 'Сайтът на Tubi работи от тук — отвори го с бутона „↗ Сайт“.';
    return '';
  },
  manifest() {
    return { id: 'kinoteka.tubi', name: 'Tubi', version: 'вградена', logo: this.logo,
      description: 'Безплатни законни филми и сериали с реклами (САЩ, Канада, Великобритания и др.).', resources: [], types: [], catalogs: [] };
  },
  async handle() { return {}; }
};

const providers = [plex, pluto, tubi];
let initP = null, initAt = 0;
// проверява наличността на услугите (веднъж на няколко часа или при „Обнови“)
function init(force) {
  if (!initP || force || Date.now() - initAt > 4 * 3600e3) {
    initAt = Date.now();
    initP = Promise.all(providers.map(p => Promise.race([p.init(), new Promise(r => setTimeout(r, 15000))])));
  }
  return initP;
}

module.exports = { providers, init, plex, pluto, tubi };
