# Future ideas (not built)

## Mac companion for exact timestamps

A tiny menu-bar app (or `launchd` agent) on a Mac listening to Music.app's
`com.apple.Music.playerInfo` distributed notification gets the exact start time of every play
_on that Mac_. It would post those to the Worker (authenticated per user), and the cloud
scrobbler would treat matching plays as already handled, or better, use the exact timestamp in
place of its estimate. Plays on other devices still come from the API as today. The dedupe
pieces already exist (`findAlreadyScrobbled`); the missing parts are the agent and an
authenticated ingest endpoint.

## Sub-minute polling while listening

Cron Triggers fire at most once a minute. A cron run could poll a playing user twice (now and
+30 s), or a Durable Object alarm could tick every 20–30 s while someone is listening. That would
roughly halve timestamp error and skip false positives. Worth it only if the spike shows Apple's
rate limit leaves room for it.

## Notifications for expired tokens

Apple Music User Tokens expire (~6 months). Today the dashboard shows a banner. An optional
email (needs an email provider and storing an address, which conflicts with "store the
minimum") or a Last.fm-visible signal would help people notice sooner.

## Workers Queues for hosted scale

For hundreds of users, fan out polls through Cloudflare Queues instead of looping inside one
cron invocation.
