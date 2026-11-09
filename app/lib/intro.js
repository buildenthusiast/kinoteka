'use strict';
// Откриване на интро и финални надписи: сравняваме звука на два епизода от един сериал
// и търсим най-дългия общ откъс (песента в началото / музиката на надписите в края).
const { spawn } = require('child_process');

const SR = 8000, NFFT = 1024, HOP = 256, BANDS = 33;
const FPS = SR / HOP;               // кадри в секунда (31.25)

function pcm(ffmpeg, file, { start = 0, dur, fromEnd } = {}) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-nostdin'];
    if (fromEnd) args.push('-sseof', String(-fromEnd)); else if (start) args.push('-ss', String(start));
    args.push('-i', file);
    if (dur) args.push('-t', String(dur));
    args.push('-map', '0:a:0', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-');
    const p = spawn(ffmpeg, args, { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const b = Buffer.concat(chunks);
      const n = b.length >> 1, x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(i * 2) / 32768;
      resolve(n > SR * 5 ? x : null);
    });
  });
}

// --- FFT (радикс 2, на място) ---
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// отпечатък: по едно 32-битово число на кадър; -1 = тишина (не се сравнява)
function fingerprint(x) {
  const frames = Math.max(0, Math.floor((x.length - NFFT) / HOP));
  const win = new Float32Array(NFFT);
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT);
  const edges = [];
  for (let m = 0; m <= BANDS; m++) edges.push(Math.round(300 * Math.pow(3000 / 300, m / BANDS) * NFFT / SR));
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const out = new Int32Array(frames);
  let prev = null;
  for (let f = 0; f < frames; f++) {
    let energy = 0;
    for (let i = 0; i < NFFT; i++) { const v = x[f * HOP + i]; re[i] = v * win[i]; im[i] = 0; energy += v * v; }
    fft(re, im);
    const e = new Float64Array(BANDS);
    for (let m = 0; m < BANDS; m++) {
      let s = 0;
      for (let k = edges[m]; k < Math.max(edges[m] + 1, edges[m + 1]); k++) s += re[k] * re[k] + im[k] * im[k];
      e[m] = s;
    }
    let h = 0;
    if (prev) for (let m = 0; m < 32; m++) if ((e[m] - e[m + 1]) - (prev[m] - prev[m + 1]) > 0) h |= (1 << m);
    prev = e;
    out[f] = energy / NFFT < 1e-6 ? -1 : h;
  }
  return out;
}

function pc(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }
const MAXBITS = 10;

// най-дългият общ откъс между двата отпечатъка → { a: [s,e], b: [s,e] } в секунди
function longestCommon(A, B, minSec) {
  const nA = A.length, nB = B.length;
  const best = [];
  for (let d = -(nB - 1); d < nA; d++) {        // A[i] ~ B[i-d]
    const i0 = Math.max(0, d), i1 = Math.min(nA, nB + d);
    if (i1 - i0 < minSec * FPS) continue;
    let c = 0;
    for (let i = i0; i < i1; i += 3) { const a = A[i], b = B[i - d]; if (a !== -1 && b !== -1 && pc(a ^ b) <= 7) c++; }   // строго: случайни съвпадения ~0.1%
    if (best.length < 5 || c > best[best.length - 1].c) { best.push({ d, c }); best.sort((p, q) => q.c - p.c); if (best.length > 5) best.pop(); }
  }
  let res = null;
  const W = Math.round(FPS);                     // прозорец 1 сек
  for (const { d } of best) {
    const i0 = Math.max(0, d), i1 = Math.min(nA, nB + d);
    const m = new Uint8Array(i1 - i0);
    for (let i = i0; i < i1; i++) { const a = A[i], b = B[i - d]; m[i - i0] = a !== -1 && b !== -1 && pc(a ^ b) <= MAXBITS ? 1 : 0; }
    // плъзгащ прозорец: откъсът е общ, ако поне 35% от кадрите съвпадат
    let s = 0, runStart = -1;
    const good = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) { s += m[i]; if (i >= W) s -= m[i - W]; if (i >= W - 1 && s >= W * 0.35) good.fill(1, i - W + 1, i + 1); }
    for (let i = 0; i <= good.length; i++) {
      if (i < good.length && good[i]) { if (runStart < 0) runStart = i; continue; }
      if (runStart >= 0) {
        const len = (i - runStart) / FPS;
        if (len >= minSec && (!res || len > res.len)) res = { len, a: [(runStart + i0) / FPS + 0.5, (i + i0) / FPS], b: [(runStart + i0 - d) / FPS + 0.5, (i + i0 - d) / FPS] };
        runStart = -1;
      }
    }
  }
  return res;
}

const INTRO_WIN = 420, OUTRO_WIN = 240;

// тежкото смятане е в отделна нишка, за да не спира видеото и прозореца
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
function common(x, y, minSec) {
  return new Promise((resolve) => {
    let w;
    try { w = new Worker(__filename, { workerData: { x, y, minSec } }); } catch { return resolve(longestCommon(fingerprint(x), fingerprint(y), minSec)); }
    w.once('message', resolve);
    w.once('error', () => resolve(null));
  });
}
if (!isMainThread && workerData && workerData.x) {
  parentPort.postMessage(longestCommon(fingerprint(workerData.x), fingerprint(workerData.y), workerData.minSec));
}

// анализира двойка епизоди → { a: {intro, outro}, b: {intro, outro} } (секунди от началото на файла)
async function analyzePair(ffmpeg, fileA, durA, fileB, durB) {
  const out = { a: { intro: null, outro: null }, b: { intro: null, outro: null } };
  const [ia, ib] = await Promise.all([pcm(ffmpeg, fileA, { dur: INTRO_WIN }), pcm(ffmpeg, fileB, { dur: INTRO_WIN })]);
  if (ia && ib) {
    const r = await common(ia, ib, 8);
    if (r && r.len <= 150) { out.a.intro = r.a.map(round); out.b.intro = r.b.map(round); }
  }
  if (durA > OUTRO_WIN * 2 && durB > OUTRO_WIN * 2) {
    const [oa, ob] = await Promise.all([pcm(ffmpeg, fileA, { start: durA - OUTRO_WIN }), pcm(ffmpeg, fileB, { start: durB - OUTRO_WIN })]);
    if (oa && ob) {
      const r = await common(oa, ob, 8);
      // надписите трябва да са близо до края (до 40 сек преди него)
      if (r && OUTRO_WIN - r.a[1] < 40) { out.a.outro = [round(durA - OUTRO_WIN + r.a[0])]; out.b.outro = [round(durB - OUTRO_WIN + r.b[0])]; }
    }
  }
  return out;
}
const round = (x) => Math.round(x * 10) / 10;

module.exports = { analyzePair, fingerprint, longestCommon, FPS, SR };
