import { SiteNav } from "./site-nav";
import { Wordmark } from "./wordmark";
import styles from "./site-header.module.css";

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Wordmark />
        <SiteNav />
      </div>
    </header>
  );
}
