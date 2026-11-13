// node tools/test-freetv.js  -> проверява Plex / Pluto TV / Tubi от този компютър (само четене)
const ft = require('../lib/freetv');
const head = async (u) => { try { const r = await fetch(u); const t = await r.text(); return r.status + ' ' + t.split('\n').slice(0, 4).join(' | ').slice(0, 200); } catch (e) { return 'ГРЕШКА ' + e.message; } };
(async () => {
  await ft.init(true);
  for (const p of ft.providers) { const m = p.manifest(); console.log(`\n== ${p.name}: ${p.status()}\n   каталози: ${m.catalogs.map(c => c.type + '/' + c.id + (c.extra || []).filter(e => e.options).map(e => ' [' + e.options.length + ' жанра: ' + e.options.slice(0, 6).join(', ') + ']').join('')).join(', ') || 'няма'}`); }
  const P = ft.plex;
  const run = async (label, f) => { try { const r = await f(); console.log('\n-- ' + label + ':', r); return r; } catch (e) { console.log('\n-- ' + label + ': ГРЕШКА', e.message); } };
  const mv = await run('Plex филми', async () => (await P.handle('catalog', 'movie', 'plex-movies', {})).metas.slice(0, 3).map(m => [m.id, m.name, m.releaseInfo, m.poster.slice(0, 60)]));
  await run('Plex филми, страница 2', async () => (await P.handle('catalog', 'movie', 'plex-movies', { skip: 60 })).metas.slice(0, 2).map(m => m.name));
  if (P.st.genres[1]) await run('Plex жанр ' + P.st.genres[1].name, async () => (await P.handle('catalog', 'movie', 'plex-movies', { genre: P.st.genres[1].name })).metas.slice(0, 3).map(m => m.name));
  const sh = await run('Plex сериали', async () => { const r = (await P.handle('catalog', 'series', 'plex-shows', {})).metas; return [r.length, r.slice(0, 3).map(m => [m.id, m.name])]; });
  await run('Plex търсене филми "love"', async () => (await P.handle('catalog', 'movie', 'plex-movies', { search: 'love' })).metas.slice(0, 4).map(m => [m.id, m.name]));
  await run('Plex търсене сериали "star"', async () => (await P.handle('catalog', 'series', 'plex-shows', { search: 'star' })).metas.slice(0, 4).map(m => [m.id, m.name]));
  const lv = await run('Plex на живо', async () => { const r = (await P.handle('catalog', 'tv', 'plex-live', {})).metas; return [r.length, r.slice(0, 3).map(m => [m.id, m.name, m.poster.slice(0, 60)])]; });
  if (mv && mv[0]) {
    await run('Plex meta филм', async () => { const m = (await P.handle('meta', 'movie', mv[0][0], {})).meta; return [m.name, m.genres, m.runtime, m.description.slice(0, 80)]; });
    const s = await run('Plex поток филм', async () => (await P.handle('stream', 'movie', mv[0][0], {})).streams);
    if (s && s[0] && s[0].url) console.log('   m3u8:', await head(s[0].url));
  }
  const sid = sh && sh[1] && sh[1][0] && sh[1][0][0];
  if (sid) {
    const m = await run('Plex meta сериал', async () => { const m = (await P.handle('meta', 'series', sid, {})).meta; return { name: m.name, type: m.type, eps: (m.videos || []).length, first: (m.videos || [])[0] }; });
    if (m && m.first) { const s = await run('Plex поток епизод', async () => (await P.handle('stream', 'series', m.first.id, {})).streams); if (s && s[0] && s[0].url) console.log('   m3u8:', await head(s[0].url)); }
  }
  if (lv && lv[1][0]) { const s = await run('Plex поток на живо', async () => (await P.handle('stream', 'tv', lv[1][0][0], {})).streams); if (s && s[0]) console.log('   m3u8:', await head(s[0].url)); }
  console.log('\nГОТОВО');
})();
