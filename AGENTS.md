# hanna.fm

The website for hanna.fm: a map of what one listener listens to. Next.js, TypeScript, Supabase. Private until the first public release. The spec is GitHub issue 1 and the tickets that follow it.

## The four gates

Run all four before every commit. Each must report zero errors.

```
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` needs the local Supabase stack running (`npm run db:start`). It builds the site and starts copies of it itself.

## Never commit secrets or data

- No credential, token, key, data file or export file, ever. Not in code, tests, fixtures, logs or pull request text.
- Secrets live in the host's secret store. Local keys come from `supabase status` and stay in memory.
- Fixtures are synthetic. Nothing in this repo is real listening data.
- Only server code talks to the database. The browser holds no database key.

## Branch and pull request only

Never commit to `main`. Branch, commit in small steps (`type: summary`), open a draft pull request. A person merges it.

## Test seam

Tests call the site over HTTP, against a local Supabase. They do not mock the database. Add a test first for any change in behavior.

## Who builds

ECC agents build and review code here: `tdd-guide` to build, the reviewers (`code-reviewer`, `security-reviewer`, `silent-failure-hunter`) to review.
