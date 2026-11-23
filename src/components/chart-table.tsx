import {
  displayName,
  flagOf,
  formatWeek,
  KIND_LABELS,
  lastWeekLabel,
  movementOf,
} from "../lib/chart-page";
import type { ChartKind, ChartRow } from "../lib/charts";
import styles from "./chart-table.module.css";

/** The first column is named for what the chart ranks. */
const NAME_COLUMN: Record<ChartKind, string> = { track: "Title", artist: "Artist", album: "Album" };

function columnsFor(kind: ChartKind): string[] {
  return ["Rank", "Move", NAME_COLUMN[kind], "Last week", "Peak", "Weeks", "Plays", "Minutes"];
}

const count = new Intl.NumberFormat("en-US");

function Move({ row }: { row: ChartRow }) {
  const flag = flagOf(row);
  if (flag !== null) {
    return <span className={`${styles.flag} ${flag === "NEW" ? styles.flagNew : styles.flagBack}`}>{flag}</span>;
  }

  const { direction, steps } = movementOf(row);
  const places = `${steps} ${steps === 1 ? "place" : "places"}`;
  switch (direction) {
    case "up":
      return (
        <>
          <span aria-hidden="true">
            <span className={styles.glyph}>{"▲"}</span>
            {steps}
          </span>
          <span className={styles.sr}>Up {places}</span>
        </>
      );
    case "down":
      return (
        <>
          <span aria-hidden="true">
            <span className={styles.glyph}>{"▼"}</span>
            {steps}
          </span>
          <span className={styles.sr}>Down {places}</span>
        </>
      );
    case "same":
      return (
        <>
          <span aria-hidden="true" className={styles.same}>
            =
          </span>
          <span className={styles.sr}>No change</span>
        </>
      );
    default:
      return <span className={styles.same}>{"–"}</span>;
  }
}

/**
 * One week of one chart as a real table. Names are untrusted text: they are children of React elements, so React escapes them,
 * and no name goes into an attribute or an address.
 * On a narrow screen the rows turn into small cards (see the stylesheet). The explicit roles keep the table
 * semantics, which some browsers drop when a table part is given another display value.
 */
export function ChartTable({ kind, week, rows }: { kind: ChartKind; week: string; rows: ChartRow[] }) {
  return (
    <table className={styles.table} role="table">
      <caption className={styles.caption}>
        Top {KIND_LABELS[kind].toLowerCase()}, {formatWeek(week)}
      </caption>
      <thead role="rowgroup" className={styles.head}>
        <tr role="row">
          {columnsFor(kind).map((name) => (
            <th key={name} scope="col" role="columnheader">
              {name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody role="rowgroup">
        {rows.map((row) => (
          <tr key={row.key} role="row" className={styles.row}>
            <td role="cell" className={styles.rank}>
              {row.rank}
            </td>
            <td role="cell" className={styles.move} data-label="Move">
              <Move row={row} />
            </td>
            <th scope="row" role="rowheader" className={styles.title}>
              <span className={styles.name} data-part="name">
                {displayName(kind, row)}
              </span>
              {row.artist !== null ? (
                <>
                  <span className={styles.sr}> by </span>
                  <span className={styles.artist} data-part="artist">
                    {row.artist}
                  </span>
                </>
              ) : null}
            </th>
            <td role="cell" className={`${styles.stat} ${styles.last}`} data-label="Last wk">
              {row.last_week_rank === null ? (
                <>
                  <span aria-hidden="true">{lastWeekLabel(row)}</span>
                  <span className={styles.sr}>No rank last week</span>
                </>
              ) : (
                lastWeekLabel(row)
              )}
            </td>
            <td role="cell" className={`${styles.stat} ${styles.peak}`} data-label="Peak">
              {row.peak_rank}
            </td>
            <td role="cell" className={`${styles.stat} ${styles.weeks}`} data-label="Weeks">
              {row.weeks_on_chart}
            </td>
            <td role="cell" className={`${styles.stat} ${styles.plays}`} data-label="Plays">
              {count.format(row.plays)}
            </td>
            <td role="cell" className={`${styles.stat} ${styles.minutes}`} data-label="Mins">
              {count.format(row.minutes)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
