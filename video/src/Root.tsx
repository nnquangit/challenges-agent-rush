import React from "react";
import { Composition } from "remotion";
import { Demo } from "./Demo";
import { TOTAL_FRAMES } from "./timing";

export const RemotionRoot: React.FC = () => (
  <Composition id="ProofBoxDemo" component={Demo} durationInFrames={TOTAL_FRAMES} fps={30} width={1920} height={1080} />
);
