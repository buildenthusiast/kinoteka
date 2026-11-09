# -*- coding: utf-8 -*-
"""
Стъпка 3: кой герой кой български актьор го озвучава.

Изслушва няколко епизода от сезона за озвучаване (оригинален английски звук + .srt),
групира английските гласове (Шелдън, Ленърд, Пени…) и за всеки пуска пример, а ти
избираш номера на българския актьор. Записва се в voices\\characters.json.
"""
import argparse, sys, time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import bg_voiceover as vo  # noqa: E402
from voicelib import (VOICES, get_embedder, cluster, write_wav, actors, save_json, load_json)  # noqa: E402

SR = 16000


def play(path):
    try:
        import winsound
        winsound.PlaySound(str(path), winsound.SND_FILENAME)
    except Exception:
        print(f'  (пусни ръчно: {path})')


def load_audio(video):
    raw = vo.ff(['-i', str(video), '-map', '0:a:0', '-ac', '1', '-ar', str(SR), '-f', 'f32le', 'pipe:1'])
    return np.frombuffer(raw, dtype=np.float32)


def cue_segments(video, audio):
    srt = vo.find_srt(video)
    if not srt:
        return []
    out = []
    for c in vo.read_srt(srt):
        d = c['end'] - c['start']
        if d < 1.2:
            continue
        a, b = int(c['start'] * SR), int(c['end'] * SR)
        out.append(audio[a:b])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--episodes', type=int, default=6)
    ap.add_argument('--cluster-threshold', type=float, default=0.55)
    ap.add_argument('--min-seconds', type=float, default=60, help='минимум реч за герой')
    args = ap.parse_args()
    vo.FFMPEG = vo.find_ffmpeg()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')

    act = actors()
    trained = {k: v for k, v in act.items() if v.get('minutes', 0) >= 5}
    if not trained:
        sys.exit('Първо пусни STEP1 (събиране на гласовете).')

    videos = []
    for p in map(Path, args.paths):
        videos += sorted(f for f in p.rglob('*') if f.suffix.lower() in vo.VIDEO_EXT) if p.is_dir() else [p]
    videos = [v for v in videos if vo.find_srt(v)]
    if not videos:
        sys.exit('Няма епизоди с .srt субтитри.')
    if len(videos) > args.episodes:
        step = len(videos) / args.episodes
        videos = [videos[int(i * step)] for i in range(args.episodes)]

    print('Зареждам модела за гласове...')
    embed = get_embedder()
    segs, embs = [], []
    for k, v in enumerate(videos, 1):
        print(f'[{k}/{len(videos)}] {v.name}')
        audio = load_audio(v)
        for s in cue_segments(v, audio):
            segs.append(s); embs.append(embed(s))
    embs = np.stack(embs)
    labels = cluster(embs, args.cluster_threshold)

    chars = []
    for lab in set(labels):
        idx = np.where(labels == lab)[0]
        dur = sum(len(segs[i]) for i in idx) / SR
        if dur < args.min_seconds:
            continue
        cen = embs[idx].mean(0); cen /= np.linalg.norm(cen)
        f0s = [vo.median_f0(segs[i]) for i in idx[:40]]
        f0s = [f for f in f0s if f]
        chars.append({'idx': idx, 'centroid': cen, 'minutes': dur / 60, 'f0': float(np.median(f0s)) if f0s else 0})
    chars.sort(key=lambda c: -c['minutes'])

    sample_dir = VOICES / '_characters'
    sample_dir.mkdir(parents=True, exist_ok=True)
    for f in sample_dir.glob('*.wav'):
        f.unlink()

    names = sorted(trained, key=lambda k: trained[k]['num'])
    print('\nБългарски актьори:')
    for k in names:
        a = trained[k]
        print(f'  {a["num"]}: {"мъжки" if a["gender"] == "male" else "женски"} ({a["minutes"]} мин)   пример: ПРИМЕР_глас{a["num"]}_*.wav')

    result = []
    print(f'\nНамерих {len(chars)} гласа в оригинала. За всеки ще чуеш пример.')
    print('Напиши номера на българския актьор и Enter.  Само Enter = чуй пак.  0 = пропусни (ще се избере по пол).')
    print('Можеш да напишеш и p3, за да чуеш пак българския актьор 3.\n')
    for n, c in enumerate(chars, 1):
        cen = c['centroid']
        order = sorted(c['idx'], key=lambda i: -float(embs[i] @ cen))[:5]
        gap = np.zeros(int(SR * 0.4), dtype=np.float32)
        sample = sample_dir / f'герой{n}.wav'
        write_wav(sample, np.concatenate([p for i in order for p in (segs[i], gap)]), SR)
        gender = 'female' if c['f0'] >= 165 else 'male'
        print(f'Герой {n}: {c["minutes"]:.1f} мин реч, вероятно {"жена" if gender == "female" else "мъж"}. Слушай...')
        while True:
            play(sample)
            ans = input('  български актьор №: ').strip().lower()
            if ans.startswith('p') and ans[1:].isdigit():
                for k in names:
                    if trained[k]['num'] == int(ans[1:]):
                        f = next(VOICES.glob(f'ПРИМЕР_глас{ans[1:]}_*.wav'), None)
                        if f:
                            play(f)
                continue
            if ans == '':
                continue
            if ans.isdigit():
                num = int(ans)
                if num == 0:
                    break
                key = next((k for k in names if trained[k]['num'] == num), None)
                if key:
                    result.append({'character': n, 'actor': key, 'model': trained[key].get('model'), 'centroid': cen.round(5).tolist(), 'sample': sample.name})
                    print(f'  → герой {n} = актьор {num}')
                    break
            print('  Не разбрах. Напиши номер от списъка.')
    save_json(VOICES / 'characters.json', {'created': time.strftime('%Y-%m-%d %H:%M'), 'characters': result})
    print(f'\nЗаписано: {len(result)} героя. Сега пусни AI-voiceover-TEST-3min.bat.')


if __name__ == '__main__':
    main()
