import vo from "./vo-durations.json";
import clips from "./clip-durations.json";

export const FPS = 30;
export const LEAD = 0.6; // seconds of picture before the voice starts
const TAIL = 1.0;

type SceneId = keyof typeof vo;
const len = (id: SceneId) => {
  const clip = (clips as Record<string, number>)[id];
  const seconds = clip ?? vo[id] + LEAD + TAIL;
  return Math.ceil(seconds * FPS);
};

export const SCENES = (
  ["title", "problem", "approach", "mock", "prove", "contain", "csv", "gate", "status", "outro"] as const
).map((id) => ({ id, frames: id === "outro" ? Math.ceil(6 * FPS) : len(id), live: id in clips }));

export const TOTAL_FRAMES = SCENES.reduce((n, s) => n + s.frames, 0);
export const BG_VOLUME = 0.35;
