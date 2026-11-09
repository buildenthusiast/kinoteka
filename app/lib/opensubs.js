'use strict';
// Търсене и теглене на български субтитри от OpenSubtitles.com (нужен е безплатен API ключ).
const https = require('https');
const fs = require('fs');
const path = require('path');

const API = 'https://api.opensubtitles.com/api/v1';
const UA = 'Kinoteka v0.2';

function req(method, url, { key, token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Accept': 'application/json', 'User-Agent': UA };
    if (key) headers['Api-Key'] = key;
    if (token) headers.Authorization = 'Bearer ' + token;
    let data = null;
    if (body) { data = Buffer.from(JSON.stringify(body)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const r = https.request(url, { method, headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(req(method === 'POST' ? 'GET' : method, new URL(res.headers.location, url).href, { key })); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          let msg = 'HTTP ' + res.statusCode;
          try { const j = JSON.parse(buf.toString('utf8')); if (j.message) msg += ': ' + j.message; } catch {}
          return reject(new Error(msg));
        }
        const ct = res.headers['content-type'] || '';
        if (ct.includes('json')) { try { return resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { return reject(e); } }
        resolve(buf);
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('Няма връзка със сървъра за субтитри')));
    if (data) r.write(data);
    r.end();
  });
}

// OpenSubtitles hash: размер + сума на първите и последните 64 KB като 64-битови числа
function movieHash(file) {
  const CH = 65536;
  const size = fs.statSync(file).size;
  if (size < CH * 2) return null;
  const fd = fs.openSync(file, 'r');
  try {
    let h = BigInt(size);
    const buf = Buffer.alloc(CH);
    for (const pos of [0, size - CH]) {
      fs.readSync(fd, buf, 0, CH, pos);
      for (let i = 0; i < CH; i += 8) h = (h + buf.readBigUInt64LE(i)) & 0xFFFFFFFFFFFFFFFFn;
    }
    return h.toString(16).padStart(16, '0');
  } finally { fs.closeSync(fd); }
}

let session = { user: null, token: null };
async function login(s) {
  if (!s.osUser || !s.osPass) return null;
  if (session.user === s.osUser && session.token) return session.token;
  try {
    const j = await req('POST', API + '/login', { key: s.osKey, body: { username: s.osUser, password: s.osPass } });
    session = { user: s.osUser, token: j.token };
    return j.token;
  } catch { return null; }
}

// item: { file, kind: 'movie'|'episode', title, year, season, episode, tmdbId }
async function search(settings, item) {
  const key = settings.osKey;
  const results = new Map();
  const add = (data, byHash) => {
    for (const d of (data && data.data) || []) {
      const a = d.attributes || {};
      const f = (a.files || [])[0];
      if (!f || results.has(f.file_id)) continue;
      results.set(f.file_id, { fileId: f.file_id, name: a.release || f.file_name || 'субтитри', downloads: a.download_count || 0, exact: byHash || !!a.moviehash_match, hearing: !!a.hearing_impaired });
    }
  };
  const base = { languages: 'bg' };
  let hash = null;
  try { hash = movieHash(item.file); } catch {}
  if (hash) { try { add(await req('GET', `${API}/subtitles?${new URLSearchParams({ ...base, moviehash: hash })}`, { key }), true); } catch (e) { if (/HTTP 401|HTTP 403/.test(e.message)) throw e; } }
  const q = { ...base };
  if (item.kind === 'episode') {
    if (item.tmdbId) q.parent_tmdb_id = item.tmdbId; else q.query = item.title;
    q.season_number = item.season; q.episode_number = item.episode;
  } else {
    if (item.tmdbId) q.tmdb_id = item.tmdbId; else q.query = item.title;
    if (item.year && !item.tmdbId) q.year = item.year;
  }
  add(await req('GET', `${API}/subtitles?${new URLSearchParams(q)}`, { key }), false);
  // подреждане: първо точните (по хеш), после по сходство на името с файла, после по тегления
  const base2 = path.basename(item.file).toLowerCase();
  const sim = (n) => n.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && base2.includes(w)).length;
  return [...results.values()].sort((a, b) => (b.exact - a.exact) || (sim(b.name) - sim(a.name)) || (b.downloads - a.downloads)).slice(0, 12);
}

// тегли субтитрите и ги записва до видеото като <име>.bg.srt; връща пътя
async function download(settings, fileId, videoFile) {
  const token = await login(settings);
  const j = await req('POST', API + '/download', { key: settings.osKey, token, body: { file_id: fileId, sub_format: 'srt' } });
  if (!j.link) throw new Error(j.message || 'Няма връзка за теглене');
  const buf = await req('GET', j.link, {});
  const dir = path.dirname(videoFile), stem = path.basename(videoFile, path.extname(videoFile));
  let out = path.join(dir, `${stem}.bg.srt`);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(dir, `${stem}.bg${n}.srt`);
  fs.writeFileSync(out, Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
  return { path: out, remaining: j.remaining };
}

module.exports = { search, download, movieHash };
