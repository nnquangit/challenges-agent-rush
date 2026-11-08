# ProofBox demo video (Remotion)

Composition `ProofBoxDemo` · 1920×1080 · 30 fps · about 2:37 · output in `../docs/media/`
(`proofbox-demo.mp4`, `proofbox-demo-poster.jpg`, `proofbox-demo.srt`).

Scenes: title → problem → approach → what is simulated → 4 live parts recorded from the mock app
(Prove-It Python, containment probes, CSV Analyst, human gate) → real today / planned on Vultr → end card.

## Rebuild

```bash
cd video
npm install
npm run tts                                  # voiceover from narration.json → public/audio/vo-*.mp3
npm run record -- http://127.0.0.1:3171      # app must be running in mock mode (repo root: npm run build && npx next start -p 3171)
python3 scripts/cut-clips.py                 # fit each recorded part to its voiceover → public/clips/*.mp4
npm run render                               # MP4 (-16 LUFS) + poster + SRT into ../docs/media
npm run dev                                  # optional: Remotion Studio preview
```

`npm run record` uses Playwright's headless shell (`npx playwright install chromium-headless-shell` once).
`npm run tts` needs `uv` and `ffmpeg`; the model is downloaded once from Hugging Face.

## Rights and licences

| Part | Source | Licence / note |
|---|---|---|
| Voice | Kokoro-82M (`hexgrad/Kokoro-82M`), voice `af_heart`, generated locally | Apache-2.0 model; no attribution required for the audio |
| Background music | `public/audio/bg-ambient.mp3`, synthesized with ffmpeg sine tones | made here, no third-party material |
| Screen recording | this app (`src/`), mock mode, local only | own work; no keys, emails or tokens in frame |
| Fonts | Inter, JetBrains Mono via `@remotion/google-fonts` | SIL Open Font License 1.1 |
| Logo | the ProofBox check-square icon from `src/components/ProofBoxApp.tsx` | own work |
| Video framework | Remotion | free for individuals and companies up to 3 people; larger teams need a company licence |

Not used on purpose: edge-tts (it calls Microsoft's Read Aloud service, which has no licence for this kind of use), Vultr or lablab logos, stock music.

"Vultr" is spelled "Vulture" and "Ed25519" as "E D two five five one nine" in `narration.json` so the voice pronounces them right; `scripts/make-srt.py` writes the normal spelling into the captions.

Honesty rule for every re-record: the app runs in mock mode, so the video must keep saying "simulated" for the sandbox and "planned" for Vultr until that is no longer true.
