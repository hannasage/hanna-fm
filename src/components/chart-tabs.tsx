import Link from "next/link";
import { KIND_TABS, chartsHref } from "../lib/chart-page";
import type { ChartKind } from "../lib/charts";
import styles from "./chart-controls.module.css";

/**
 * The three charts, as plain links. The address holds the kind, so a tab works with no script and a chart can be shared.
 * A week the reader chose stays in the address when the kind changes.
 */
export function ChartTabs({ kind, week }: { kind: ChartKind; week: string | null }) {
  return (
    <nav aria-label="Chart type" className={styles.tabs}>
      <ul className={styles.tabList}>
        {KIND_TABS.map((tab) => (
          <li key={tab.kind} className={styles.tabCell}>
            <Link
              href={chartsHref({ kind: tab.kind, week })}
              className={styles.tab}
              aria-current={tab.kind === kind ? "page" : undefined}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
