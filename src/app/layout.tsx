import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

// Applies the saved theme before paint (no flash). "system" = no attribute (CSS media query decides).
const themeInit = `try{var t=localStorage.getItem('vega-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}`;

export const metadata: Metadata = {
  title: "Vega",
  description: "Pre-market options research — paper trading only.",
  applicationName: "Vega",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Vega" },
  icons: { icon: "/icon.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
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
