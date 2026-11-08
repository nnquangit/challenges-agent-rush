"""Generate the voiceover with Kokoro-82M (Apache-2.0, runs locally).

Run from video/:
  uv run --python 3.12 --with kokoro --with soundfile python scripts/tts.py

Reads narration.json, writes public/audio/vo-<id>.mp3 and src/vo-durations.json.
Needs ffmpeg on PATH. The model is downloaded once from Hugging Face (hexgrad/Kokoro-82M).
"""
import json
import pathlib
import subprocess

import numpy as np
import soundfile as sf
from kokoro import KPipeline

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = json.loads((ROOT / "narration.json").read_text())
out_dir = ROOT / "public" / "audio"
out_dir.mkdir(parents=True, exist_ok=True)

pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
durations = {}
for scene in spec["scenes"]:
    chunks = [audio for _, _, audio in pipeline(scene["text"], voice=spec["voice"], speed=spec["speed"])]
    wav = np.concatenate(chunks)
    wav_path = out_dir / f"vo-{scene['id']}.wav"
    mp3_path = out_dir / f"vo-{scene['id']}.mp3"
    sf.write(wav_path, wav, 24000)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path), "-codec:a", "libmp3lame", "-b:a", "160k", str(mp3_path)],
        check=True,
    )
    wav_path.unlink()
    durations[scene["id"]] = round(len(wav) / 24000, 3)
    print(f"{scene['id']:10s} {durations[scene['id']]:6.2f}s")

(ROOT / "src" / "vo-durations.json").write_text(json.dumps(durations, indent=2) + "\n")
print(f"total {sum(durations.values()):.1f}s")
