import Link from "next/link";
import { KIND_TABS, chartsHref } from "../lib/chart-page";
import type { ChartKind } from "../lib/charts";
import styles from "./chart-controls.module.css";

/**
 * The three charts, as plain links. The address holds the kind, so a tab works with no script and a chart can be shared.
 * A tab opens the default week of its kind, because each kind has its own first week. `kind` is null when no chart is
 * shown, as on a request that is not valid, and then no tab is current.
 */
export function ChartTabs({ kind }: { kind: ChartKind | null }) {
  return (
    <nav aria-label="Chart type" className={styles.tabs}>
      <ul className={styles.tabList}>
        {KIND_TABS.map((tab) => (
          <li key={tab.kind} className={styles.tabCell}>
            <Link
              href={chartsHref({ kind: tab.kind, week: null })}
              prefetch={false}
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
