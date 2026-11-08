import React from "react";
import { colors } from "../theme";
import { Card, Kicker, Logo, Mono, Reveal, Scene, Title } from "../ui";

export const TitleScene: React.FC = () => (
  <Scene>
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <Reveal at={4} style={{ display: "flex", alignItems: "center", gap: 36 }}>
        <Logo size={150} />
        <div style={{ fontSize: 150, fontWeight: 800, letterSpacing: -4 }}>ProofBox</div>
      </Reveal>
      <Reveal at={18} style={{ fontSize: 56, color: colors.muted, marginTop: 30, fontWeight: 600 }}>
        A containment-first control plane for AI agents
      </Reveal>
      <Reveal at={40} style={{ marginTop: 90 }}>
        <Mono size={34} color={colors.contained}>Vultr Agent Rush · Challenge 1: Blast Radius Zero</Mono>
      </Reveal>
    </div>
  </Scene>
);

const risks = [
  { what: "Reads your API keys", how: "env, .env files, mounted secrets" },
  { what: "Hits cloud metadata", how: "169.254.169.254 → instance credentials" },
  { what: "Submits a form you never approved", how: "a side effect with no human in the loop" },
];

export const ProblemScene: React.FC = () => (
  <Scene>
    <Kicker color={colors.rose}>The problem</Kicker>
    <Reveal at={0}>
      <Title>Agents run code and drive browsers.</Title>
    </Reveal>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 32, marginTop: 70 }}>
      {risks.map((r, i) => (
        <Reveal key={r.what} at={60 + i * 40} style={{ height: "100%" }}>
          <Card border="rgba(251,113,133,0.45)" style={{ height: "100%", boxSizing: "border-box" }}>
            <div style={{ fontSize: 48, fontWeight: 700, lineHeight: 1.15 }}>{r.what}</div>
            <div style={{ marginTop: 22, fontSize: 32, color: colors.muted }}>{r.how}</div>
          </Card>
        </Reveal>
      ))}
    </div>
    <Reveal at={300} style={{ marginTop: 70, fontSize: 52, fontWeight: 700, color: colors.contained }}>
      Contain every step, and prove that you did.
    </Reveal>
  </Scene>
);
