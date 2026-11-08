import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { font, mono } from "./fonts";
import { colors } from "./theme";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Scene shell: background, safe-area padding, fade in and out. */
export const Scene: React.FC<{ children: React.ReactNode; padded?: boolean }> = ({ children, padded = true }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1400px 600px at 10% -10%, rgba(52,211,153,0.08), transparent 60%), radial-gradient(1000px 500px at 100% 0%, rgba(99,102,241,0.09), transparent 60%), ${colors.bg}`,
        color: colors.text,
        fontFamily: font,
        padding: padded ? "110px 140px" : 0,
        justifyContent: padded ? "center" : undefined,
        opacity: interpolate(frame, [0, 12, durationInFrames - 12, durationInFrames], [0, 1, 1, 0], clamp),
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/** Fades and lifts its children in, starting at `at` frames. */
export const Reveal: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at, children, style }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        ...style,
        opacity: interpolate(frame, [at, at + 14], [0, 1], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
        translate: interpolate(frame, [at, at + 14], ["0px 26px", "0px 0px"], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) }),
      }}
    >
      {children}
    </div>
  );
};

export const Kicker: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color = colors.contained }) => (
  <div style={{ fontFamily: mono, fontSize: 30, letterSpacing: 4, textTransform: "uppercase", color, marginBottom: 22 }}>{children}</div>
);

export const Title: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 84, fontWeight: 800, lineHeight: 1.08, letterSpacing: -1.5 }}>{children}</div>
);

export const Card: React.FC<{ children: React.ReactNode; border?: string; style?: React.CSSProperties }> = ({ children, border = colors.line, style }) => (
  <div style={{ background: colors.panel, border: `2px solid ${border}`, borderRadius: 24, padding: "30px 36px", ...style }}>{children}</div>
);

export const Logo: React.FC<{ size: number }> = ({ size }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <rect x="3" y="3" width="26" height="26" rx="6" fill="none" stroke={colors.contained} strokeWidth="2.5" />
    <path d="M10 16.5l4 4 8-9" fill="none" stroke={colors.contained} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Mono: React.FC<{ children: React.ReactNode; color?: string; size?: number }> = ({ children, color = colors.muted, size = 30 }) => (
  <span style={{ fontFamily: mono, color, fontSize: size }}>{children}</span>
);
