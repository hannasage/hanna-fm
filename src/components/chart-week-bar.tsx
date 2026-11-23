import Link from "next/link";
import { chartsHref, formatWeek, weeksBetween, type WeekChoice } from "../lib/chart-page";
import type { ChartBounds, ChartKind } from "../lib/charts";
import styles from "./chart-controls.module.css";

type Props = {
  kind: ChartKind;
  bounds: ChartBounds;
  choice: Extract<WeekChoice, { status: "ok" }>;
};

/**
 * Previous and next week links, and a form that lists every week. The form is a plain GET, so it works with no script.
 * The weeks come from the database's own first and latest week, and the running week is named as such.
 */
export function ChartWeekBar({ kind, bounds, choice }: Props) {
  const { firstWeek, latestWeek, currentWeek } = bounds;
  const weeks = firstWeek !== null && latestWeek !== null ? weeksBetween(firstWeek, latestWeek) : [choice.week];

  return (
    <div className={styles.weekBar}>
      {choice.previous === null ? (
        <span className={`${styles.step} ${styles.stepOff}`}>
          <span aria-hidden="true">&larr;</span>Previous week
        </span>
      ) : (
        <Link rel="prev" className={styles.step} href={chartsHref({ kind, week: choice.previous })}>
          <span aria-hidden="true">&larr;</span>Previous week
        </Link>
      )}

      <form method="get" action="/charts" className={styles.weekForm}>
        {kind !== "track" ? <input type="hidden" name="kind" value={kind} /> : null}
        <label htmlFor="chart-week" className={styles.weekLabel}>
          Week
        </label>
        <select id="chart-week" name="week" className={styles.select} defaultValue={choice.week}>
          {weeks.map((week) => (
            <option key={week} value={week}>
              {formatWeek(week)}
              {week >= currentWeek ? " (in progress)" : ""}
            </option>
          ))}
        </select>
        <button type="submit" className={styles.go}>
          Show
        </button>
      </form>

      {choice.next === null ? (
        <span className={`${styles.step} ${styles.stepOff} ${styles.stepNext}`}>
          Next week<span aria-hidden="true">&rarr;</span>
        </span>
      ) : (
        <Link rel="next" className={`${styles.step} ${styles.stepNext}`} href={chartsHref({ kind, week: choice.next })}>
          Next week<span aria-hidden="true">&rarr;</span>
        </Link>
      )}
    </div>
  );
}
