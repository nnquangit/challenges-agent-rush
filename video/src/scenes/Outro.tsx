import React from "react";
import { colors } from "../theme";
import { Logo, Mono, Reveal, Scene } from "../ui";

export const OutroScene: React.FC = () => (
  <Scene>
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      <Reveal at={0} style={{ display: "flex", alignItems: "center", gap: 30 }}>
        <Logo size={120} />
        <div style={{ fontSize: 120, fontWeight: 800, letterSpacing: -3 }}>ProofBox</div>
      </Reveal>
      <Reveal at={20} style={{ fontSize: 64, fontWeight: 700, color: colors.contained, marginTop: 30 }}>
        Blast radius zero, with receipts.
      </Reveal>
      <Reveal at={50} style={{ marginTop: 70 }}>
        <Mono size={30}>MIT licence · docs in docs/index.html · mock build, sandbox simulated</Mono>
      </Reveal>
    </div>
  </Scene>
);
