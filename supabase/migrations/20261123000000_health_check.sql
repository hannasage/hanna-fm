-- Walking skeleton schema.
--
-- Rule: only server code reads or writes the database. The browser holds no
-- database key. Every table turns row-level security on, forces it, and gives
-- the browser roles (anon, authenticated) no privilege and no policy.
-- The server uses the service role key, which bypasses row-level security.

-- New tables in public never grant anything to the browser roles.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

create table public.health_check (
  id bigint generated always as identity primary key,
  label text not null,
  created_at timestamptz not null default now()
);

alter table public.health_check enable row level security;
alter table public.health_check force row level security;

-- Defense in depth: no policy exists, and no privilege either.
revoke all on table public.health_check from anon, authenticated;
