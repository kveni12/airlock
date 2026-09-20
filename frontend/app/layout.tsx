import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Periscope",
  description: "Keep your coding agents in sight. Set project permissions, launch Codex or Claude Code, and follow their activity with Periscope."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
