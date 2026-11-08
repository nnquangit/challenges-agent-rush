import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProofBox — containment-first agent runs",
  icons: { icon: "/favicon.svg" },
  description: "Plan → dispatch into an isolated sandbox → verifiable receipt. Vultr Agent Rush, Challenge 1: Blast Radius Zero.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans text-zinc-200 antialiased">{children}</body>
    </html>
  );
}
