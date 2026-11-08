"""Write ../docs/media/proofbox-demo.srt (upload sites) and .vtt (browser <track>) from narration.json and the scene timing.

Run from video/ after rendering: python3 scripts/make-srt.py
Sentence timing inside each voiceover is estimated from character counts.
"""
import json, math, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
FPS, LEAD, TAIL, OUTRO = 30, 0.6, 1.0, 6
spec = json.loads((ROOT / "narration.json").read_text())
vo = json.loads((ROOT / "src/vo-durations.json").read_text())
clips = json.loads((ROOT / "src/clip-durations.json").read_text())

def ts(t):
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"

cues, start = [], 0.0
for scene in spec["scenes"]:
    sid = scene["id"]
    frames = math.ceil(OUTRO * FPS) if sid == "outro" else math.ceil((clips.get(sid) or vo[sid] + LEAD + TAIL) * FPS)
    # Spoken spellings back to written form for the captions.
    text = scene["text"].replace("E D two five five one nine", "Ed25519").replace("G Visor", "gVisor").replace("Vulture", "Vultr")
    parts = [p for p in re.split(r"(?<=[.:?!])\s+", text) if p]
    total = sum(len(p) for p in parts)
    t = start + LEAD
    for p in parts:
        d = vo[sid] * len(p) / total
        cues.append((t, t + d, p))
        t += d
    start += frames / FPS

out = ROOT.parent / "docs/media/proofbox-demo.srt"
out.write_text("".join(f"{i}\n{ts(a)} --> {ts(b)}\n{txt}\n\n" for i, (a, b, txt) in enumerate(cues, 1)))
vtt = "WEBVTT\n\n" + "".join(f"{i}\n{ts(a).replace(',', '.')} --> {ts(b).replace(',', '.')}\n{txt}\n\n" for i, (a, b, txt) in enumerate(cues, 1))
out.with_suffix(".vtt").write_text(vtt)
print(f"{len(cues)} cues, ends {ts(cues[-1][1])}")
