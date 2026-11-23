import Link from "next/link";
import { chartsHref, formatWeek, weeksBetween, type WeekBounds, type WeekChoice } from "../lib/chart-page";
import type { ChartKind } from "../lib/charts";
import styles from "./chart-controls.module.css";

type Props = {
  kind: ChartKind;
  bounds: WeekBounds;
  choice: Extract<WeekChoice, { status: "ok" }>;
};

/**
 * A form that lists every week, then the previous and next week links. The form is a plain GET, so it works with no script.
 * The markup order is the reading and the tab order: form, previous, next. The weeks come from the database's own first
 * and latest week, and the running week is named as such.
 */
export function ChartWeekBar({ kind, bounds, choice }: Props) {
  const { firstWeek, latestWeek, currentWeek } = bounds;
  const weeks = firstWeek !== null && latestWeek !== null ? weeksBetween(firstWeek, latestWeek) : [choice.week];

  return (
    <div className={styles.weekBar}>
      <form method="get" action="/charts" className={styles.weekForm}>
        {kind !== "track" ? <input type="hidden" name="kind" value={kind} /> : null}
        <label htmlFor="chart-week" className={styles.weekLabel}>
          Week
        </label>
        <select id="chart-week" name="week" className={styles.select} defaultValue={choice.week}>
          {weeks.map((week) => (
            <option key={week} value={week}>
              {formatWeek(week)}
              {week >= currentWeek ? " (so far)" : ""}
            </option>
          ))}
        </select>
        <button type="submit" className={styles.go}>
          Show
        </button>
      </form>

      {choice.previous === null ? (
        <span className={`${styles.step} ${styles.stepOff}`}>
          <span aria-hidden="true">&larr;</span>
          Previous week<span className={styles.sr}> (first week)</span>
        </span>
      ) : (
        <Link rel="prev" prefetch={false} className={styles.step} href={chartsHref({ kind, week: choice.previous })}>
          <span aria-hidden="true">&larr;</span>
          Previous week
        </Link>
      )}

      {choice.next === null ? (
        <span className={`${styles.step} ${styles.stepOff}`}>
          Next week<span className={styles.sr}> (latest week)</span>
          <span aria-hidden="true">&rarr;</span>
        </span>
      ) : (
        <Link rel="next" prefetch={false} className={styles.step} href={chartsHref({ kind, week: choice.next })}>
          Next week
          <span aria-hidden="true">&rarr;</span>
        </Link>
      )}
    </div>
  );
}
