"""Cut public/clips/app-raw.webm into one MP4 per live scene, fitted to the voiceover.

Run from video/ after scripts/tts.py and scripts/record-app.mjs:
  python3 scripts/cut-clips.py
Each clip lasts VO + LEAD + TAIL seconds: a long segment is sped up, a short one is
slowed a little (at most 1.25x) and then holds its last frame.
"""
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEAD, TAIL = 0.6, 0.8
marks = json.loads((ROOT / "public/clips/marks.json").read_text())
vo = json.loads((ROOT / "src/vo-durations.json").read_text())
raw = ROOT / "public/clips/app-raw.webm"
fitted = {}
for scene, m in marks.items():
    length = m["end"] - m["start"]
    target = round(vo[scene] + LEAD + TAIL, 2)
    stretch = min(target / length, 1.25)  # >1 slows down, <1 speeds up
    played = length * stretch
    hold = max(0.0, target - played)
    vf = f"setpts={stretch:.4f}*(PTS-STARTPTS),scale=1920:1080:flags=lanczos,fps=30"
    if hold > 0:
        vf += f",tpad=stop_mode=clone:stop_duration={hold:.3f}"
    out = ROOT / f"public/clips/{scene}.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{m['start']:.3f}", "-t", f"{length:.3f}", "-i", str(raw),
         "-vf", vf, "-t", f"{target:.3f}", "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(out)],
        check=True,
    )
    fitted[scene] = target
    print(f"{scene:8s} segment {length:5.2f}s x{stretch:.2f} hold {hold:4.2f}s -> {target:5.2f}s")
(ROOT / "src/clip-durations.json").write_text(json.dumps(fitted, indent=2) + "\n")
