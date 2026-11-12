'use strict';
// Запис на канал от World TV.
// HLS потоците се записват сегмент по сегмент от самата програма. Сегментите, които потокът
// отбелязва като реклама (EXT-X-CUE-OUT/IN, SCTE-35, рекламни сървъри), просто не се записват.
// Всяко непрекъснато парче отива в отделен файл, а накрая ffmpeg ги слепва в един MP4.
// Потоци, които не са обикновен HLS (отделно аудио, SAMPLE-AES, директен .ts), се записват
// изцяло през ffmpeg — там рекламите не се режат, а само се търсят след това (виж findBreaks).
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const DEF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const AD_URL = /(doubleclick\.net|googlesyndication|imasdk|dai\.google|fwmrm\.net|freewheel|springserve|innovid|tremorhub|spotx|adsrvr|unicornmedia|\/ads?\/|adbreak|ad_break|\/creatives?\/|[_\-/]ads?[_\-]\d|\/vast\/)/i;
const MAX_AD = 15 * 60;      // „реклама“ по-дълга от 15 мин = счупени маркери, записваме

function fetch(url, hdr, { range, timeout = 20000 } = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': hdr.ua || DEF_UA };
    if (hdr.referrer) headers.Referer = hdr.referrer;
    if (range) headers.Range = range;
    const req = (url.startsWith('https:') ? https : http).get(url, { headers, timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); return resolve(fetch(new URL(res.headers.location, url).href, hdr, { range, timeout }, redirects - 1));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), url }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const attrs = (s) => { const o = {}; for (const m of String(s).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi)) o[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, ''); return o; };

// master -> { variant, audioSeparate }
function pickVariant(text, base) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const audioGroups = new Set();
  for (const l of lines) if (/^#EXT-X-MEDIA:/i.test(l)) { const a = attrs(l.slice(13)); if (/AUDIO/i.test(a.TYPE) && a.URI) audioGroups.add(a['GROUP-ID']); }
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
    const a = attrs(lines[i].slice(18));
    let j = i + 1; while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    if (!lines[j]) continue;
    const bw = +a.BANDWIDTH || 0;
    const h = +(String(a.RESOLUTION || '').split('x')[1]) || 0;
    if (h > 1080) continue;     // 4K е излишно за запис
    if (!best || bw > best.bw) best = { bw, url: new URL(lines[j], base).href, audio: a.AUDIO && audioGroups.has(a.AUDIO) };
  }
  return best;
}

// медийна плейлиста -> сегменти с номер, ключ, init и флаг „реклама“.
// state пази дали предният сегмент беше реклама (маркерът може вече да е излязъл от прозореца).
function parseMedia(text, base, state = { adBySeq: new Map() }) {
  const lines = text.split(/\r?\n/);
  const sm = text.match(/#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/i);
  let seq = sm ? +sm[1] : 0, target = 6, ended = false, key = null, map = null, disc = false, dur = 0, range = null, lastEnd = 0;
  const prev = state.adBySeq.get(seq - 1) || { ad: false, left: 0 };
  let inAd = prev.ad, adLeft = prev.left, markers = false;
  const segs = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (/^#EXT-X-TARGETDURATION:/i.test(l)) { target = parseFloat(l.split(':')[1]) || 6; continue; }
    if (/^#EXT-X-ENDLIST/i.test(l)) { ended = true; continue; }
    if (/^#EXT-X-KEY:/i.test(l)) { const a = attrs(l.slice(11)); key = /^NONE$/i.test(a.METHOD) ? null : { method: a.METHOD, uri: a.URI ? new URL(a.URI, base).href : '', iv: a.IV || '' }; continue; }
    if (/^#EXT-X-MAP:/i.test(l)) { const a = attrs(l.slice(11)); map = { uri: new URL(a.URI, base).href, range: a.BYTERANGE || '' }; continue; }
    if (/^#EXT-X-DISCONTINUITY(?!-)/i.test(l)) { disc = true; continue; }
    if (/^#EXT-X-CUE-OUT-CONT/i.test(l)) {
      markers = true;
      const d = l.match(/Duration=([\d.]+)/i), e = l.match(/ElapsedTime=([\d.]+)/i);
      if (!inAd) adLeft = d ? +d[1] - (e ? +e[1] : 0) : MAX_AD;
      inAd = true;
      continue;
    }
    if (/^#EXT-X-CUE-OUT/i.test(l) || (/^#EXT-X-DATERANGE/i.test(l) && /SCTE35-OUT/i.test(l)) || /^#EXT-X-SCTE35:.*CUE-OUT/i.test(l)) {
      markers = true; inAd = true;
      const d = l.match(/DURATION=([\d.]+)/i) || l.match(/^#EXT-X-CUE-OUT:([\d.]+)/i);
      adLeft = d && +d[1] > 0 ? +d[1] : MAX_AD;
      continue;
    }
    if (/^#EXT-X-CUE-IN/i.test(l) || (/^#EXT-X-DATERANGE/i.test(l) && /SCTE35-IN/i.test(l)) || /^#EXT-X-SCTE35:.*CUE-IN/i.test(l)) { inAd = false; adLeft = 0; markers = true; continue; }
    if (/^#EXTINF:/i.test(l)) { dur = parseFloat(l.slice(8)) || 0; continue; }
    if (/^#EXT-X-BYTERANGE:/i.test(l)) {
      const [n, o] = l.slice(17).split('@'); const off = o !== undefined ? +o : lastEnd;
      range = `bytes=${off}-${off + +n - 1}`; lastEnd = off + +n; continue;
    }
    if (l.startsWith('#')) continue;
    // ред с адрес на сегмент
    if (inAd && adLeft <= 0.5) inAd = false;          // рекламата с обявена дължина свърши
    const urlAd = AD_URL.test(l);
    if (urlAd) markers = true;
    segs.push({ seq, uri: new URL(l, base).href, dur, key, map, disc, range, ad: inAd || urlAd });
    if (inAd) adLeft -= dur;
    state.adBySeq.set(seq, { ad: inAd, left: adLeft });
    seq++; disc = false; range = null; dur = 0;
  }
  // пазим само последните ~200 номера
  if (state.adBySeq.size > 400) { const ks = [...state.adBySeq.keys()].sort((a, b) => a - b); for (const k of ks.slice(0, ks.length - 200)) state.adBySeq.delete(k); }
  return { segs, target, ended, markers };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Recording extends EventEmitter {
  // opts: { ch: {url, ua, referrer}, workDir, stopAt, ffmpeg }
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.hdr = { ua: opts.ch.ua || '', referrer: opts.ch.referrer || '' };
    this.parts = [];        // [{ file, secs }]
    this.cur = null;        // текущо парче { file, fd, ext, mapUri }
    this.recorded = 0; this.cutSecs = 0; this.cuts = 0; this.bytes = 0;
    this.stopped = false; this.mode = 'hls'; this.markers = false; this.error = '';
    this.keys = new Map(); this.maps = new Map();
    fs.mkdirSync(this.workDir, { recursive: true });
  }
  info() { return { recorded: this.recorded, cutSecs: this.cutSecs, cuts: this.cuts, bytes: this.bytes, mode: this.mode, markers: this.markers, error: this.error }; }
  stop() { this.stopped = true; if (this.ff) { try { this.ff.stdin.write('q'); } catch {} setTimeout(() => { try { this.ff.kill(); } catch {} }, 8000); } if (this.wake) this.wake(); }
  done() { return this.stopped || Date.now() >= this.stopAt; }
  async wait(ms) { await new Promise(r => { this.wake = r; setTimeout(r, Math.max(0, Math.min(ms, this.stopAt - Date.now()))); }); this.wake = null; }

  newPart() { this.closePart(); }
  closePart() {
    if (!this.cur) return;
    try { fs.closeSync(this.cur.fd); } catch {}
    if (this.cur.secs > 0.5) this.parts.push({ file: this.cur.file, secs: this.cur.secs });
    else { try { fs.unlinkSync(this.cur.file); } catch {} }
    this.cur = null;
  }
  async write(seg, buf) {
    const ext = seg.map ? '.mp4' : '.ts';
    if (this.cur && (this.cur.ext !== ext || (seg.map && this.cur.mapUri !== seg.map.uri + seg.map.range))) this.closePart();
    if (!this.cur) {
      const file = path.join(this.workDir, `part${String(this.parts.length + 1).padStart(3, '0')}-${Date.now().toString(36)}${ext}`);
      this.cur = { file, fd: fs.openSync(file, 'w'), ext, secs: 0, mapUri: seg.map ? seg.map.uri + seg.map.range : '' };
      if (seg.map) {
        const k = seg.map.uri + seg.map.range;
        if (!this.maps.has(k)) this.maps.set(k, await this.decrypt(seg, (await fetch(seg.map.uri, this.hdr, { range: seg.map.range || undefined })).buf, true));
        fs.writeSync(this.cur.fd, this.maps.get(k));
      }
    }
    fs.writeSync(this.cur.fd, buf);
    this.cur.secs += seg.dur; this.recorded += seg.dur; this.bytes += buf.length;
  }
  async decrypt(seg, buf, isMap) {
    if (!seg.key || isMap) return buf;
    let k = this.keys.get(seg.key.uri);
    if (!k) { k = (await fetch(seg.key.uri, this.hdr)).buf; this.keys.set(seg.key.uri, k); }
    let iv;
    if (seg.key.iv) iv = Buffer.from(seg.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
    else { iv = Buffer.alloc(16); iv.writeUInt32BE(seg.seq >>> 0, 12); iv.writeUInt32BE(Math.floor(seg.seq / 2 ** 32), 8); }
    const d = crypto.createDecipheriv('aes-128-cbc', k, iv);
    return Buffer.concat([d.update(buf), d.final()]);
  }

  async run() {
    try {
      const first = await this.retry(() => fetch(this.ch.url, this.hdr));
      const text = first.buf.toString('utf8');
      if (!text.includes('#EXTM3U')) return await this.runFfmpeg();
      let media = first.url, mtext = text;
      if (/#EXT-X-STREAM-INF/i.test(text)) {
        const v = pickVariant(text, first.url);
        if (!v || v.audio) return await this.runFfmpeg();
        media = v.url; mtext = null;
      }
      if (/#EXT-X-KEY:[^\n]*METHOD=SAMPLE-AES/i.test(mtext || '')) return await this.runFfmpeg();
      await this.runHls(media, mtext);
    } catch (e) {
      this.error = e.message;
    } finally {
      this.closePart();
    }
    return this.parts;
  }
  async retry(fn) {
    let wait = 2000;
    for (;;) {
      try { return await fn(); } catch (e) {
        this.error = e.message; this.emit('progress');
        if (this.done()) throw e;
        await this.wait(wait); wait = Math.min(wait * 2, 30000);
      }
    }
  }
  async runHls(mediaUrl, text) {
    const state = { adBySeq: new Map() };
    let last = -1, inCut = false, adRun = 0;
    while (!this.done()) {
      if (!text) text = (await this.retry(async () => { const r = await fetch(mediaUrl, this.hdr); mediaUrl = r.url; return r; })).buf.toString('utf8');
      if (/#EXT-X-KEY:[^\n]*METHOD=SAMPLE-AES/i.test(text)) { this.closePart(); return this.runFfmpeg(); }
      const p = parseMedia(text, mediaUrl, state); text = null;
      if (p.markers) this.markers = true;
      if (last < 0 && p.segs.length) last = p.segs[Math.max(0, p.segs.length - 3)].seq - 1;   // от края на живото
      for (const seg of p.segs) {
        if (seg.seq <= last || this.done()) continue;
        if (last >= 0 && seg.seq > last + 1) this.closePart();   // изпуснати сегменти
        if (seg.disc) this.closePart();
        let ad = seg.ad;
        if (ad) { adRun += seg.dur; if (adRun > MAX_AD) ad = false; } else adRun = 0;
        if (ad) {
          if (!inCut) { inCut = true; this.cuts++; this.closePart(); }
          this.cutSecs += seg.dur; last = seg.seq; this.emit('progress');
          continue;
        }
        if (inCut) { inCut = false; this.closePart(); }
        try {
          const r = await fetch(seg.uri, this.hdr, { range: seg.range || undefined, timeout: 30000 });
          await this.write(seg, await this.decrypt(seg, r.buf));
          this.error = '';
        } catch (e) { this.error = e.message; this.closePart(); }
        last = seg.seq;
        this.emit('progress');
      }
      if (p.ended) break;
      await this.wait(Math.min(6000, Math.max(1500, p.target * 500)));
    }
  }
  // запис изцяло през ffmpeg (без рязане на реклами)
  async runFfmpeg() {
    this.mode = 'ffmpeg';
    while (!this.done()) {
      const file = path.join(this.workDir, `part${String(this.parts.length + 1).padStart(3, '0')}-${Date.now().toString(36)}.ts`);
      const args = ['-v', 'error', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10', '-rw_timeout', '20000000'];
      if (this.hdr.ua) args.push('-user_agent', this.hdr.ua);
      if (this.hdr.referrer) args.push('-headers', 'Referer: ' + this.hdr.referrer + '\r\n');
      args.push('-i', this.ch.url, '-map', '0:v:0?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', '-y', file);
      const t0 = Date.now();
      await new Promise((resolve) => {
        const ff = this.ff = spawn(this.ffmpeg, args, { windowsHide: true });
        let err = '';
        ff.stderr.on('data', d => { err = (err + d).slice(-400); });
        const tick = setInterval(() => {
          try { this.bytes = fs.statSync(file).size; } catch {}
          this.recorded = this.parts.reduce((a, p) => a + p.secs, 0) + (Date.now() - t0) / 1000;
          this.emit('progress');
          if (Date.now() >= this.stopAt) this.stop();
        }, 2000);
        ff.on('error', (e) => { this.error = e.message; });
        ff.on('close', () => { clearInterval(tick); this.ff = null; if (err.trim()) this.error = err.trim().split('\n').pop(); resolve(); });
      });
      const secs = (Date.now() - t0) / 1000;
      let size = 0; try { size = fs.statSync(file).size; } catch {}
      if (size > 50000) this.parts.push({ file, secs }); else { try { fs.unlinkSync(file); } catch {} }
      if (!this.done()) await this.wait(5000);
    }
  }
}

// ---- след записа ------------------------------------------------------------
function run(ffmpeg, args) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-200000); });
    p.on('error', (e) => resolve({ code: -1, err: e.message }));
    p.on('close', (code) => resolve({ code, err }));
  });
}

// слепва парчетата в един файл; out без разширение -> връща пълния път
async function finalize(ffmpeg, parts, workDir, outNoExt) {
  if (!parts.length) throw new Error('Нищо не беше записано.');
  const list = path.join(workDir, 'list.txt');
  fs.writeFileSync(list, parts.map(p => `file '${p.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  for (const [ext, fmt, extra] of [['.mp4', 'mp4', ['-movflags', '+faststart']], ['.mkv', 'matroska', []]]) {
    const tmp = path.join(workDir, 'out' + ext);
    const r = await run(ffmpeg, ['-v', 'error', '-nostdin', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-ignore_unknown', ...extra, '-f', fmt, '-y', tmp]);
    let ok = false; try { ok = r.code === 0 && fs.statSync(tmp).size > 10000; } catch {}
    if (ok) return moveOut(tmp, outNoExt + ext);
    try { fs.unlinkSync(tmp); } catch {}
  }
  // без ffmpeg: суров .ts (само ако всички парчета са .ts)
  if (parts.every(p => p.file.endsWith('.ts'))) {
    const tmp = path.join(workDir, 'out.ts');
    const fd = fs.openSync(tmp, 'w');
    for (const p of parts) fs.writeSync(fd, fs.readFileSync(p.file));
    fs.closeSync(fd);
    return moveOut(tmp, outNoExt + '.ts');
  }
  throw new Error('ffmpeg не можа да слепи записа.');
}
function moveOut(tmp, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(tmp, dst); } catch { fs.copyFileSync(tmp, dst); fs.unlinkSync(tmp); }
  return dst;
}

// Търси места с черен кадър + тишина. Рекламният блок е поредица такива места на кратки
// разстояния (между отделните клипове), затова групи от ≥3 прехода през ≤70 сек = вероятна реклама.
async function findBreaks(ffmpeg, file) {
  const r = await run(ffmpeg, ['-nostdin', '-hide_banner', '-i', file, '-map', '0:v:0?', '-map', '0:a:0?',
    '-vf', 'scale=192:-2,blackdetect=d=0.1:pix_th=0.12:pic_th=0.95', '-af', 'silencedetect=n=-42dB:d=0.15', '-f', 'null', '-']);
  return breaksFromLog(r.err);
}
function breaksFromLog(log) {
  const black = [], silence = [];
  for (const m of String(log).matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)) black.push([+m[1], +m[2]]);
  let s0 = null;
  for (const m of String(log).matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    if (m[1] === 'start') s0 = Math.max(0, +m[2]); else if (s0 !== null) { silence.push([s0, +m[2]]); s0 = null; }
  }
  const pts = [];
  for (const [a, b] of black) if (silence.some(([c, d]) => c <= b + 0.4 && d >= a - 0.4)) pts.push((a + b) / 2);
  const out = [];
  let g = [];
  const flush = () => { if (g.length >= 3 && g[g.length - 1] - g[0] >= 40) out.push({ from: Math.max(0, g[0] - 0.5), to: g[g.length - 1] + 0.5 }); g = []; };
  for (const t of pts) { if (g.length && t - g[g.length - 1] > 70) flush(); g.push(t); }
  flush();
  return out.filter(b => b.to - b.from < 15 * 60);
}

// изрязва [from, to] секунди от файла (по ключови кадри)
async function cut(ffmpeg, file, from, to, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const a = path.join(workDir, 'a.ts'), b = path.join(workDir, 'b.ts'), list = path.join(workDir, 'cut.txt');
  const base = ['-v', 'error', '-nostdin'];
  const parts = [];
  if (from > 1) { const r = await run(ffmpeg, [...base, '-i', file, '-t', String(from), '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', '-y', a]); if (r.code === 0) parts.push(a); }
  const r2 = await run(ffmpeg, [...base, '-ss', String(to), '-i', file, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', '-y', b]);
  if (r2.code === 0) parts.push(b);
  if (!parts.length) throw new Error('ffmpeg не можа да изреже.');
  fs.writeFileSync(list, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const ext = path.extname(file).toLowerCase();
  const tmp = path.join(workDir, 'cut' + ext);
  const fmt = ext === '.mkv' ? 'matroska' : ext === '.ts' ? 'mpegts' : 'mp4';
  const r = await run(ffmpeg, [...base, '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', ...(fmt === 'mp4' ? ['-movflags', '+faststart'] : []), '-f', fmt, '-y', tmp]);
  if (r.code !== 0) throw new Error('ffmpeg не можа да слепи.');
  fs.copyFileSync(tmp, file);
  for (const f of [a, b, list, tmp]) { try { fs.unlinkSync(f); } catch {} }
}

module.exports = { Recording, finalize, findBreaks, breaksFromLog, cut, parseMedia, pickVariant };
