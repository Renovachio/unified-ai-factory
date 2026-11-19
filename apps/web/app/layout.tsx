import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Unified AI Factory", description: "Operator dashboard" };

const NAV = [["/", "Overview"], ["/jobs", "Jobs"], ["/inbox", "Inbox"], ["/workers", "Workers"], ["/policies", "Policies"], ["/usage", "Usage & capacity"], ["/audit", "Audit"]] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="sr">Skip to content</a>
        <nav aria-label="Primary">{NAV.map(([href, label]) => (<a key={href} href={href}>{label}</a>))}</nav>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
