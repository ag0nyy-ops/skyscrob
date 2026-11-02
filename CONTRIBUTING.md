# Contributing

Thanks for helping. Short version:

1. `npm install`, then `npm test`, `npm run typecheck`, `npm run lint` must pass. CI runs the
   same on every push and PR.
2. Tests never touch the real Apple Music or Last.fm APIs. Use the fakes in `test/support/`.
3. Changes to the scrobble engine (`src/core/`) need a test that shows the case, ideally a
   scenario in `test/tracker.test.ts`. The simulated-listening test there is a regression
   guard: if your change moves its printed recall/error numbers, say so in the PR.
4. Never log tokens or session keys, never return them from an API, and never commit secrets.
   `npm run secrets:scan` checks the whole history.
5. Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`...), small and focused.

## Recording real Apple Music behaviour

The most useful contribution right now is data. Run the spike in `spike/README.md` with your
own account and open an issue with the `analyze.mjs` output (it contains song names and
timings, no tokens). Different countries, devices and listening styles all help.

## Running locally without accounts

`node scripts/mock-upstreams.mjs` starts fake Apple Music + Last.fm servers. See the README's
Development section.
