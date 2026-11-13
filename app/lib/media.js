'use strict';
// ffmpeg/ffprobe: проба на файлове, кадри за миниатюри, стрийм с прекодиране, субтитри.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { findExternalAudio } = require('./scanner');

function findBin(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', exe));
  candidates.push(path.join(__dirname, '..', 'bin', exe));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return exe; // от PATH
}
const FFMPEG = findBin('ffmpeg');
const FFPROBE = findBin('ffprobe');

const isUrl = (f) => /^https?:\/\//i.test(String(f || ''));
// мрежови настройки на ffmpeg/ffprobe за онлайн видео (вкл. заглавки от добавката)
function netArgs(file, headers) {
  if (!isUrl(file)) return [];
  const a = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '20000000'];
  const h = Object.assign({}, headers || {});
  const ua = h['User-Agent'] || h['user-agent']; delete h['User-Agent']; delete h['user-agent'];
  if (ua) a.push('-user_agent', String(ua));
  const rest = Object.entries(h).filter(([k, v]) => /^[\w-]+$/.test(k) && !/[\r\n]/.test(String(v))).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  if (rest) a.push('-headers', rest);
  return a;
}

function probe(file, headers) {
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-v', 'error', ...netArgs(file, headers), '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 20 * 1024 * 1024, windowsHide: true, timeout: isUrl(file) ? 45000 : 0 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(stdout);
          const streams = j.streams || [];
          const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
          const audio = streams.filter(s => s.codec_type === 'audio').map((s, i) => ({
            index: i, codec: s.codec_name, channels: s.channels,
            lang: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
            title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
            default: !!(s.disposition && s.disposition.default)
          }));
          const subs = streams.filter(s => s.codec_type === 'subtitle').map((s, i) => ({
            index: i, codec: s.codec_name,
            lang: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
            title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
            text: ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'].includes(s.codec_name)
          }));
          resolve({
            duration: parseFloat(j.format && j.format.duration) || 0,
            format: (j.format && j.format.format_name) || '',
            video: v ? { codec: v.codec_name, width: v.width, height: v.height, pix: v.pix_fmt, profile: v.profile } : null,
            audio, subs
          });
        } catch { resolve(null); }
      });
  });
}

// Може ли Chromium да пусне файла директно (без ffmpeg)?
function canPlayDirect(file, info) {
  if (!info || !info.video) return false;
  const ext = path.extname(file).toLowerCase();
  if (!['.mp4', '.m4v', '.webm', '.mov'].includes(ext)) return false;
  const vOk = ['h264', 'vp8', 'vp9', 'av1'].includes(info.video.codec) && !/10/.test(info.video.pix || '') ;
  const aOk = info.audio.length <= 1 && (!info.audio.length || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(info.audio[0].codec));
  return vOk && aOk;
}

function thumbnail(file, out, at) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-y', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
      '-vf', 'scale=480:-2', '-q:v', '4', out], { windowsHide: true });
    const t = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0 && fs.existsSync(out)); });
    p.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

// --- субтитри -----------------------------------------------------------
function decodeText(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  const utf = buf.toString('utf8');
  if (!utf.includes('�')) return utf;
  // Българските .srt често са в Windows-1251
  try { return new TextDecoder('windows-1251').decode(buf); } catch { return utf; }
}

function parseTime(t) {
  const m = t.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return NaN;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

function parseSrtVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const start = parseTime(a), end = parseTime(z);
    if (isNaN(start) || isNaN(end)) continue;
    const body = lines.slice(i + 1).join('\n')
      .replace(/\{\\[^}]*\}/g, '').replace(/<(?!\/?(i|b|u)>)[^>]+>/g, '').trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues;
}

function parseAss(text) {
  const cues = [];
  let fmt = null;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^Format:/i.test(line) && !fmt) { fmt = line.slice(7).split(',').map(s => s.trim().toLowerCase()); continue; }
    if (!/^Dialogue:/i.test(line) || !fmt) continue;
    const parts = line.slice(9).split(',');
    const textIdx = fmt.indexOf('text');
    const get = (k) => parts[fmt.indexOf(k)];
    const body = parts.slice(textIdx).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').trim();
    if (body) cues.push({ start: parseTime(get('start')), end: parseTime(get('end')), text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function readExternalSubs(file) {
  const text = decodeText(fs.readFileSync(file));
  return /\.(ass|ssa)$/i.test(file) ? parseAss(text) : parseSrtVtt(text);
}

function extractEmbeddedSubs(file, index) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-map', `0:s:${index}`, '-f', 'srt', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.on('close', () => resolve(parseSrtVtt(Buffer.concat(chunks).toString('utf8'))));
    p.on('error', () => resolve([]));
  });
}

// --- локален HTTP сървър за видео --------------------------------------
// resolveFile(id) → абсолютен път или null (само файлове от библиотеката)
// resolveHeaders(id) → заглавки за онлайн видео (по желание)
function startServer({ resolveFile, resolveImage, resolveHeaders }) {
  const probeCache = new Map();   // онлайн видео: не пробваме адреса при всяко превъртане
  const token = crypto.randomBytes(12).toString('hex');
  let active = null; // текущият ffmpeg процес

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('k') !== token) { res.writeHead(403); return res.end(); }
    try {
      if (url.pathname === '/img') {
        const p = resolveImage(url.searchParams.get('id'));
        if (!p || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
        const ext = path.extname(p).toLowerCase();
        res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'max-age=3600' });
        return fs.createReadStream(p).pipe(res);
      }
      if (url.pathname === '/live') {
        // World TV: поток, който браузърът не може да пусне сам (напр. MPEG-TS, HEVC) — ffmpeg го преобразува като VLC
        const src = url.searchParams.get('u') || '';
        if (!/^https?:\/\//i.test(src)) { res.writeHead(400); return res.end(); }
        if (active) { try { active.kill('SIGKILL'); } catch {} }
        const ff = spawn(FFMPEG, buildLiveArgs(src, url.searchParams.get('ref') || '', url.searchParams.get('ua') || ''), { windowsHide: true });
        active = ff;
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
        ff.stdout.pipe(res);
        ff.stderr.on('data', () => {});
        ff.on('error', () => res.end());
        const kill = () => { try { ff.kill('SIGKILL'); } catch {} };
        req.on('close', kill);
        res.on('close', kill);
        ff.on('close', () => { if (active === ff) active = null; res.end(); });
        return;
      }
      const id = url.searchParams.get('id');
      const file = resolveFile(id);
      const remote = isUrl(file);
      if (!file || (!remote && !fs.existsSync(file))) { res.writeHead(404); return res.end(); }
      const headers = remote && resolveHeaders ? resolveHeaders(id) : null;

      if (url.pathname === '/direct') { if (remote) { res.writeHead(404); return res.end(); } return serveRange(file, req, res); }
      if (url.pathname === '/stream') {
        const t = Math.max(0, parseFloat(url.searchParams.get('t')) || 0);
        const audio = parseInt(url.searchParams.get('a') || '0', 10) || 0;
        const force = url.searchParams.get('tx') === '1';
        let info = remote ? probeCache.get(file) : null;
        if (!info) { info = await probe(file, headers); if (remote && info) { probeCache.set(file, info); if (probeCache.size > 20) probeCache.delete(probeCache.keys().next().value); } }
        const args = buildStreamArgs(file, info, t, audio, force, remote ? [] : findExternalAudio(file), headers);
        if (active) { try { active.kill('SIGKILL'); } catch {} }
        const ff = spawn(FFMPEG, args, { windowsHide: true });
        active = ff;
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
        ff.stdout.pipe(res);
        ff.stderr.on('data', () => {});
        const kill = () => { try { ff.kill('SIGKILL'); } catch {} };
        req.on('close', kill);
        res.on('close', kill);
        ff.on('close', () => { if (active === ff) active = null; res.end(); });
        return;
      }
      res.writeHead(404); res.end();
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, token, stopAll: () => active && active.kill('SIGKILL') });
    });
  });
}

function buildStreamArgs(file, info, t, audioIdx, forceTranscode, extAudio = [], headers = null) {
  const v = info && info.video;
  const nEmb = info ? info.audio.length : 0;
  const ext = audioIdx >= nEmb ? extAudio[audioIdx - nEmb] : null;
  const a = ext ? { codec: ext.codec } : (info && info.audio[audioIdx]);
  const copyVideo = !forceTranscode && v && v.codec === 'h264' && !/10/.test(v.pix || '');
  const copyHevc = !forceTranscode && v && v.codec === 'hevc'; // Windows с хардуерно декодиране; при грешка плейърът минава на прекодиране
  const args = ['-v', 'error', '-nostdin'];
  if (t > 0) args.push('-ss', t.toFixed(3));
  args.push(...netArgs(file, headers), '-i', file);
  if (ext) { if (t > 0) args.push('-ss', t.toFixed(3)); args.push('-i', ext.path); }
  args.push('-map', '0:v:0?');
  if (ext) args.push('-map', '1:a:0');
  else if (a) args.push('-map', `0:a:${audioIdx}`);
  args.push('-sn', '-dn');
  if (copyVideo || copyHevc) {
    args.push('-c:v', 'copy');
    if (copyHevc) args.push('-tag:v', 'hvc1');
  } else {
    const vf = ['scale=w=min(1920\\,iw):h=-2', 'format=yuv420p'];
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-vf', vf.join(','), '-g', '48');
  }
  if (a) {
    if (['aac', 'mp3'].includes(a.codec) && !forceTranscode) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '224k', '-ac', '2');
  }
  args.push('-avoid_negative_ts', 'make_zero', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return args;
}

function buildLiveArgs(src, referrer, ua) {
  const args = ['-v', 'error', '-nostdin', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000'];
  if (ua) args.push('-user_agent', ua);
  if (referrer) args.push('-headers', 'Referer: ' + referrer + '\r\n');
  args.push('-i', src, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-vf', 'scale=w=min(1920\\,iw):h=-2,format=yuv420p', '-g', '50',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return args;
}

function serveRange(file, req, res) {
  const size = fs.statSync(file).size;
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m[1] ? +m[1] : 0;
    let end = m[2] ? +m[2] : size - 1;
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    end = Math.min(end, size - 1);
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
}

module.exports = { isUrl, netArgs, parseAss, probe, canPlayDirect, thumbnail, readExternalSubs, extractEmbeddedSubs, startServer, buildStreamArgs, buildLiveArgs, parseSrtVtt, decodeText, FFMPEG, FFPROBE };
