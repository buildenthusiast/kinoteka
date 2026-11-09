'use strict';
// По желание: постери и описания на български от TMDB (нужен е безплатен API ключ).
const https = require('https');
const fs = require('fs');

function get(url, key, binary = false) {
  return new Promise((resolve, reject) => {
    const headers = { 'Accept': 'application/json' };
    if (key && key.length > 40) headers.Authorization = 'Bearer ' + key; // v4 "Read Access Token"
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(get(res.headers.location, key, binary)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        if (binary) return resolve(buf);
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const GENRES = { 28: 'Екшън', 12: 'Приключенски', 16: 'Анимация', 35: 'Комедия', 80: 'Криминален', 99: 'Документален', 18: 'Драма',
  10751: 'Семеен', 14: 'Фентъзи', 36: 'Исторически', 27: 'Ужаси', 10402: 'Музикален', 9648: 'Мистерия', 10749: 'Романтичен',
  878: 'Фантастика', 10770: 'ТВ филм', 53: 'Трилър', 10752: 'Военен', 37: 'Уестърн', 10759: 'Екшън', 10762: 'Детски',
  10763: 'Новини', 10764: 'Риалити', 10765: 'Фантастика', 10766: 'Сапунка', 10767: 'Токшоу', 10768: 'Военен' };

async function lookup(key, kind, title, year) {
  if (!key) return null;
  const type = kind === 'series' ? 'tv' : 'movie';
  const q = new URLSearchParams({ query: title, language: 'bg-BG', include_adult: 'false' });
  if (key.length <= 40) q.set('api_key', key);
  if (year) q.set(type === 'tv' ? 'first_air_date_year' : 'year', String(year));
  let j = await get(`https://api.themoviedb.org/3/search/${type}?${q}`, key);
  if ((!j.results || !j.results.length) && year) { q.delete(type === 'tv' ? 'first_air_date_year' : 'year'); j = await get(`https://api.themoviedb.org/3/search/${type}?${q}`, key); }
  const r = j.results && j.results[0];
  if (!r) return null;
  let overview = r.overview;
  if (!overview) {
    // няма български превод на описанието → английски
    const q2 = new URLSearchParams({ language: 'en-US' }); if (key.length <= 40) q2.set('api_key', key);
    try { overview = (await get(`https://api.themoviedb.org/3/${type}/${r.id}?${q2}`, key)).overview; } catch {}
  }
  return {
    tmdbId: r.id,
    genres: [...new Set((r.genre_ids || []).map(g => GENRES[g]).filter(Boolean))],
    titleBg: r.title || r.name,
    overview: overview || '',
    rating: r.vote_average || null,
    year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4), 10) || null,
    posterPath: r.poster_path, backdropPath: r.backdrop_path
  };
}

async function download(pathPart, size, out) {
  const buf = await get(`https://image.tmdb.org/t/p/${size}${pathPart}`, null, true);
  fs.writeFileSync(out, buf);
  return out;
}

module.exports = { lookup, download };
