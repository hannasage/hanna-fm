-- Weekly chart inputs. Read-only: the function changes no row.
--
-- A chart week runs Monday to Sunday in America/New_York. Postgres converts each
-- play's time to New York wall time first, so a daylight saving change moves no play.
-- A play counts when ms_played is at least 30000, or null (poll rows have no length).
-- Rank: plays, then minutes (null ms_played adds none), then name, then key.
-- Peak and weeks on chart cover every week up to and including p_week.
-- p_cutoff hides plays newer than the public delay. The caller sets it.
-- Only server code calls this, with the service role. No browser role may run it.
create function public.chart_weekly(
  p_week   date,
  p_kind   text,
  p_limit  integer,
  p_cutoff timestamptz
)
returns table (
  rank           integer,
  key            text,
  name           text,
  plays          integer,
  minutes        numeric,
  last_week_rank integer,
  peak_rank      integer,
  weeks_on_chart integer
)
language sql
stable
set search_path = ''
as $$
  with weekly as (
    select date_trunc('week', p.ended_at at time zone 'America/New_York')::date as week,
           case p_kind
             when 'track'  then p.track_uri
             when 'artist' then p.artist_name
             else p.album_name || chr(31) || p.artist_name
           end as item_key,
           max(case p_kind
                 when 'track'  then p.track_name
                 when 'artist' then p.artist_name
                 else p.album_name || ' - ' || p.artist_name
               end) as item_name,
           count(*)::integer as plays,
           coalesce(sum(p.ms_played), 0) as ms
      from public.plays p
     where p.ended_at <= p_cutoff
       and p.ended_at <  ((p_week + 7)::timestamp at time zone 'America/New_York')
       and (p.ms_played is null or p.ms_played >= 30000)
       and (p_kind <> 'album' or p.album_name is not null)
     group by 1, 2
  ),
  ranked as (
    select w.*,
           (row_number() over (
              partition by w.week
              order by w.plays desc, w.ms desc, w.item_name collate "C", w.item_key collate "C"
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
  select h.rnk, replace(h.item_key, chr(31), ' - '), h.item_name, h.plays,
         round(h.ms / 60000.0, 1), h.last_rnk, h.peak, h.weeks
    from history h
   where h.week = p_week
   order by h.rnk
   limit p_limit
$$;

revoke all on function public.chart_weekly(date, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.chart_weekly(date, text, integer, timestamptz)
  to service_role;
