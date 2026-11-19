import type { ReactNode } from "react";
import "./globals.css";
import { signOut } from "./actions";

export const metadata = { title: "Unified AI Factory", description: "Operator dashboard" };

const NAV = [["/", "Overview"], ["/jobs", "Jobs"], ["/inbox", "Inbox"], ["/workers", "Workers"], ["/policies", "Policies"], ["/usage", "Usage & capacity"], ["/auto-merge", "Auto-merge"], ["/audit", "Audit"]] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="sr">Skip to content</a>
        <nav aria-label="Primary">{NAV.map(([href, label]) => (<a key={href} href={href}>{label}</a>))}<form action={signOut}><button type="submit">Sign out</button></form></nav>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
