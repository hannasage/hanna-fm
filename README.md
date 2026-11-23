# hanna.fm

A map of what Hanna listens to. A 3D genre map, weekly charts, a shelf of records, playlists to sample, and a recommender over one listener's library.

This repository holds the website. The poller and the export import live in a separate private repository, so this one never holds Spotify tokens, data files or export files.

Status: in development. Private until the first public release.

## Rules for every commit

- No credential, token, data file or export file, ever.
- Secrets live in the host's secret stores only.
- Four gates must pass at zero errors before a commit: typecheck, lint, test, build.
- Work on a branch and open a pull request. Never commit to `main`.
