# -*- coding: utf-8 -*-
"""Общи помощни функции: отпечатък на гласа (ECAPA), групиране, WAV, гласове на актьорите."""
import json, wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
VOICES = HERE / 'voices'


def get_embedder(cache_dir=None):
    """ECAPA модел на SpeechBrain: 192-мерен отпечатък на гласа (16 kHz моно)."""
    import torch
    from speechbrain.inference.speaker import EncoderClassifier
    from speechbrain.utils.fetching import LocalStrategy
    model = EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
                                           savedir=str(cache_dir or (VOICES / '_model')),
                                           run_opts={'device': 'cpu'}, local_strategy=LocalStrategy.COPY)

    def embed(x16):
        if len(x16) < 16000 * 0.8:
            x16 = np.pad(x16, (0, int(16000 * 0.8) - len(x16)))
        with torch.no_grad():
            e = model.encode_batch(torch.from_numpy(np.ascontiguousarray(x16)).float().unsqueeze(0)).squeeze().numpy()
        return e / (np.linalg.norm(e) + 1e-9)
    return embed


def cluster(emb, threshold):
    from scipy.cluster.hierarchy import linkage, fcluster
    if len(emb) < 2:
        return np.ones(len(emb), dtype=int)
    return fcluster(linkage(emb, method='average', metric='cosine'), t=threshold, criterion='distance')


def write_wav(path, x, sr):
    peak = float(np.max(np.abs(x))) if len(x) else 1.0
    x = x * min(1.0, 0.9 / (peak or 1.0))
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())


def read_wav(path):
    with wave.open(str(path)) as w:
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return x, sr


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return default


def save_json(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')


def actors():
    """Гласовете на българските актьори: {'glas1_male': {'gender':..,'f0_median':..,'minutes':..}, ...}"""
    return load_json(VOICES / 'stats.json', {})


def default_actor(gender):
    """Най-големият глас от дадения пол (за реплики, за които не знаем героя)."""
    a = [(k, v) for k, v in actors().items() if v.get('gender') == gender]
    return max(a, key=lambda kv: kv[1].get('minutes', 0))[0] if a else None
