-- Weekly chart inputs. Read-only: the functions change no row.
--
-- A chart week runs Monday to Sunday in America/New_York. Postgres converts each
-- play's time to New York wall time first, so a daylight saving change moves no play.
--
-- What counts as a play:
--   * a play of 30 seconds or more (ms_played >= 30000), and
--   * a poll row with no ms_played at all. The poller learns that a track was playing, not how
--     long it played, so the 30 second rule cannot be applied to it. Dropping those rows would
--     leave every poll play out of the chart, so a null length counts as a play and adds no minutes.
--   * An album chart leaves out plays that have no album.
--
-- What is public:
--   * Plays newer than the public delay are hidden. The delay is whole Eastern days: chart_cutoff
--     snaps to the start of an Eastern calendar day, so every number on a chart moves only at Eastern
--     midnight and no single play enters a total at its own time. The cutoff is never closer than
--     24 hours to the clock, even on the day a clock change makes the day before 23 hours long.
--   * Minutes are shown in whole minutes. Ranking still uses the exact sum.
--
-- Rank: plays, then exact minutes (null ms_played adds none), then name without regard to case,
-- then name, then key. Peak and weeks on chart cover every week up to and including the one asked for.
--
-- Only server code calls these, with the service role. No browser role may run them.
-- p_now is the clock. It defaults to now(); a test passes a fixed time instead.
-- The two functions that read plays stop a query at 5 seconds. PostgREST applies this setting
-- when it calls the function, so a request that the site gave up on cannot leave a long query running.

-- The newest instant the public may see: the start of the Eastern day p_delay_days days before today,
-- or earlier when a day was shorter than 24 hours.
create function public.chart_cutoff(
  p_now        timestamptz,
  p_delay_days integer
)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select date_trunc(
           'day',
           ((date_trunc('day', p_now at time zone 'America/New_York') at time zone 'America/New_York')
              - p_delay_days * interval '24 hours') at time zone 'America/New_York'
         ) at time zone 'America/New_York'
$$;

-- The first stored week, the latest week with a play the chart would count, and the current week.
-- first_week is null when no play is stored. latest_week is null when no play qualifies.
create function public.chart_bounds(
  p_kind       text,
  p_delay_days integer,
  p_now        timestamptz default now()
)
returns table (
  first_week   date,
  latest_week  date,
  current_week date
)
language sql
stable
set search_path = ''
set statement_timeout = '5s'
as $$
  select
    (select date_trunc('week', min(p.ended_at) at time zone 'America/New_York')::date
       from public.plays p),
    (select date_trunc('week', p.ended_at at time zone 'America/New_York')::date
       from public.plays p
      where p.ended_at <= public.chart_cutoff(p_now, p_delay_days)
        and (p.ms_played is null or p.ms_played >= 30000)
        and (p_kind <> 'album' or p.album_name is not null)
      order by p.ended_at desc
      limit 1),
    date_trunc('week', p_now at time zone 'America/New_York')::date
$$;

create function public.chart_weekly(
  p_week       date,
  p_kind       text,
  p_limit      integer,
  p_delay_days integer,
  p_now        timestamptz default now()
)
returns table (
  rank           integer,
  key            text,
  name           text,
  plays          integer,
  minutes        integer,
  last_week_rank integer,
  peak_rank      integer,
  weeks_on_chart integer
)
language sql
stable
set search_path = ''
set statement_timeout = '5s'
as $$
  with weekly as (
    select date_trunc('week', p.ended_at at time zone 'America/New_York')::date as week,
           -- An album key hashes the album and the artist apart, so no pair of names can make
           -- the same key as another pair. The name shown is Album - Artist.
           case p_kind
             when 'track'  then p.track_uri
             when 'artist' then p.artist_name
             else md5(p.album_name) || '.' || md5(p.artist_name)
           end as item_key,
           max(case p_kind
                 when 'track'  then p.track_name
                 when 'artist' then p.artist_name
                 else p.album_name || ' - ' || p.artist_name
               end) as item_name,
           count(*)::integer as plays,
           coalesce(sum(p.ms_played), 0) as ms
      from public.plays p
     where p.ended_at <= public.chart_cutoff(p_now, p_delay_days)
       and p.ended_at <  ((p_week + 7)::timestamp at time zone 'America/New_York')
       -- A poll row has a null ms_played. The 30 second rule cannot be applied to it, because the
       -- poller never learns the length of a play. It counts as a play and adds no minutes.
       and (p.ms_played is null or p.ms_played >= 30000)
       and (p_kind <> 'album' or p.album_name is not null)
     group by 1, 2
  ),
  ranked as (
    select w.*,
           (row_number() over (
              partition by w.week
              order by w.plays desc,
                       w.ms desc,
                       lower(w.item_name) collate "C",
                       w.item_name collate "C",
                       w.item_key collate "C"
           ))::integer as rnk
      from weekly w
  ),
  history as (
    select r.*,
           (min(r.rnk) over (partition by r.item_key))::integer as peak,
           (count(*) over (partition by r.item_key))::integer as weeks,
           (max(r.rnk) filter (where r.week = p_week - 7)
              over (partition by r.item_key))::integer as last_rnk
      from ranked r
  )
  select h.rnk, h.item_key, h.item_name, h.plays,
         round(h.ms / 60000.0)::integer, h.last_rnk, h.peak, h.weeks
    from history h
   where h.week = p_week
   order by h.rnk
   limit p_limit
$$;

revoke all on function public.chart_cutoff(timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.chart_bounds(text, integer, timestamptz)
  from public, anon, authenticated;
revoke all on function public.chart_weekly(date, text, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.chart_cutoff(timestamptz, integer) to service_role;
grant execute on function public.chart_bounds(text, integer, timestamptz) to service_role;
grant execute on function public.chart_weekly(date, text, integer, integer, timestamptz) to service_role;
