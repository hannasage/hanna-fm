import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SiteHeader } from "../components/site-header";
import "./globals.css";
import styles from "./layout.module.css";

export const metadata: Metadata = {
  title: "hanna.fm",
  description: "A map of what Hanna listens to.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#content" className={styles.skip}>
          Skip to content
        </a>
        <SiteHeader />
        <div id="content" tabIndex={-1} className={styles.content}>
          {children}
        </div>
      </body>
    </html>
  );
}
