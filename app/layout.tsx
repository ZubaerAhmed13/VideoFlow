/* eslint-disable @next/next/no-sync-scripts -- isolation must be established before the editor becomes interactive */
import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "VideoFlow Professional Core",
  description: "Privacy-first, non-destructive video and audio editing in your browser.",
  manifest: "./manifest.webmanifest",
  icons: {
    icon: "./favicon.svg",
    shortcut: "./favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content="default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'"
        />
        <script src="./coi-bootstrap.js" />
      </head>
      <body className="antialiased"><Providers>{children}</Providers></body>
    </html>
  );
}
