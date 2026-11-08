#!/usr/bin/env bash
# Render the ProofBox demo video into ../docs/media (MP4 + poster + SRT).
# Prerequisites: npm install; public/audio from scripts/tts.py; public/clips from
# scripts/record-app.mjs + scripts/cut-clips.py. Needs ffmpeg.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=../docs/media
mkdir -p "$OUT" out
npx remotion render ProofBoxDemo out/raw.mp4 --codec=h264 --crf=23 --audio-codec=aac --log=error
# Loudness to -16 LUFS (web/YouTube norm); video stream copied as is.
ffmpeg -y -loglevel error -i out/raw.mp4 -c:v copy -af loudnorm=I=-16:TP=-1.5:LRA=11 -ar 48000 -c:a aac -b:a 160k "$OUT/proofbox-demo.mp4"
npx remotion still ProofBoxDemo "$OUT/proofbox-demo-poster.jpg" --frame=291 --image-format=jpeg --jpeg-quality=85 --log=error
python3 scripts/make-srt.py
ffprobe -v error -show_entries format=duration,size -of compact "$OUT/proofbox-demo.mp4"
