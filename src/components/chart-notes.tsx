import Link from "next/link";
import { COUNTING_RULES } from "../lib/chart-page";
import styles from "./chart-notes.module.css";

/** A message that takes the place of the table. Each one names what happened and offers a way on. */
export function ChartMessage({
  title,
  children,
  href,
  action,
}: {
  title: string;
  children: React.ReactNode;
  href: string;
  action: string;
}) {
  return (
    <section className={styles.message}>
      <h2 className={styles.messageTitle}>{title}</h2>
      <p>{children}</p>
      <p className={styles.actions}>
        <Link href={href} className={styles.action}>
          {action}
        </Link>
      </p>
    </section>
  );
}

/** Takes the place of the table when a week inside the range has no counted play. */
export function EmptyWeek({ kindLabel, weekLabel }: { kindLabel: string; weekLabel: string }) {
  return (
    <section className={styles.emptyWeek}>
      <p className={styles.emptyCaption}>
        Top {kindLabel}, {weekLabel}
      </p>
      <p className={styles.emptyText}>No plays counted this week.</p>
    </section>
  );
}

/** Shown above a chart for the week that has not ended. */
export function InProgressNote() {
  return (
    <p className={styles.progress}>
      <strong>Week in progress.</strong> This chart is not final and can still change.
    </p>
  );
}

/** How the chart counts, and how to read a row. */
export function CountingNote() {
  return (
    <section aria-labelledby="chart-rules" className={styles.rules}>
      <h2 id="chart-rules" className={styles.rulesTitle}>
        How the chart counts
      </h2>
      <ul className={styles.rulesList}>
        {COUNTING_RULES.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      <p className={styles.key}>
        Last week is the rank a week earlier. Peak is the best rank so far. Weeks is the number of weeks on the chart.
      </p>
    </section>
  );
}
