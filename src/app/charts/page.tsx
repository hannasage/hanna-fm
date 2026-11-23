import { ChartMessage, CountingNote, InProgressNote } from "../../components/chart-notes";
import { ChartTable } from "../../components/chart-table";
import { ChartTabs } from "../../components/chart-tabs";
import { ChartWeekBar } from "../../components/chart-week-bar";
import { chartsHref, formatDay, parseChartsParams, type ChartsView, type SearchParams } from "../../lib/chart-page";
import { loadChartPage } from "../../lib/chart-queries";
import styles from "./page.module.css";

export const metadata = { title: "Charts | hanna.fm" };

// The week, the kind and the database clock all change the page, so it is built for each request.
export const dynamic = "force-dynamic";

export default async function ChartsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const view = parseChartsParams(await searchParams);

  return (
    <main id="content" tabIndex={-1} className={styles.page}>
      <h1>Charts</h1>
      <p className={styles.lede}>Weekly top tracks, artists and albums.</p>
      {view === null ? <InvalidView /> : <ChartView view={view} />}
    </main>
  );
}

function InvalidView() {
  return (
    <ChartMessage title="That chart does not exist" href="/charts" action="Show the latest chart">
      A chart is Tracks, Artists or Albums, and a week starts on a Monday.
    </ChartMessage>
  );
}

async function ChartView({ view }: { view: ChartsView }) {
  const data = await loadChartPage(view);
  const latest = chartsHref({ kind: view.kind, week: null });

  if (data.status === "unavailable") {
    return (
      <ChartMessage title="Charts are unavailable" href={chartsHref(view)} action="Try again">
        The chart could not be loaded. The fault is on this side. Try again in a minute.
      </ChartMessage>
    );
  }

  if (data.status === "no_data") {
    return (
      <>
        <ChartTabs kind={view.kind} week={null} />
        <ChartMessage title="No chart yet" href="/charts" action="Back to Tracks">
          No plays have been counted for this chart yet. It appears here once they are.
        </ChartMessage>
      </>
    );
  }

  if (data.status === "out_of_range") {
    const { firstWeek, latestWeek } = data.bounds;
    return (
      <>
        <ChartTabs kind={view.kind} week={null} />
        <ChartMessage title="No chart for that week" href={latest} action="Show the latest chart">
          {firstWeek !== null && latestWeek !== null
            ? `This chart runs from the week of ${formatDay(firstWeek)} to the week of ${formatDay(latestWeek)}.`
            : "That week is not on this chart."}
        </ChartMessage>
      </>
    );
  }

  const { bounds, choice, rows } = data;
  return (
    <>
      <ChartTabs kind={view.kind} week={view.week} />
      <ChartWeekBar kind={view.kind} bounds={bounds} choice={choice} />
      {choice.inProgress ? <InProgressNote /> : null}
      <ChartTable kind={view.kind} week={choice.week} rows={rows} />
      <CountingNote />
    </>
  );
}
