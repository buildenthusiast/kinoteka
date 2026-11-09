'use strict';
// Автоматично обновяване: при пускане (и на всеки няколко часа) програмата проверява
// manifest.json на фиксиран адрес, тегли само променените файлове, проверява ги (SHA-256)
// и ги записва в папката на програмата. Промените влизат в сила след рестарт.
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_BASE = 'https://raw.githubusercontent.com/buildenthusiast/kinoteka/main/app/';

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Kinoteka-updater', 'Cache-Control': 'no-cache' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return resolve(get(new URL(res.headers.location, url).href, redirects - 1)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error('HTTP ' + res.statusCode)));
    }).on('error', reject).setTimeout(30000, function () { this.destroy(new Error('timeout')); });
  });
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const newer = (a, b) => {   // a > b ?
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};
const safeRel = (p) => typeof p === 'string' && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..') && /^[\w\-./]+$/.test(p);

function localVersion(appDir) {
  try { return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version || '0'; } catch { return '0'; }
}

// връща { updated: true, version } ако е обновено, иначе { updated: false, ... }
async function check(appDir, base = DEFAULT_BASE) {
  if (!/^https:\/\//.test(base)) return { updated: false, error: 'bad base' };
  if (!base.endsWith('/')) base += '/';
  const man = JSON.parse((await get(base + 'manifest.json?t=' + Date.now())).toString('utf8'));
  const cur = localVersion(appDir);
  if (!man.version || !newer(man.version, cur)) return { updated: false, version: cur };
  const files = Object.entries(man.files || {}).filter(([p]) => safeRel(p));
  // 1) тегли всичко променено в паметта и проверява
  const todo = [];
  for (const [rel, hash] of files) {
    const dst = path.join(appDir, rel);
    let same = false;
    try { same = sha(fs.readFileSync(dst)) === hash; } catch {}
    if (same) continue;
    const buf = await get(base + rel.split('/').map(encodeURIComponent).join('/') + '?v=' + man.version);
    if (sha(buf) !== hash) throw new Error('повреден файл: ' + rel);
    todo.push([dst, buf]);
  }
  // 2) записва (първо във .new, после подмяна — за да не остане половин файл)
  for (const [dst, buf] of todo) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst + '.new', buf);
  }
  for (const [dst] of todo) fs.renameSync(dst + '.new', dst);
  return { updated: true, version: man.version, from: cur, changed: todo.length, notes: man.notes || '' };
}

module.exports = { check, newer, DEFAULT_BASE };
