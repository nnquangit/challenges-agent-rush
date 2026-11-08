import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { colors } from "../theme";
import { Mono, Reveal, Scene } from "../ui";

/** Screen recording of the app in mock mode, with a label in the empty middle of the app header. */
export const LiveScene: React.FC<{ clip: string; label: string }> = ({ clip, label }) => (
  <Scene padded={false}>
    <OffthreadVideo src={staticFile(clip)} muted style={{ width: "100%", height: "100%" }} />
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", paddingTop: 16 }}>
      <Reveal at={6}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 22,
            background: "rgba(11,13,16,0.92)",
            border: `2px solid ${colors.contained}`,
            borderRadius: 14,
            padding: "10px 24px",
          }}
        >
          <span style={{ fontSize: 34, fontWeight: 700 }}>{label}</span>
          <Mono size={24} color={colors.amber}>
            live app · mock mode · sandbox simulated
          </Mono>
        </div>
      </Reveal>
    </AbsoluteFill>
  </Scene>
);
