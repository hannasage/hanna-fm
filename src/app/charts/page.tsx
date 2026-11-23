import type { Metadata } from "next";
import { headers } from "next/headers";
import { ChartMessage, CountingNote, EmptyWeek, InProgressNote } from "../../components/chart-notes";
import { ChartTable } from "../../components/chart-table";
import { ChartTabs } from "../../components/chart-tabs";
import { ChartWeekBar } from "../../components/chart-week-bar";
import { HANDOFF_HEADER, decodeHandoff } from "../../lib/chart-handoff";
import {
  KIND_LABELS,
  chartsHref,
  formatDay,
  formatWeek,
  parseChartsParams,
  type ChartPageData,
  type ChartsView,
  type SearchParams,
} from "../../lib/chart-page";
import styles from "./page.module.css";

// The status, the cache policy and the database read are the proxy's (src/proxy.ts). The page draws what it was handed.
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<SearchParams> };

async function read({ searchParams }: Props): Promise<{ view: ChartsView | null; data: ChartPageData }> {
  const view = parseChartsParams(await searchParams);
  const handoff = (await headers()).get(HANDOFF_HEADER);
  // A request that skipped the proxy has no answer to draw. It is a fault of this site, so it ends in a 500.
  if (handoff === null) throw new Error("The Charts page ran without its proxy.");
  return { view, data: decodeHandoff(handoff, view) };
}

/** A chart that has rows is the one page worth indexing. Every other state says noindex and names no canonical address. */
export async function generateMetadata(props: Props): Promise<Metadata> {
  const { view, data } = await read(props);
  const title = "Charts | hanna.fm";
  if (view !== null && data.status === "ok" && data.rows.length > 0) {
    return { title, alternates: { canonical: chartsHref(view) } };
  }
  return { title, robots: { index: false, follow: true } };
}

export default async function ChartsPage(props: Props) {
  const { view, data } = await read(props);
  return (
    <main id="content" tabIndex={-1} className={styles.page}>
      <h1>Charts</h1>
      <p className={styles.lede}>Weekly top tracks, artists and albums.</p>
      <ChartBody view={view} data={data} />
    </main>
  );
}

function ChartBody({ view, data }: { view: ChartsView | null; data: ChartPageData }) {
  if (view === null || data.status === "invalid") {
    return (
      <>
        <ChartTabs kind={null} />
        <ChartMessage title="That chart does not exist" href="/charts" action="Show the latest chart">
          A chart is Tracks, Artists or Albums, and a week starts on a Monday.
        </ChartMessage>
      </>
    );
  }

  const latest = chartsHref({ kind: view.kind, week: null });

  switch (data.status) {
    case "unavailable":
      return (
        <>
          <ChartTabs kind={view.kind} />
          <ChartMessage title="Charts are unavailable" href={chartsHref(view)} action="Try again">
            The chart could not be loaded. The fault is on this side. Try again in a minute.
          </ChartMessage>
        </>
      );
    case "no_data":
      return (
        <>
          <ChartTabs kind={view.kind} />
          <ChartMessage title="No chart yet" href="/charts" action="Back to Tracks">
            No plays have been counted for this chart yet. It appears here once they are.
          </ChartMessage>
        </>
      );
    case "out_of_range": {
      const { firstWeek, latestWeek } = data.bounds;
      return (
        <>
          <ChartTabs kind={view.kind} />
          <ChartMessage title="No chart for that week" href={latest} action="Show the latest chart">
            {firstWeek !== null && latestWeek !== null
              ? `This chart runs from the week of ${formatDay(firstWeek)} to the week of ${formatDay(latestWeek)}.`
              : "That week is not on this chart."}
          </ChartMessage>
        </>
      );
    }
    case "ok": {
      const { bounds, choice, rows } = data;
      return (
        <>
          <ChartTabs kind={view.kind} />
          <ChartWeekBar kind={view.kind} bounds={bounds} choice={choice} />
          {choice.inProgress ? <InProgressNote /> : null}
          {rows.length === 0 ? (
            <EmptyWeek kindLabel={KIND_LABELS[view.kind].toLowerCase()} weekLabel={formatWeek(choice.week)} />
          ) : (
            <ChartTable kind={view.kind} week={choice.week} rows={rows} />
          )}
          <CountingNote />
        </>
      );
    }
    default:
      // `invalid` was handled above, so this state cannot happen.
      throw new Error("An unknown Charts state.");
  }
}
