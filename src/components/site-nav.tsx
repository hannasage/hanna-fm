"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "../lib/nav";
import styles from "./site-nav.module.css";

/** The section list and the Now playing slot. A section with no page is shown but is not a link. */
export function SiteNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className={styles.nav}>
      <ul className={styles.list}>
        {NAV_ITEMS.map((item) => (
          <li key={item.label} className={styles.cell}>
            {item.href === null ? (
              <span className={`${styles.item} ${styles.soon}`}>
                {item.label}
                <span className={styles.visuallyHidden}> coming soon</span>
                <span className={styles.tag} aria-hidden="true">
                  soon
                </span>
              </span>
            ) : (
              <Link
                href={item.href}
                className={`${styles.item} ${styles.link}`}
                aria-current={pathname === item.href ? "page" : undefined}
              >
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
      {/* Empty for now. A later change fills it. It takes no space while it is empty. */}
      <div id="now-playing" className={styles.nowPlaying} />
    </nav>
  );
}
