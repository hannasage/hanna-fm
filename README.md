# hanna.fm

A map of what Hanna listens to. A 3D genre map, weekly charts, a shelf of records, playlists to sample, and a recommender over one listener's library.

This repository holds the website. The poller and the export import live in a separate repository, so this one never holds Spotify tokens, data files or export files.

Status: in development.

## Rules for every commit

- No credential, token, data file or export file, ever.
- Secrets live in the host's secret stores only.
- Four gates must pass at zero errors before a commit: typecheck, lint, test, build.
- Work on a branch and open a pull request. Never commit to `main`.

## Fake data for local work

`npm run db:seed-fake` fills the local Supabase stack with about two years of invented plays. It refuses any address that is not 127.0.0.1 or localhost, and it is safe to run again. `fixtures/fake-export/` holds a fake export file in the assumed Spotify format. Its keys are unverified guesses and its data is fake.

## Make your own

Fork it, change it, and run it for yourself, for noncommercial purposes. You will need your own:

- Supabase project, for the database.
- Spotify developer app in Development Mode. Spotify requires the app owner to have Premium.
- Copy of the companion ingest repository, which fills the database.
- Host for the Next.js site, such as Vercel.

A setup guide is not written yet. Spotify, MusicBrainz and Last.fm each have their own terms for what you may do with their data. Read them before you publish a fork.

## License

PolyForm Noncommercial 1.0.0. You may use, change and share this software for noncommercial purposes, including personal, hobby, research and educational use. You may not use it in a paid product or for commercial gain. This is a source-available license, not an open source license as the OSI defines one. See `LICENSE`.
