#!/usr/bin/env python3
"""Measure TitaNet embeddings on synthetic Russian voices, never live audio."""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from nemo.collections.asr.models import EncDecSpeakerLabelModel


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, default=Path(".test-output/speaker-recognition"))
    parser.add_argument("--model", default="titanet_large")
    parser.add_argument("--seconds", type=float, default=8)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--quality", action="store_true", help="Also exercise the real bundled Silero quality gate")
    parser.add_argument("--model-path", type=Path, help="Optional offline .nemo file for the quality gate")
    args = parser.parse_args()
    torch.set_num_threads(2)
    begin = time.monotonic()
    model = EncDecSpeakerLabelModel.from_pretrained(args.model, map_location="cpu").eval()
    loaded = time.monotonic() - begin
    manifest = json.loads((args.fixtures / "fixtures.json").read_text())
    vectors, timings = {}, {}
    for name, fixture in manifest["utterances"].items():
        audio, rate = sf.read(args.fixtures / fixture["file"], dtype="float32")
        assert rate == 16000 and audio.ndim == 1
        audio = audio[int(.5 * rate):int((.5 + args.seconds) * rate)]
        start = time.monotonic()
        # This is the in-memory API used by the live backend: no temp recording.
        embedding, _ = model.infer_segment(audio)
        vector = embedding.squeeze().detach().cpu().numpy()
        assert vector.shape == (192,) and np.isfinite(vector).all()
        vectors[name] = vector / np.linalg.norm(vector)
        timings[name] = {"seconds": time.monotonic() - start, "audio_seconds": len(audio) / rate}
    names = list(vectors)
    similarities = {a: {b: round(float(np.dot(vectors[a], vectors[b])), 5) for b in names} for a in names}
    result = {"synthetic_only": True, "model": args.model, "language": "ru", "device": "cpu", "torch_threads": 2,
              "load_seconds": loaded, "parameter_count": sum(p.numel() for p in model.parameters()),
              "embedding_dimensions": 192, "inference": timings, "cosine_similarities": similarities}
    if args.quality:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from server.speakers import SpeakerError, TitaNetEncoder
        if args.model_path:
            os.environ["SPEAKER_MODEL_PATH"] = str(args.model_path)
        encoder = TitaNetEncoder()
        quality = {}
        for name, samples in {
            "silence": np.zeros(8 * 16000, dtype=np.float32),
            "white_noise": np.random.default_rng(42).normal(0, .05, 8 * 16000).astype(np.float32),
        }.items():
            try:
                encoder(samples)
            except SpeakerError as error:
                quality[name] = {"rejected": True, "message": str(error)}
            else:
                raise AssertionError(f"The real quality gate accepted {name}")
        clean, rate = sf.read(args.fixtures / "milena-enroll.wav", dtype="float32")
        clean_vector = encoder(clean[8000:8000 + 8 * rate])
        assert clean_vector.shape == (192,) and np.isfinite(clean_vector).all()
        quality["clean_russian_speech"] = {"accepted": True, "dimensions": len(clean_vector)}
        result["actual_quality_gate"] = quality
    output = args.output or args.fixtures / "embedding-results.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
