import React from "react";
import { AbsoluteFill, Audio, Sequence, Series, staticFile, useVideoConfig } from "remotion";
import { ApproachScene, MockScene, StatusScene } from "./scenes/Explain";
import { ProblemScene, TitleScene } from "./scenes/Intro";
import { LiveScene } from "./scenes/Live";
import { OutroScene } from "./scenes/Outro";
import { colors } from "./theme";
import { BG_VOLUME, LEAD, SCENES } from "./timing";

const body: Record<(typeof SCENES)[number]["id"], React.ReactNode> = {
  title: <TitleScene />,
  problem: <ProblemScene />,
  approach: <ApproachScene />,
  mock: <MockScene />,
  prove: <LiveScene clip="clips/prove.mp4" label="Prove-It Python" />,
  contain: <LiveScene clip="clips/contain.mp4" label="Containment probe" />,
  csv: <LiveScene clip="clips/csv.mp4" label="CSV Analyst: self-repair" />,
  gate: <LiveScene clip="clips/gate.mp4" label="Human gate" />,
  status: <StatusScene />,
  outro: <OutroScene />,
};

export const Demo: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg }}>
      <Audio src={staticFile("audio/bg-ambient.mp3")} volume={BG_VOLUME} name="Background music (synthesized)" />
      <Series>
        {SCENES.map((s) => (
          <Series.Sequence key={s.id} durationInFrames={s.frames} name={s.id}>
            {body[s.id]}
            <Sequence from={Math.round(LEAD * fps)} layout="none" name={`VO ${s.id}`}>
              <Audio src={staticFile(`audio/vo-${s.id}.mp3`)} />
            </Sequence>
          </Series.Sequence>
        ))}
      </Series>
    </AbsoluteFill>
  );
};
