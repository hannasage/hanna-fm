import Link from "next/link";
import type { CSSProperties } from "react";
import { WORDMARK_NAME, WORDMARK_SUFFIX } from "../lib/wordmark";
import styles from "./wordmark.module.css";

/** The hanna.fm wordmark. Links home. The link has a text name, and the art is hidden from screen readers. */
export function Wordmark() {
  return (
    <Link href="/" className={styles.link} aria-label="hanna.fm">
      <pre className={styles.art} aria-hidden="true">
        {WORDMARK_NAME.map((row, index) => (
          <span key={index} className={styles.row} style={{ "--row": index } as CSSProperties}>
            {row}
            <span className={styles.signal}>{WORDMARK_SUFFIX[index]}</span>
          </span>
        ))}
      </pre>
    </Link>
  );
}
