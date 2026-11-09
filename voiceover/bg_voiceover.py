# -*- coding: utf-8 -*-
"""
AI войсоувър на български: взима оригиналния епизод + български субтитри (.srt)
и прави допълнителна аудио пътечка  <епизод>.bg-ai.m4a  до видеото.
Кинотека я показва като аудио „БГ (AI войсоувър)“.

Как работи:
  1. Чете българските субтитри (UTF-8 или Windows-1251), разделя репликите "- ... - ...".
  2. По височината на гласа в оригинала познава дали говори мъж или жена.
  3. Генерира българска реч (Microsoft Edge гласове: Борислав / Калина), ускорява я,
     ако не се побира във времето на репликата.
  4. Смесва я върху оригинала, като го приглушава, докато се говори (като истински войсоувър).

Употреба:  python bg_voiceover.py <видео или папка> [още видеа...]
"""
import argparse, asyncio, json, os, re, shutil, subprocess, sys, tempfile, time, wave
from pathlib import Path

import numpy as np

VIDEO_EXT = {'.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.ts', '.webm'}
SR = 48000            # честота на генерираната реч
PITCH_SR = 16000      # за анализ на височината
MALE_VOICE = 'bg-BG-BorislavNeural'
FEMALE_VOICE = 'bg-BG-KalinaNeural'


def find_ffmpeg():
    cands = []
    la = os.environ.get('LOCALAPPDATA')
    if la:
        cands.append(Path(la) / 'Kinoteka' / 'resources' / 'bin' / 'ffmpeg.exe')
    for c in cands:
        if c.exists():
            return str(c)
    w = shutil.which('ffmpeg')
    if w:
        return w
    sys.exit('Не намирам ffmpeg. Инсталирай първо Кинотека (тя носи ffmpeg) или сложи ffmpeg в PATH.')


FFMPEG = None
NOWIN = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


def ff(args, inp=None):
    p = subprocess.run([FFMPEG, '-v', 'error', '-nostdin', '-y'] + args, input=inp,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NOWIN)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode('utf-8', 'replace')[-800:])
    return p.stdout


# ---------------- субтитри ----------------
def decode_text(b):
    if b.startswith(b'\xef\xbb\xbf'):
        return b[3:].decode('utf-8')
    if b.startswith(b'\xff\xfe'):
        return b[2:].decode('utf-16-le')
    try:
        return b.decode('utf-8')
    except UnicodeDecodeError:
        return b.decode('cp1251', 'replace')


def ptime(s):
    m = re.search(r'(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})', s)
    h, mi, se, ms = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(se) + int(ms.ljust(3, '0')) / 1000


def clean_line(t):
    t = re.sub(r'<[^>]+>', '', t)
    t = re.sub(r'\{[^}]*\}', '', t)
    t = re.sub(r'\[[^\]]*\]|\([A-ZА-Я ]+\)', '', t)  # [смях], (ВИКА)
    t = t.replace('♪', '').strip()
    return t


def read_srt(path):
    text = decode_text(Path(path).read_bytes()).replace('\r', '')
    cues = []
    for block in re.split(r'\n\s*\n', text):
        lines = block.strip().split('\n')
        idx = next((i for i, l in enumerate(lines) if '-->' in l), None)
        if idx is None:
            continue
        a, b = lines[idx].split('-->')
        start, end = ptime(a), ptime(b)
        body = [clean_line(l) for l in lines[idx + 1:]]
        body = [l for l in body if l]
        if not body:
            continue
        # Диалог в един субтитър: "- Здрасти.\n- Здрасти и на теб."
        if sum(1 for l in body if l.startswith('-')) >= 2:
            parts, cur = [], []
            for l in body:
                if l.startswith('-') and cur:
                    parts.append(' '.join(cur)); cur = []
                cur.append(l.lstrip('- ').strip())
            parts.append(' '.join(cur))
            total = sum(len(p) for p in parts) or 1
            t = start
            for p in parts:
                d = (end - start) * len(p) / total
                cues.append({'start': t, 'end': t + d, 'text': p})
                t += d
        else:
            cues.append({'start': start, 'end': end, 'text': ' '.join(l.lstrip('- ') for l in body)})
    cues = [c for c in cues if re.search(r'[\wА-Яа-я]', c['text'])]
    cues.sort(key=lambda c: c['start'])
    return cues


def find_srt(video):
    v = Path(video)
    base = v.stem.lower()
    cands = []
    for d in [v.parent, v.parent / 'Subs', v.parent / 'subs', v.parent / 'Subtitles']:
        if not d.is_dir():
            continue
        for f in d.iterdir():
            if f.suffix.lower() == '.srt' and (d != v.parent or f.stem.lower().startswith(base)):
                cands.append(f)
    if not cands:
        return None
    # предпочитаме файлове с bg/bul в името
    cands.sort(key=lambda f: (not re.search(r'(^|[._ -])(bg|bul|bulgarian)([._ -]|$)', f.stem.lower()), len(f.name)))
    return cands[0]


# ---------------- височина на гласа (мъж/жена) ----------------
def load_pitch_audio(video):
    raw = ff(['-i', str(video), '-map', '0:a:0', '-ac', '1', '-ar', str(PITCH_SR),
              '-af', 'highpass=f=70,lowpass=f=1000', '-f', 's16le', 'pipe:1'])
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def median_f0(sig):
    """Груба оценка на основния тон (Hz) чрез автокорелация по кадри."""
    frame, hop = 1024, 512
    lo, hi = int(PITCH_SR / 400), int(PITCH_SR / 70)
    f0s = []
    if len(sig) < frame:
        return None
    rms_all = np.sqrt(np.mean(sig ** 2)) + 1e-9
    for i in range(0, len(sig) - frame, hop):
        x = sig[i:i + frame]
        if np.sqrt(np.mean(x ** 2)) < rms_all * 0.6:
            continue
        x = x - x.mean()
        ac = np.fft.irfft(np.abs(np.fft.rfft(x, 2 * frame)) ** 2)[:frame]
        if ac[0] <= 0:
            continue
        ac = ac / ac[0]
        seg = ac[lo:hi]
        best = float(seg.max())
        if best < 0.45:
            continue
        # първият локален максимум близо до най-високия (избягва грешка с октава надолу)
        lag = lo + int(np.argmax(seg))
        for j in range(1, len(seg) - 1):
            if seg[j] >= 0.85 * best and seg[j] >= seg[j - 1] and seg[j] >= seg[j + 1]:
                lag = lo + j
                break
        if True:
            f0s.append(PITCH_SR / lag)
    if len(f0s) < 3:
        return None
    return float(np.median(f0s))


def assign_genders(cues, audio, threshold):
    last = 'm'
    for c in cues:
        a = int(c['start'] * PITCH_SR); b = int(c['end'] * PITCH_SR)
        f0 = median_f0(audio[a:b])
        c['f0'] = f0
        if f0 is None:
            c['gender'] = last
        else:
            c['gender'] = 'f' if f0 >= threshold else 'm'
        last = c['gender']


# ---------------- синтез на реч ----------------
async def tts_edge(text, voice, rate_pct):
    import edge_tts
    kw = {}
    proxy = os.environ.get('HTTPS_PROXY')
    if proxy:
        kw['proxy'] = proxy
    rate = f'{"+" if rate_pct >= 0 else ""}{int(rate_pct)}%'
    com = edge_tts.Communicate(text, voice, rate=rate, **kw)
    buf = bytearray()
    async for chunk in com.stream():
        if chunk['type'] == 'audio':
            buf.extend(chunk['data'])
    if not buf:
        raise RuntimeError('празен отговор от TTS')
    return bytes(buf)


async def tts_test(text, voice, rate_pct):
    """Тестов „глас“ без интернет: тон с дължина според текста (само за проверка)."""
    dur = max(0.4, len(text) * 0.065 / (1 + rate_pct / 100))
    t = np.arange(int(SR * dur)) / SR
    f = 120 if 'Borislav' in voice else 220
    x = (0.3 * np.sin(2 * np.pi * f * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))).astype(np.float32)
    return ff(['-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', 'pipe:0', '-f', 'mp3', 'pipe:1'], inp=x.tobytes())


def to_pcm(mp3, tempo=1.0):
    af = 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse'
    if tempo > 1.001:
        af += f',atempo={tempo:.3f}'
    raw = ff(['-i', 'pipe:0', '-ac', '1', '-ar', str(SR), '-af', af, '-f', 'f32le', 'pipe:1'], inp=mp3)
    return np.frombuffer(raw, dtype=np.float32)


async def synth_all(cues, engine, workers=4, log=print):
    tts = tts_edge if engine == 'edge' else tts_test
    sem = asyncio.Semaphore(workers)
    done = 0

    async def one(i, c):
        nonlocal done
        voice = FEMALE_VOICE if c['gender'] == 'f' else MALE_VOICE
        # колко време има: до края на репликата + малко до следващата
        nxt = cues[i + 1]['start'] if i + 1 < len(cues) else c['end'] + 2
        slot = max(0.6, min(c['end'] + 0.6, nxt) - c['start'] - 0.1)
        async with sem:
            for attempt in range(4):
                try:
                    mp3 = await tts(c['text'], voice, 8)
                    pcm = await asyncio.to_thread(to_pcm, mp3)
                    dur = len(pcm) / SR
                    if dur > slot * 1.05:
                        # не се побира → по-бързо говорене (до +45%), после леко ускоряване
                        need = dur / slot
                        rate = min(45, 8 + (need - 1) * 100)
                        mp3 = await tts(c['text'], voice, rate)
                        pcm = await asyncio.to_thread(to_pcm, mp3)
                        dur = len(pcm) / SR
                        if dur > slot * 1.05:
                            pcm = await asyncio.to_thread(to_pcm, mp3, min(1.25, dur / slot))
                    c['pcm'] = pcm
                    break
                except Exception as e:
                    if attempt == 3:
                        log(f'  ! реплика {i + 1} пропусната: {e}')
                        c['pcm'] = None
                    else:
                        await asyncio.sleep(1.5 * (attempt + 1))
        done += 1
        if done % 25 == 0 or done == len(cues):
            log(f'  реч: {done}/{len(cues)}')

    await asyncio.gather(*(one(i, c) for i, c in enumerate(cues)))


# ---------------- смесване ----------------
def build_speech_tracks(cues, total_dur, lag=0.2):
    """Отделна пътечка за всеки глас (актьор или пол), за да мине всяка през своя модел."""
    n = int((total_dur + 5) * SR)
    tracks = {}
    cursor = 0.0
    for c in cues:
        pcm = c.get('pcm')
        if pcm is None or not len(pcm):
            continue
        start = max(c['start'] + lag, cursor + 0.05)
        a = int(start * SR)
        b = min(n, a + len(pcm))
        if b <= a:
            continue
        key = c.get('actor') or c['gender']
        if key not in tracks:
            tracks[key] = np.zeros(n, dtype=np.float32)
        tracks[key][a:b] += pcm[:b - a]
        cursor = start + len(pcm) / SR
    return tracks


def assign_actors(cues, video, act):
    """Всяка реплика → български актьор: по героя (ако е направена стъпка 3), иначе по пол."""
    import voicelib
    chars = voicelib.load_json(voicelib.VOICES / 'characters.json', {}).get('characters', [])
    # само записи за текущите гласове (след ново събиране номерата се сменят)
    chars = [c for c in chars if c['actor'] in act and c.get('model') == act[c['actor']].get('model')]
    for c in cues:
        c['actor'] = voicelib.default_actor('female' if c['gender'] == 'f' else 'male')
    if chars:
        try:
            embed = voicelib.get_embedder()
        except Exception as e:
            print(f'  ! не мога да заредя разпознаването на герои ({e}) — разпределям само по пол')
            embed = None
        if embed:
            raw = ff(['-i', str(video), '-map', '0:a:0', '-ac', '1', '-ar', str(PITCH_SR), '-f', 'f32le', 'pipe:1'])
            audio = np.frombuffer(raw, dtype=np.float32)
            cents = np.array([c['centroid'] for c in chars])
            hits = 0
            for c in cues:
                seg = audio[int(c['start'] * PITCH_SR):int(c['end'] * PITCH_SR)]
                if len(seg) < PITCH_SR * 0.5:
                    continue
                sims = cents @ embed(seg)
                j = int(np.argmax(sims))
                if sims[j] >= 0.35:
                    c['actor'] = chars[j]['actor']; c['character'] = chars[j]['character']; hits += 1
            print(f'  разпознати герои: {hits}/{len(cues)} реплики (останалите — по пол)')
    for c in cues:
        if c.get('actor') in act:
            c['gender'] = 'f' if act[c['actor']]['gender'] == 'female' else 'm'
    counts = {}
    for c in cues:
        counts[c.get('actor')] = counts.get(c.get('actor'), 0) + 1
    print('  реплики по актьор: ' + ', '.join(f'{k}: {v}' for k, v in counts.items()))


def normalize(x, peak_to=0.89):
    peak = float(np.max(np.abs(x))) or 1.0
    return x * min(1.0, peak_to / peak) if peak > peak_to else x


# ---------------- гласове от дублажа (Applio / RVC) ----------------
def applio_dir():
    import os
    for c in [os.environ.get('APPLIO_DIR'), str(Path.home() / 'Applio')]:
        if c and (Path(c) / 'core.py').exists() and (Path(c) / 'env' / 'python.exe').exists():
            return Path(c)
    return None


def find_voice_model(applio, name):
    d = applio / 'logs' / name
    if not d.is_dir():
        return None
    pths = [f for f in d.rglob('*.pth') if not re.match(r'^[GD]_', f.name)]
    idx = list(d.rglob('*.index'))
    if not pths or not idx:
        return None
    pth = max(pths, key=lambda f: f.stat().st_mtime)
    return pth, idx[0]


def track_f0(x):
    """Медиана на основния тон на цяла пътечка (за автоматично нагласяне на височината)."""
    sig = vo_resample(x, SR, PITCH_SR)
    vals = []
    step = PITCH_SR * 3
    for i in range(0, len(sig) - step, step):
        f = median_f0(sig[i:i + step])
        if f:
            vals.append(f)
        if len(vals) > 60:
            break
    return float(np.median(vals)) if vals else None


def vo_resample(x, sr_in, sr_out):
    raw = ff(['-f', 'f32le', '-ar', str(sr_in), '-ac', '1', '-i', 'pipe:0', '-ar', str(sr_out), '-f', 'f32le', 'pipe:1'], inp=x.astype(np.float32).tobytes())
    return np.frombuffer(raw, dtype=np.float32)


def rvc_convert(x, applio, model, target_f0, workdir, label):
    """Пуска пътечката през обучения глас. Връща нова пътечка със същата дължина."""
    pth, index = model
    src = Path(workdir) / f'{label}_in.wav'
    dst = Path(workdir) / f'{label}_out.wav'
    write_wav(src, normalize(x))
    shift = 0
    sf0 = track_f0(x)
    if sf0 and target_f0:
        shift = int(round(12 * np.log2(target_f0 / sf0)))
        shift = max(-12, min(12, shift))
    print(f'  глас {label}: модел {pth.name}, височина {shift:+d} полутона')
    cmd = [str(applio / 'env' / 'python.exe'), 'core.py', 'infer', '--input-path', str(src), '--output-path', str(dst),
           '--pth-path', str(pth), '--index-path', str(index), '--pitch', str(shift), '--f0-method', 'rmvpe',
           '--index-rate', '0.5', '--protect', '0.33', '--volume-envelope', '1.0', '--export-format', 'WAV']
    p = subprocess.run(cmd, cwd=str(applio), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=NOWIN)
    if p.returncode != 0 or not dst.exists():
        print(p.stdout.decode('utf-8', 'replace')[-1500:])
        raise RuntimeError('Applio не успя да превърне гласа (виж текста отгоре)')
    raw = ff(['-i', str(dst), '-ac', '1', '-ar', str(SR), '-f', 'f32le', 'pipe:1'])
    y = np.frombuffer(raw, dtype=np.float32).copy()
    out = np.zeros_like(x)
    out[:min(len(x), len(y))] = y[:len(x)]
    return out


def read_wav_mono(path):
    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def write_wav(path, x):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())


MIX_TAG = 'kinoteka-mix-v2'
ENV_SR = 1000   # честота на кривата за приглушаване


def duck_envelope(speech, duck_db):
    # 1.0 където няма реч, 10^(-dB/20) докато звучи българската реч, с плавни преходи
    hop = SR // ENV_SR
    n = len(speech) // hop
    if n == 0:
        return np.ones(1, np.float32)
    rms = np.sqrt(np.mean(speech[:n * hop].reshape(n, hop) ** 2, axis=1))
    win = 10  # 10 ms
    k = np.convolve(rms, np.ones(win) / win, mode='same')
    act = k > 0.01
    # запълваме кратките паузи между думите (до 0.7 с), за да не "помпа"
    idx = np.flatnonzero(act)
    if len(idx):
        gaps = np.flatnonzero(np.diff(idx) > 1)
        for g in gaps:
            a, b = idx[g], idx[g + 1]
            if b - a <= int(0.7 * ENV_SR):
                act[a:b] = True
    low = 10 ** (-duck_db / 20)
    target = np.where(act, low, 1.0).astype(np.float32)
    # бързо надолу (започва 150 ms преди репликата), бавно нагоре (400 ms след нея)
    env = target.tolist()
    down = (1 - low) / (0.15 * ENV_SR)
    up = (1 - low) / (0.4 * ENV_SR)
    for i in range(len(env) - 2, -1, -1):
        if env[i] > env[i + 1] + down:
            env[i] = env[i + 1] + down
    for i in range(1, len(env)):
        if env[i] > env[i - 1] + up:
            env[i] = env[i - 1] + up
    env = np.array(env, np.float32)
    return np.clip(env, low, 1.0)


def write_env(path, env):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(ENV_SR)
        w.writeframes((np.clip(env, 0, 1) * 32767).astype(np.int16).tobytes())


def mix(video, speech_wav, env_wav, out):
    # Оригиналът се умножава по кривата (приглушава се, докато говори българският глас), после се смесва.
    filt = (f'[0:a:0]aformat=channel_layouts=stereo,aresample={SR}[orig];'
            f'[2:a]aresample={SR},aformat=channel_layouts=stereo,apad[env];'
            f'[orig][env]amultiply[duck];'
            f'[1:a]aformat=channel_layouts=stereo,apad[vo];'
            f'[duck][vo]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]')
    ff(['-i', str(video), '-i', str(speech_wav), '-i', str(env_wav), '-filter_complex', filt, '-map', '[out]',
        '-c:a', 'aac', '-b:a', '192k', '-metadata', f'comment={MIX_TAG}', '-metadata:s:a:0', 'language=bul',
        '-metadata:s:a:0', 'title=БГ (AI войсоувър)', str(out)])


def speech_cache(video):
    d = Path(__file__).parent / 'voices' / '_speech'
    return d / (re.sub(r'[^\w.-]+', '_', video.stem) + '.flac')


def duration_of(video):
    out = subprocess.run([FFMPEG, '-i', str(video)], stderr=subprocess.PIPE, stdout=subprocess.PIPE, creationflags=NOWIN).stderr.decode('utf-8', 'replace')
    m = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)', out)
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]) if m else 0


def has_new_mix(f):
    out = subprocess.run([FFMPEG, '-i', str(f)], stderr=subprocess.PIPE, stdout=subprocess.PIPE, creationflags=NOWIN).stderr.decode('utf-8', 'replace')
    return MIX_TAG in out


# ---------------- основно ----------------
def process(video, args):
    video = Path(video)
    out = video.with_name(video.stem + '.bg-ai.m4a')
    if out.exists() and not args.force:
        # пробен файл (само първите минути) не се брои за готов
        if duration_of(out) >= duration_of(video) * 0.9 and has_new_mix(out):
            print(f'= {video.name}: вече има {out.name} (пусни с --force за наново)')
            return True
    srt = Path(args.srt) if args.srt else find_srt(video)
    if not srt:
        print(f'! {video.name}: няма български субтитри (.srt) до видеото — пропускам.')
        return False
    t0 = time.time()
    cache = speech_cache(video)
    if cache.exists() and not args.limit and not args.resynth:
        # речта вече е генерирана -> само смесваме наново (секунди)
        print(f'\n▶ {video.name}: смесвам наново готовата реч (оригинал -{args.duck:g} dB)')
        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / 'speech.wav'
            ff(['-i', str(cache), '-ac', '1', '-ar', str(SR), str(wav)])
            env = Path(td) / 'env.wav'
            write_env(env, duck_envelope(read_wav_mono(wav), args.duck))
            tmp_out = Path(td) / 'out.m4a'
            mix(video, wav, env, tmp_out)
            shutil.move(str(tmp_out), str(out))
        print(f'✓ готово за {int(time.time() - t0)} сек → {out.name}')
        return True
    print(f'\n▶ {video.name}\n  субтитри: {srt.name}')
    cues = read_srt(srt)
    if args.limit:
        cues = [c for c in cues if c['start'] < args.limit]
    print(f'  реплики: {len(cues)}')
    audio = load_pitch_audio(video)
    assign_genders(cues, audio, args.threshold)
    del audio
    nf = sum(1 for c in cues if c['gender'] == 'f')
    print(f'  мъжки: {len(cues) - nf}, женски: {nf}')
    act = {}
    if not args.no_voices:
        import voicelib
        act = voicelib.actors()
        if act:
            assign_actors(cues, video, act)
    asyncio.run(synth_all(cues, args.engine, args.workers))
    total = duration_of(video)
    if args.limit:
        total = min(total, args.limit + 10)
    tracks = build_speech_tracks(cues, total)
    with tempfile.TemporaryDirectory() as td:
        if act:
            applio = applio_dir()
            done_any = False
            for key in list(tracks):
                mname = act.get(key, {}).get('model') or f'tbbt_bg_{key}'
                model = find_voice_model(applio, mname) if applio else None
                if model:
                    if not done_any:
                        print('  превръщам в гласовете от дублажа...')
                        done_any = True
                    tracks[key] = rvc_convert(tracks[key], applio, model, act.get(key, {}).get('f0_median'), td, key)
            if not done_any:
                print('  (гласовете още не са обучени — ползвам гласовете на Microsoft)')
        speech = normalize(sum(tracks.values()))
        wav = Path(td) / 'speech.wav'
        write_wav(wav, speech)
        env = Path(td) / 'env.wav'
        write_env(env, duck_envelope(speech, args.duck))
        if not args.limit:
            cache.parent.mkdir(parents=True, exist_ok=True)
            ff(['-i', str(wav), '-c:a', 'flac', str(cache)])
        tmp_out = Path(td) / 'out.m4a'
        if args.limit:
            # за проба: само първите N секунди
            clip = Path(td) / 'clip.mkv'
            ff(['-i', str(video), '-t', str(args.limit + 10), '-map', '0:a:0', '-c', 'copy', str(clip)])
            mix(clip, wav, env, tmp_out)
        else:
            mix(video, wav, env, tmp_out)
        shutil.move(str(tmp_out), str(out))
    print(f'✓ готово за {int(time.time() - t0)} сек → {out.name}')
    return True


def main():
    global FFMPEG
    ap = argparse.ArgumentParser(description='AI войсоувър на български от .srt субтитри')
    ap.add_argument('paths', nargs='+', help='видео файлове или папки')
    ap.add_argument('--srt', help='конкретен .srt файл (само при един епизод)')
    ap.add_argument('--threshold', type=float, default=165, help='Hz над които гласът се смята за женски (по подразбиране 165)')
    ap.add_argument('--duck', type=float, default=20, help='с колко dB да се приглуши оригиналът, докато говори гласът (20 dB = с 90%% по-тихо)')
    ap.add_argument('--resynth', action='store_true', help='генерирай речта наново, дори ако е запазена')
    ap.add_argument('--limit', type=float, default=0, help='само първите N секунди (за бърза проба)')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--engine', default='edge', choices=['edge', 'test'])
    ap.add_argument('--force', action='store_true', help='прави наново, дори ако вече има .bg-ai.m4a')
    ap.add_argument('--no-voices', action='store_true', help='не ползвай обучените гласове от дублажа')
    args = ap.parse_args()
    FFMPEG = find_ffmpeg()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    videos = []
    for p in args.paths:
        p = Path(p)
        if p.is_dir():
            videos += sorted(f for f in p.rglob('*') if f.suffix.lower() in VIDEO_EXT and '.bg-ai' not in f.name)
        elif p.suffix.lower() in VIDEO_EXT:
            videos.append(p)
    if not videos:
        sys.exit('Не намерих видеофайлове.')
    ok = 0
    for v in videos:
        try:
            ok += bool(process(v, args))
        except Exception as e:
            print(f'! {v.name}: грешка: {e}')
    print(f'\nГотови: {ok}/{len(videos)}')


if __name__ == '__main__':
    main()
