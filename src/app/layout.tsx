import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

// Applies the saved theme before paint (no flash). "system" = no attribute (CSS media query decides).
const themeInit = `try{var t=localStorage.getItem('vega-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}`;

export const metadata: Metadata = {
  title: "Vega",
  description: "Pre-market options research, paper trading only.",
  applicationName: "Vega",
  // "black" (opaque) rather than "black-translucent": the web view is confined to
  // the safe area, so a fixed bottom nav sits flush at launch instead of being
  // positioned against a too-tall viewport and snapping down on first tap.
  appleWebApp: { capable: true, statusBarStyle: "black", title: "Vega" },
  icons: { icon: "/icon.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  // No viewport-fit:cover — let iOS reserve the safe areas so fixed positioning is
  // correct from the first frame (avoids the "nav floats up until first tap" bug).
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full">
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {themeInit}
        </Script>
      </head>
      <body className="min-h-dvh">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
