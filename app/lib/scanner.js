'use strict';
// Обхожда папки, разпознава филми и епизоди по имената на файловете и папките.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.flv', '.ogv', '.3gp', '.divx', '.vob']);
const SUB_EXT = new Set(['.srt', '.vtt', '.sub', '.ass', '.ssa']);
const IMG_NAMES = ['poster', 'folder', 'cover', 'movie', 'show'];
const MIN_SIZE = (parseFloat(process.env.KINOTEKA_MIN_MB) || 10) * 1024 * 1024;
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

// Думи, след които започва "боклукът" в името (качество, източник, кодек…)
const JUNK = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?|hdr|dv|dolby ?vision|bluray|blu-ray|bdrip|brrip|bdremux|remux|web-?dl|web-?rip|webrip|web|hdtv|hdrip|dvdrip|dvdscr|dvd|xvid|divx|x264|x265|h\.?264|h\.?265|hevc|avc|aac\d?|ac3|eac3|dts(-hd)?|truehd|atmos|ddp?\d\.\d|10bit|8bit|proper|repack|extended|unrated|remastered|imax|multi|dual|subs?|bgaudio|bg ?audio|bgsub|bulgarian|limited|internal|amzn|nf|dsnp|hmax|hulu|atvp)\b/i;

function idFor(p) {
  return crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 16);
}

function clean(s) {
  return s
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cutJunk(s) {
  const m = s.match(JUNK);
  if (m) s = s.slice(0, m.index);
  return s.replace(/[\s\-(]+$/, '').trim();
}

const EP_PATTERNS = [
  /^(.*?)[\s._\-\[(]*s(\d{1,2})[\s._\-]*e(\d{1,3})(?:-?e(\d{1,3}))?(.*)$/i, // S01E02, S01E02E03, S01E02-E03
  /^(.*?)[\s._\-\[(]+(\d{1,2})x(\d{2,3})(.*)$/i,                                   // 1x02
  /^(.*?)[\s._\-]*season[\s._\-]*(\d{1,2})[\s._\-]*episode[\s._\-]*(\d{1,3})(.*)$/i, // Season 1 Episode 2
  /^(.*?)[\s._\-]*сезон[\s._\-]*(\d{1,2})[\s._\-]*(?:епизод|еп)[\s._\-]*(\d{1,3})(.*)$/i
];

function parseYear(s) {
  // взимаме последната година (за "Blade Runner 2049 (2017)" → 2017)
  const re = /(?:^|[\s.(\[_-])((?:19|20)\d{2})(?=$|[\s.)\]_-])/g;
  let m, last = null;
  while ((m = re.exec(s))) { if (m.index > 0) last = { year: +m[1], index: m.index }; }
  return last;
}

function seasonFromDir(dir) {
  const m = dir.match(/^(?:season|series|s|сезон)[\s._\-]*(\d{1,2})\b/i) || dir.match(/\b(?:season|сезон)[\s._\-]*(\d{1,2})\b/i);
  return m ? +m[1] : null;
}

// Разбира едно име на файл. relDirs — папките между корена и файла.
function parseFile(filePath, rootDir) {
  const base = path.basename(filePath, path.extname(filePath));
  const rel = path.relative(rootDir, path.dirname(filePath));
  const dirs = rel && rel !== '.' ? rel.split(path.sep) : [];

  for (const re of EP_PATTERNS) {
    const m = base.match(re);
    if (!m) continue;
    let show = cutJunk(clean(m[1]));
    const season = +m[2];
    const episode = +m[3];
    let epTitle = '';
    const rest = re === EP_PATTERNS[0] ? m[5] : m[4];
    if (rest) epTitle = cutJunk(clean(rest)).replace(/^[-\s]+/, '');
    let year = null;
    const y = parseYear(show);
    if (y) { year = y.year; show = show.replace(/[\s(]*(19|20)\d{2}\)?\s*$/, '').trim(); }
    // Ако в името няма сериал (напр. "S01E02.mkv"), взимаме го от папките
    if (!show) {
      const candidates = dirs.filter(d => seasonFromDir(d) === null);
      show = candidates.length ? cutJunk(clean(candidates[candidates.length - 1])) : 'Неизвестен сериал';
      const y2 = parseYear(show);
      if (y2) { year = y2.year; show = show.slice(0, y2.index).trim(); }
    }
    return { kind: 'episode', show, year, season, episode, episodeEnd: m[4] && re === EP_PATTERNS[0] ? +m[4] : null, epTitle };
  }

  // Файл в папка "Season N" без SxxEyy → епизод по номер в името
  const parentSeason = dirs.length ? seasonFromDir(dirs[dirs.length - 1]) : null;
  if (parentSeason !== null) {
    const num = base.match(/(?:^|\D)(\d{1,3})(?:\D|$)/);
    const showDir = dirs.slice(0, -1).filter(d => seasonFromDir(d) === null).pop();
    let show = showDir ? cutJunk(clean(showDir)) : 'Неизвестен сериал';
    let year = null;
    const y = parseYear(show);
    if (y) { year = y.year; show = show.slice(0, y.index).trim(); }
    return { kind: 'episode', show, year, season: parentSeason, episode: num ? +num[1] : 0, epTitle: '' };
  }

  // Филм
  let name = clean(base);
  let year = null;
  const y = parseYear(name);
  if (y && y.index > 0) { year = y.year; name = name.slice(0, y.index); }
  name = cutJunk(name).replace(/[\s(\-]+$/, '').trim();
  // Имена като "movie.mkv" или "video1" — по-добре е името на папката
  if ((!name || /^(movie|film|video|филм)\s*\d*$/i.test(name)) && dirs.length) {
    const d = clean(dirs[dirs.length - 1]);
    const y2 = parseYear(d);
    if (y2 && y2.index > 0) { year = y2.year; name = d.slice(0, y2.index); } else name = d;
    name = cutJunk(name);
  }
  return { kind: 'movie', title: name || base, year };
}

function normKey(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\bthe\b/g, '').replace(/\s+/g, ' ').trim();
}

function walk(dir, out, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(sample|samples|extras|featurettes|trailers?|behind the scenes)$/i.test(e.name)) continue;
      walk(full, out, depth + 1);
    } else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      if (/\bsample\b/i.test(e.name)) continue;
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
      if (size && size < MIN_SIZE) continue; // прескачаме трейлъри/семпли
      out.push({ path: full, size, mtime });
    }
  }
}

function findLocalImage(dir, baseName, onlyBase = false) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  const lower = new Map(files.map(f => [f.toLowerCase(), f]));
  const own = baseName ? [baseName.toLowerCase(), baseName.toLowerCase() + '-poster'] : [];
  const names = onlyBase ? own : [...own, ...IMG_NAMES];
  for (const n of names) for (const ext of IMG_EXT) {
    const f = lower.get(n + ext);
    if (f) return path.join(dir, f);
  }
  return null;
}

function findExternalSubs(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const out = [];
  const scan = (d, requirePrefix) => {
    let files; try { files = fs.readdirSync(d); } catch { return; }
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (!SUB_EXT.has(ext) || ext === '.sub') continue;
      const fl = f.toLowerCase();
      if (requirePrefix && !fl.startsWith(base)) continue;
      const tag = fl.slice(base.length, -ext.length).replace(/^[._\-\s]+/, '');
      out.push({ path: path.join(d, f), label: tag || f, lang: /\b(bg|bul|bulgarian|бг)\b/i.test(fl) ? 'bg' : '' });
    }
  };
  scan(dir, true);
  for (const sd of ['Subs', 'Subtitles', 'subs', 'subtitles']) scan(path.join(dir, sd), false);
  return out;
}

// Външни аудио пътечки до видеото: "<име>.bg-ai.m4a", "<име>.bg.mka" и т.н.
const AUDIO_EXT = new Set(['.m4a', '.mka', '.aac', '.mp3', '.ac3', '.eac3', '.opus', '.flac', '.wav']);
function findExternalAudio(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  let files; try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const fl = f.toLowerCase();
    if (!AUDIO_EXT.has(ext) || !fl.startsWith(base + '.')) continue;
    const tag = fl.slice(base.length + 1, -ext.length);
    const ai = /(^|[._-])ai([._-]|$)/.test(tag);
    const bg = /(^|[._-])(bg|bul|бг)([._-]|$)/.test(tag);
    out.push({ path: path.join(dir, f), codec: ext.slice(1), lang: bg ? 'bul' : '', title: ai ? (bg ? 'БГ (AI войсоувър)' : 'AI аудио') : (tag || 'Външно аудио'), external: true, ai });
  }
  return out;
}

// Сливане на един и същ сериал с различно изписване в отделни сезони
// ("House" и "House M D"): по-дългото име започва с по-краткото и са в една и съща папка.
function mergeVariants(map) {
  const list = [...map.values()].sort((a, b) => a.key.length - b.key.length);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!map.has(a.key)) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (!map.has(b.key) || !b.key.startsWith(a.key + ' ')) continue;
      if (![...b.tops].some(t => a.tops.has(t))) continue;
      for (const e of b.episodes) { e.seriesId = a.id; a.episodes.push(e); }
      for (const d of b.dirs) a.dirs.add(d);
      for (const t of b.tops) a.tops.add(t);
      a.mtime = Math.max(a.mtime, b.mtime);
      if (!a.year) a.year = b.year;
      map.delete(b.key);
    }
  }
}

// Сканира всички коренни папки и връща { movies, series }
function scanLibrary(roots) {
  const movies = [];
  const seriesMap = new Map();
  for (const root of roots) {
    const files = [];
    walk(root, files);
    for (const f of files) {
      const info = parseFile(f.path, root);
      const dir = path.dirname(f.path);
      if (info.kind === 'movie') {
        // Локален постер: само ако е в собствена папка или е със същото име
        const base = path.basename(f.path, path.extname(f.path));
        const ownDir = path.resolve(dir) !== path.resolve(root);
        // в собствена папка: всеки poster/folder.jpg; в общата папка: само <име>.jpg
        const poster = ownDir ? findLocalImage(dir, base) : findLocalImage(dir, base, true);
        movies.push({
          id: idFor(f.path), type: 'movie', title: info.title, year: info.year,
          file: f.path, size: f.size, mtime: f.mtime, localPoster: poster
        });
      } else {
        const key = normKey(info.show);
        let s = seriesMap.get(key);
        if (!s) {
          s = { id: idFor('series:' + key), type: 'series', title: info.show, year: info.year, episodes: [], dirs: new Set(), tops: new Set(), key, mtime: 0 };
          seriesMap.set(key, s);
        }
        if (!s.year && info.year) s.year = info.year;
        // предпочитаме името с главни букви ("The Big Bang Theory", не "the big bang theory")
        if (s.title === s.title.toLowerCase() && info.show !== info.show.toLowerCase()) s.title = info.show;
        s.dirs.add(dir);
        s.tops.add(path.resolve(root, path.relative(root, dir).split(path.sep)[0] || '.').toLowerCase());
        s.mtime = Math.max(s.mtime, f.mtime);
        s.episodes.push({
          id: idFor(f.path), type: 'episode', seriesId: s.id, season: info.season, episode: info.episode,
          episodeEnd: info.episodeEnd || null, title: info.epTitle, file: f.path, size: f.size, mtime: f.mtime
        });
      }
    }
  }
  mergeVariants(seriesMap);
  const series = [];
  for (const s of seriesMap.values()) {
    s.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode || a.file.localeCompare(b.file));
    // постер: в папката на сериала (родител на "Season N") или в папка на епизод
    let poster = null;
    for (const d of s.dirs) {
      poster = findLocalImage(path.dirname(d)) || findLocalImage(d);
      if (poster) break;
    }
    s.localPoster = poster;
    delete s.dirs; delete s.tops; delete s.key;
    series.push(s);
  }
  return { movies, series };
}

module.exports = { parseFile, scanLibrary, findExternalSubs, findExternalAudio, idFor, VIDEO_EXT };
