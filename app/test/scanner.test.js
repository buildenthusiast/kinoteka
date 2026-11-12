const assert = require('assert');
const path = require('path');
const { parseFile } = require('../lib/scanner');
const R = path.resolve('/lib');
const p = (...a) => path.join(R, ...a);
const cases = [
  [p('The.Matrix.1999.1080p.BluRay.x264.mkv'), { kind: 'movie', title: 'The Matrix', year: 1999 }],
  [p('Inception (2010)', 'Inception.2010.BDRip.mkv'), { kind: 'movie', title: 'Inception', year: 2010 }],
  [p('Blade Runner 2049 (2017)', 'movie.mkv'), { kind: 'movie', title: 'Blade Runner 2049', year: 2017 }],
  [p('Интерстелар.2014.BG.Audio.mkv'), { kind: 'movie', title: 'Интерстелар', year: 2014 }],
  [p('Breaking.Bad.S01E02.720p.HDTV.mkv'), { kind: 'episode', show: 'Breaking Bad', season: 1, episode: 2 }],
  [p('Friends', 'Season 3', 'Friends - 3x05 - The One with the Frog.avi'), { kind: 'episode', show: 'Friends', season: 3, episode: 5, epTitle: 'The One with the Frog' }],
  [p('Lost', 'Season 2', 'S02E10.mkv'), { kind: 'episode', show: 'Lost', season: 2, episode: 10 }],
  [p('Dark (2017)', 'Season 1', '04.mkv'), { kind: 'episode', show: 'Dark', season: 1, episode: 4, year: 2017 }],
  [p('Doctor.Who.2005.S01E01.Rose.mkv'), { kind: 'episode', show: 'Doctor Who', year: 2005, season: 1, episode: 1, epTitle: 'Rose' }],
  [p('Demo.Show.S01E01.720p.mkv'), { kind: 'episode', show: 'Demo Show', season: 1, episode: 1, episodeEnd: null, epTitle: '' }],
  [p('Show.S02E03E04.mkv'), { kind: 'episode', season: 2, episode: 3, episodeEnd: 4 }],
  [p('Малкълм', 'Малкълм - S01E07 - 12 ное 2026 13ч00.mp4'), { kind: 'episode', show: 'Малкълм', season: 1, episode: 7, epTitle: '12 ное 2026 13ч00' }],
];
let fail = 0;
for (const [file, exp] of cases) {
  const got = parseFile(file, R);
  try { for (const k of Object.keys(exp)) assert.deepStrictEqual(got[k], exp[k], k); console.log('ok  ', path.basename(file)); }
  catch (e) { fail++; console.log('FAIL', file, JSON.stringify(got), e.message); }
}
// сливане на "House" и "House M D" в една и съща папка
{
  const fs = require('fs'), os = require('os');
  const { scanLibrary } = require('../lib/scanner');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-'));
  const mk = (...a) => { const f = path.join(root, ...a); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); };
  mk('House', 'House.M.D.S01.XviD', 'House.1x01.Pilot.avi');
  mk('House', 'House.M.D.Season.05', 'House.M.D.S05E01.avi');
  mk('bbt', '4', 'the.big.bang.theory.s04e01.avi');
  mk('bbt', 'S01', 'The.Big.Bang.Theory.S01E01.avi');
  const { series } = scanLibrary([root]);
  try {
    assert.strictEqual(series.length, 2, 'брой сериали: ' + series.map(s => s.title).join(', '));
    const h = series.find(s => s.title === 'House');
    assert.deepStrictEqual(h.episodes.map(e => e.season), [1, 5]);
    assert.ok(series.some(s => s.title === 'The Big Bang Theory'), 'главни букви');
    console.log('ok   сливане на сериали');
  } catch (e) { fail++; console.log('FAIL сливане', e.message); }
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
