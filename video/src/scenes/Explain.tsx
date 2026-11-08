import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "../theme";
import { Card, Kicker, Mono, Reveal, Scene, Title } from "../ui";

const stages = [
  { name: "Model", body: "proposes a plan", color: colors.indigo, at: 1.0 },
  { name: "Control plane", body: "validates · adds probes · human gate · egress allowlist", color: colors.contained, at: 4.4 },
  { name: "Fresh sandbox", body: "one per step, destroyed afterwards", color: colors.sky, at: 10.8 },
  { name: "Signed receipt", body: "sha256 + Ed25519 over everything", color: colors.amber, at: 14.6 },
];

export const ApproachScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Scene>
      <Kicker>The approach</Kicker>
      <Reveal at={0}>
        <Title>A control plane between the model and the machine.</Title>
      </Reveal>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 1.25fr 60px 1fr 60px 1fr", alignItems: "stretch", marginTop: 90 }}>
        {stages.map((s, i) => {
          const on = frame >= s.at * fps;
          return (
            <React.Fragment key={s.name}>
              {i > 0 && (
                <Reveal at={s.at * fps} style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 56, color: colors.dim }}>
                  →
                </Reveal>
              )}
              <Reveal at={s.at * fps}>
                <Card
                  border={on ? s.color : colors.line}
                  style={{
                    height: 330,
                    boxShadow: `0 0 ${interpolate(frame, [s.at * fps, s.at * fps + 20, s.at * fps + 60], [0, 60, 18], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px ${s.color}55`,
                  }}
                >
                  <div style={{ fontSize: 46, fontWeight: 800, color: s.color }}>{s.name}</div>
                  <div style={{ marginTop: 22, fontSize: 34, lineHeight: 1.3, color: colors.text }}>{s.body}</div>
                </Card>
              </Reveal>
            </React.Fragment>
          );
        })}
      </div>
    </Scene>
  );
};

export const MockScene: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <Scene>
      <Reveal at={0}>
        <div style={{ display: "inline-block", border: `3px solid ${colors.amber}`, color: colors.amber, borderRadius: 16, padding: "14px 28px" }}>
          <Mono size={40} color={colors.amber}>MOCK MODE · no Vultr calls</Mono>
        </div>
      </Reveal>
      <Reveal at={0.6 * fps} style={{ marginTop: 40 }}>
        <Title>Before the demo: what is simulated.</Title>
      </Reveal>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, marginTop: 70 }}>
        <Reveal at={3.2 * fps}>
          <Card border="rgba(251,191,36,0.55)" style={{ minHeight: 360 }}>
            <div style={{ fontSize: 44, fontWeight: 800, color: colors.amber }}>Simulated</div>
            <ul style={{ fontSize: 36, lineHeight: 1.55, marginTop: 18, paddingLeft: 36 }}>
              <li>Sandbox: fixtures, no container or VM</li>
              <li>Browser: canned pages</li>
              <li>Planner: template LLM</li>
            </ul>
          </Card>
        </Reveal>
        <Reveal at={8.4 * fps}>
          <Card border="rgba(52,211,153,0.55)" style={{ minHeight: 360 }}>
            <div style={{ fontSize: 44, fontWeight: 800, color: colors.contained }}>Real code</div>
            <ul style={{ fontSize: 36, lineHeight: 1.55, marginTop: 18, paddingLeft: 36 }}>
              <li>Policy rules and human gate</li>
              <li>Secret redaction</li>
              <li>Receipt hash + Ed25519 signature</li>
            </ul>
          </Card>
        </Reveal>
      </div>
    </Scene>
  );
};

const real = ["Plan validation", "Server-inserted probes", "Human gate", "Egress allowlist", "Secret redaction", "Signed, offline-verifiable receipts"];
const next = ["Vultr Serverless Inference for the model calls", "Docker + gVisor on a Vultr VM for the sandbox"];

export const StatusScene: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <Scene>
      <Kicker>Where it stands</Kicker>
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 48, marginTop: 30 }}>
        <div>
          <Reveal at={0}>
            <div style={{ fontSize: 60, fontWeight: 800, color: colors.contained }}>Real today</div>
          </Reveal>
          {real.map((r, i) => (
            <Reveal key={r} at={(1.6 + i * 1.1) * fps} style={{ fontSize: 42, marginTop: 26, display: "flex", gap: 20 }}>
              <span style={{ color: colors.contained }}>✓</span>
              {r}
            </Reveal>
          ))}
        </div>
        <Reveal at={10.6 * fps}>
          <Card border="rgba(125,211,252,0.5)">
            <div style={{ fontSize: 52, fontWeight: 800, color: colors.sky }}>Next: on Vultr</div>
            <Mono size={28} color={colors.amber}>planned · not deployed yet</Mono>
            {next.map((n) => (
              <div key={n} style={{ fontSize: 40, lineHeight: 1.35, marginTop: 30 }}>
                {n}
              </div>
            ))}
          </Card>
        </Reveal>
      </div>
    </Scene>
  );
};
