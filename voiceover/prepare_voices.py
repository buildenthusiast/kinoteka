# -*- coding: utf-8 -*-
"""
Стъпка 1 от гласовете: от епизоди с български войсоувър изрязва репликите на
българските актьори и ги групира ПО АКТЬОР (по тембъра на гласа, не само по височина).

  1. Намира речта и пази само репликите на български (английският оригинал отпада).
  2. Изчислява „отпечатък на гласа“ за всяка реплика и групира еднаквите гласове.
  3. Най-големият мъжки глас → voices\\male, най-големият женски → voices\\female.
     Останалите гласове отиват в voices\\other\\... (можеш да ги размениш ръчно).
  За всеки глас прави и кратък пример voices\\ПРИМЕР_*.wav за слушане.
"""
import argparse, json, re, shutil, subprocess, sys, wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import bg_voiceover as vo  # noqa: E402

SR_OUT = 40000


def audio_tracks(video):
    out = subprocess.run([vo.FFMPEG, '-i', str(video)], stderr=subprocess.PIPE, stdout=subprocess.PIPE,
                         creationflags=vo.NOWIN).stderr.decode('utf-8', 'replace')
    return re.findall(r'Stream #0:\d+(?:\((\w+)\))?.*?: Audio:', out)


def pick_track(video):
    langs = audio_tracks(video)
    for i, l in enumerate(langs):
        if l and l.lower() in ('bul', 'bg'):
            return i
    return 0


def load(video, track, sr):
    raw = vo.ff(['-i', str(video), '-map', f'0:a:{track}', '-ac', '1', '-ar', str(sr), '-f', 'f32le', 'pipe:1'])
    return np.frombuffer(raw, dtype=np.float32)


from voicelib import get_embedder, cluster, write_wav, read_wav  # noqa: E402


def collect_videos(paths):
    videos = []
    for p in map(Path, paths):
        if p.is_dir():
            videos += sorted(f for f in p.rglob('*') if f.suffix.lower() in vo.VIDEO_EXT and '.bg-ai' not in f.name)
        elif p.suffix.lower() in vo.VIDEO_EXT:
            videos.append(p)
    # ако някои са с БГ аудио (BGAUDiO, dub…) в името, взимаме само тях
    bgdub = [v for v in videos if re.search(r'bg[ ._-]?audio|bgdub|bg[ ._-]?dub|дублаж', str(v), re.I)]
    return bgdub or videos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--out', default=str(Path(__file__).parent / 'voices'))
    ap.add_argument('--episodes', type=int, default=60, help='колко епизода да изслуша (разпределени равномерно)')
    ap.add_argument('--min-bg', type=float, default=0.4)
    ap.add_argument('--cluster-threshold', type=float, default=0.65, help='по-малко = по-строго разделяне на гласовете')
    ap.add_argument('--gender-threshold', type=float, default=165)
    ap.add_argument('--minutes', type=float, default=40, help='максимум минути за един глас')
    args = ap.parse_args()
    vo.FFMPEG = vo.find_ffmpeg()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')

    out = Path(args.out)
    cand_dir = out / '_candidates'
    cand_dir.mkdir(parents=True, exist_ok=True)
    meta_path = out / '_candidates.json'
    meta = json.loads(meta_path.read_text(encoding='utf-8')) if meta_path.exists() else {'done': [], 'clips': []}
    if meta.get('min_bg') != args.min_bg:
        # с нови настройки събираме наново (иначе старите пропуснати реплики няма да се върнат)
        shutil.rmtree(cand_dir, ignore_errors=True); cand_dir.mkdir(parents=True, exist_ok=True)
        meta = {'done': [], 'clips': [], 'min_bg': args.min_bg}
        (out / '_embeddings.npy').unlink(missing_ok=True)

    videos = collect_videos(args.paths)
    if len(videos) > args.episodes:
        step = len(videos) / args.episodes
        videos = [videos[int(i * step)] for i in range(args.episodes)]
    print(f'Епизоди за изслушване: {len(videos)}')

    # ---- 1. реплики на български ----
    todo = [v for v in videos if str(v) not in meta['done']]
    if todo:
        from faster_whisper import WhisperModel
        from faster_whisper.vad import get_speech_timestamps, VadOptions
        print('Зареждам модела за разпознаване на език (първия път се тегли ~150 MB)...')
        wm = WhisperModel('base', device='cpu', compute_type='int8')
        for k, v in enumerate(todo, 1):
            track = pick_track(v)
            print(f'\n[{k}/{len(todo)}] {v.name}  (аудио пътечка {track})')
            try:
                a16 = load(v, track, 16000)
                a40 = load(v, track, SR_OUT)
            except Exception as e:
                print(f'  ! не мога да прочета звука: {e}')
                meta['done'].append(str(v)); continue
            segs = get_speech_timestamps(a16, VadOptions(min_speech_duration_ms=1500, max_speech_duration_s=8,
                                                        min_silence_duration_ms=200, speech_pad_ms=60))
            kept = 0
            for n, s in enumerate(segs):
                seg16 = a16[s['start']:s['end']]
                dur = len(seg16) / 16000
                if dur < 1.5:
                    continue
                _, _, probs = wm.detect_language(audio=seg16)
                if dict(probs).get('bg', 0.0) < args.min_bg:
                    continue
                f0 = vo.median_f0(seg16)
                name = f'{re.sub(r"[^A-Za-z0-9]+", "_", v.stem)[:40]}_{n:04d}.wav'
                a = int(s['start'] * SR_OUT / 16000); b = int(s['end'] * SR_OUT / 16000)
                write_wav(cand_dir / name, a40[a:b], SR_OUT)
                meta['clips'].append({'file': name, 'dur': round(dur, 2), 'f0': f0})
                kept += 1
            meta['done'].append(str(v))
            meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding='utf-8')
            print(f'  български реплики: {kept}  (общо {len(meta["clips"])}, {sum(c["dur"] for c in meta["clips"]) / 60:.0f} мин)')

    clips = [c for c in meta['clips'] if (cand_dir / c['file']).exists()]
    if len(clips) < 10:
        sys.exit('Твърде малко български реплики. Провери дали избраните папки са с български дублаж.')

    # ---- 2. отпечатък на гласа и групиране ----
    print(f'\nРазпознавам гласовете в {len(clips)} реплики (няколко минути)...')
    embed = get_embedder(out / '_model')
    emb_path = out / '_embeddings.npy'
    emb = None
    if emb_path.exists():
        e = np.load(emb_path)
        if len(e) == len(clips):
            emb = e
    if emb is None:
        rows = []
        for i, c in enumerate(clips):
            x, sr = read_wav(cand_dir / c['file'])
            x16 = vo.vo_resample(x, sr, 16000) if sr != 16000 else x
            rows.append(embed(x16))
            if (i + 1) % 100 == 0:
                print(f'  {i + 1}/{len(clips)}')
        emb = np.stack(rows)
        np.save(emb_path, emb)
    labels = cluster(emb, args.cluster_threshold)

    groups = []
    for lab in set(labels):
        idx = np.where(labels == lab)[0]
        total = sum(clips[i]['dur'] for i in idx)
        if total < 30:  # под половин минута — шум, смях, случайни
            continue
        cen = emb[idx].mean(0); cen /= np.linalg.norm(cen)
        sims = emb[idx] @ cen
        idx = idx[sims >= 0.45]  # махаме репликите, които не приличат на останалите
        f0s = [clips[i]['f0'] for i in idx if clips[i]['f0']]
        f0 = float(np.median(f0s)) if f0s else 0
        groups.append({'idx': idx, 'minutes': sum(clips[i]['dur'] for i in idx) / 60, 'f0': f0,
                       'gender': 'female' if f0 >= args.gender_threshold else 'male'})
    groups.sort(key=lambda g: -g['minutes'])
    for k, g in enumerate(groups, 1):
        g['num'] = k
    # Мъж/жена: войсоувър актьорите говорят високо, затова не ползваме фиксиран праг,
    # а търсим най-голямата „дупка“ във височината между гласовете.
    big = sorted(g['f0'] for g in groups if g['minutes'] >= 3 and g['f0'])
    if len(big) >= 2:
        gaps = [(big[i + 1] - big[i], (big[i + 1] + big[i]) / 2) for i in range(len(big) - 1)]
        gap, mid = max(gaps)
        if gap >= 25:
            for g in groups:
                g['gender'] = 'female' if g['f0'] >= mid else 'male'
            print(f'Граница мъж/жена: ~{mid:.0f} Hz')

    # ---- ръчни поправки от ГЛАСОВЕ.txt: "1: мъж", "3: = 1" (същият като 1), "7: махни" ----
    fix_path = out / 'ГЛАСОВЕ.txt'
    fixes = {}
    if fix_path.exists():
        for line in fix_path.read_text(encoding='utf-8-sig').splitlines():
            m = re.match(r'\s*(\d+)\s*[:.-]\s*(.*)', line)
            if not m or line.strip().startswith('#'):
                continue
            n, rest = int(m[1]), m[2].lower()
            f = {}
            if re.search(r'\bмъж|\bmale|\bm\b', rest): f['gender'] = 'male'
            if re.search(r'\bжена|\bfemale|\bf\b', rest): f['gender'] = 'female'
            mm = re.search(r'=\s*(\d+)', rest)
            if mm: f['merge'] = int(mm[1])
            if re.search(r'махни|изтрий|remove|\bx\b', rest): f['remove'] = True
            fixes[n] = f
    if fixes:
        bynum = {g['num']: g for g in groups}
        for n, f in fixes.items():
            g = bynum.get(n)
            if not g:
                continue
            if f.get('remove'):
                g['removed'] = True
            elif f.get('merge') in bynum and f['merge'] != n:
                t = bynum[f['merge']]
                t['idx'] = np.concatenate([t['idx'], g['idx']]); t['minutes'] += g['minutes']
                g['removed'] = True
            if f.get('gender'):
                g['gender'] = f['gender']
        for g in groups:
            if fixes.get(g['num'], {}).get('gender'):
                g['gender'] = fixes[g['num']]['gender']
        groups = [g for g in groups if not g.get('removed')]
        print(f'Приложени ръчни поправки от {fix_path.name}: {len(fixes)}')

    # ---- 3. папки: всеки актьор отделно ----
    for d in list(out.glob('glas*')) + [out / 'male', out / 'female', out / 'other']:
        if d.is_dir():
            shutil.rmtree(d)
    for f in out.glob('ПРИМЕР_*.wav'):
        f.unlink()
    stats = {}
    print('\nНамерени гласове (актьори):')
    for g in groups:
        k = g['num']
        gname = 'мъжки' if g['gender'] == 'male' else 'женски'
        key = f'glas{k}_{g["gender"]}'
        dest = out / key
        dest.mkdir(parents=True, exist_ok=True)
        budget = args.minutes * 60
        cen = emb[g['idx']].mean(0)
        chosen = sorted(g['idx'], key=lambda i: -float(emb[i] @ cen))
        used = 0
        for i in chosen:
            if used >= budget:
                break
            shutil.copy(cand_dir / clips[i]['file'], dest / clips[i]['file'])
            used += clips[i]['dur']
        parts = [read_wav(cand_dir / clips[i]['file'])[0] for i in chosen[:6]]
        gap = np.zeros(int(SR_OUT * 0.5), dtype=np.float32)
        write_wav(out / f'ПРИМЕР_глас{k}_{gname}.wav', np.concatenate([p for x in parts for p in (x, gap)]), SR_OUT)
        import hashlib
        h = hashlib.sha1('|'.join(sorted(f.name for f in dest.glob('*.wav'))).encode()).hexdigest()[:8]
        stats[key] = {'num': k, 'gender': g['gender'], 'minutes': round(used / 60, 1), 'f0_median': g['f0'],
                      'model': f'tbbt_{key}_{h}'}
        note = '' if used >= 5 * 60 else '  (под 5 мин — няма да се обучава)'
        print(f'  глас {k}: {gname}, {used / 60:.1f} мин, височина ~{g["f0"]:.0f} Hz{note}')
    (out / 'stats.json').write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding='utf-8')
    if not fix_path.exists():
        lines = ['# Чуй ПРИМЕР_глас*.wav и поправи, ако трябва. После пусни STEP1 пак (ще е бързо).',
                 '#   1: мъж        - гласът е мъжки',
                 '#   3: = 1        - глас 3 е същият актьор като глас 1 (сливат се)',
                 '#   7: махни      - не е актьор (смях, английски, шум)', '']
        lines += [f'{g["num"]}: {"мъж" if g["gender"] == "male" else "жена"}' for g in groups]
        fix_path.write_text('\n'.join(lines) + '\n', encoding='utf-8-sig')
    print(f'\nПапка: {out}')
    print('Чуй файловете ПРИМЕР_глас*.wav: всеки трябва да е един и същи актьор.')
    print('Ако един актьор е разделен на два гласа или двама са в един, кажи ми номерата.')


if __name__ == '__main__':
    main()
