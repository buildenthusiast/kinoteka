'use strict';
// Автоматична синхронизация на субтитри: намира кога се говори във филма (ffmpeg silencedetect
// върху честотите на гласа) и търси отместването, при което репликите най-добре съвпадат с говора.
const { spawn } = require('child_process');

const STEP = 0.1;            // резолюция, сек
const MAX_SHIFT = 60;        // търси от −60 до +60 сек

// връща масив [start, end] с интервалите на говор в първите `limit` секунди
function speechIntervals(ffmpeg, file, audioIdx = 0, limit = 1800) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'info', '-nostdin', '-t', String(limit), '-i', file, '-map', `0:a:${audioIdx}?`, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000',
      '-af', 'highpass=f=250,lowpass=f=3000,silencedetect=noise=-32dB:d=0.35', '-f', 'null', '-'];
    const ff = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    ff.stderr.on('data', d => { err += d.toString(); if (err.length > 8e6) err = err.slice(-4e6); });
    ff.on('error', reject);
    ff.on('close', () => {
      const sil = [];
      let st = null;
      for (const m of err.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
        if (m[1] === 'start') st = Math.max(0, +m[2]);
        else if (st != null) { sil.push([st, +m[2]]); st = null; }
      }
      const dm = err.match(/time=(\d+):(\d+):([\d.]+)/g);
      let total = limit;
      if (dm && dm.length) { const x = dm[dm.length - 1].match(/(\d+):(\d+):([\d.]+)/); total = Math.min(limit, +x[1] * 3600 + +x[2] * 60 + +x[3]); }
      if (st != null) sil.push([st, total]);
      // говор = всичко между тишините
      const speech = [];
      let t = 0;
      for (const [a, b] of sil) { if (a > t) speech.push([t, a]); t = Math.max(t, b); }
      if (t < total) speech.push([t, total]);
      resolve({ speech, total });
    });
  });
}

function toBins(intervals, n, shift = 0) {
  const a = new Float32Array(n);
  for (const [s, e] of intervals) {
    const i0 = Math.max(0, Math.floor((s + shift) / STEP)), i1 = Math.min(n, Math.ceil((e + shift) / STEP));
    for (let i = i0; i < i1; i++) a[i] = 1;
  }
  return a;
}

// cues: [{start,end}] -> { offset, score } (offset > 0 = субтитрите да се покажат по-късно)
function bestOffset(cues, speech, total) {
  const n = Math.ceil(total / STEP);
  const sp = toBins(speech, n);
  const mean = sp.reduce((x, y) => x + y, 0) / (n || 1);
  for (let i = 0; i < n; i++) sp[i] -= mean;     // центриране — иначе „повече говор“ печели винаги
  const subs = cues.filter(c => c.start < total + MAX_SHIFT).map(c => [c.start, c.end]);
  if (subs.length < 15) return null;
  const idx = [];
  for (const [s, e] of subs) for (let i = Math.floor(s / STEP); i < Math.ceil(e / STEP); i++) idx.push(i);
  const K = Math.round(MAX_SHIFT / STEP);
  const scores = new Float32Array(2 * K + 1);
  for (let k = -K; k <= K; k++) {
    let sc = 0;
    for (const i of idx) { const j = i + k; if (j >= 0 && j < n) sc += sp[j]; }
    scores[k + K] = sc;
  }
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  const sorted = [...scores].sort((a, b) => a - b), med = sorted[sorted.length >> 1], max = scores[best];
  const spread = (max - med) / (Math.abs(max) + 1e-6);
  return { offset: Math.round((best - K) * STEP * 10) / 10, confidence: Math.round(spread * 100) / 100 };
}

async function sync(ffmpeg, file, cues, audioIdx = 0) {
  const { speech, total } = await speechIntervals(ffmpeg, file, audioIdx);
  if (!speech.length || total < 60) return null;
  return bestOffset(cues, speech, total);
}

module.exports = { sync, bestOffset, speechIntervals };
