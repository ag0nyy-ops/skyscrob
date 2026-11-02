# Feasibility (Phase 0)

Status: **desk research done; live spike pending** (needs a real Apple Music account; see
`spike/README.md`). Decision so far: **provisional GO**, explained at the bottom.

## 1. What already exists (checked 2026-11-02)

| Project                                                            | How it gets plays                                                                                                   | Why it doesn't solve this                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| FastScrobbler (iOS/macOS app)                                      | On-device; has an _experimental_ Apple Music API import of the last 30 recently played tracks, estimates timestamps | An app on your phone. The API importer isn't in its public source; license is personal-use only, no redistribution. No server.   |
| bijou.fm, QuietScrob, Scrobbly (iOS apps)                          | On-device listening history / background refresh                                                                    | Closed source, need an app on the phone, best-effort background behaviour, reviews report missed plays when the app isn't alive. |
| ripleyintheair/apple-music-lastfm-scrobbler (Python, macOS)        | AppleScript reads Music.app's synced play history every 5 min                                                       | Needs a Mac running with Music open. Not device-independent.                                                                     |
| Scrobbles for Last.fm, Scrobblr, Audioscrobbler (macOS)            | Local Music.app now-playing                                                                                         | Only scrobbles what plays on that Mac.                                                                                           |
| osfv/AppleMusicScrobbler, SpaceChildDev/lastfm-scrobbler (Windows) | Windows media session                                                                                               | Only that PC.                                                                                                                    |
| "ScrobbleCloud" (scrobblecloud.com)                                | Claims cloud scrobbling "even when the app is closed"                                                               | Couldn't reach the site from the build environment; no source, no technical detail found. Can't evaluate. Not open source.       |

**Conclusion:** I found nothing open-source and self-hostable that scrobbles Apple Music
server-side from any device. Building it is justified.

## 2. What Apple documents

From the Apple Music API reference (`get-v1-me-recent-played-tracks`, fetched 2026-11-02):

- `GET https://api.music.apple.com/v1/me/recent/played/tracks`
- Headers: `Authorization: Bearer <developer token>` + `Music-User-Token: <token>`.
- `types` is **required**: `songs`, `library-songs`, `music-videos`, `library-music-videos`.
- `limit`: **default 30, maximum 30**. `offset` exists (paging).
- Returns song resources: `name`, `artistName`, `albumName`, `durationInMillis`, `isrc`,
  `playParams`, artwork, etc. **No play timestamp, no play count, no "played at" field.**
- 401 = developer token problem; 403 = Music User Token invalid/expired; 429 = rate limited
  (no published numbers; "resolves itself shortly").
- Developer tokens: ES256 JWT, max 6 months. Music User Tokens: issued by MusicKit JS in a
  browser. Apple doesn't document their lifetime; the community figure is ~6 months.

From the developer forums / community (unverified until the spike):

- **Repeat plays collapse.** A Dec 2025 forum post reports songs played several times in a
  row appear **once**: the endpoint is a list of distinct recent tracks, not a play log.
  A replayed song presumably moves back to the top.
- History depth reports vary (30 vs. 50). We only rely on the first 30.
- No published data on how soon a play appears.

## 3. What only the spike can answer

| Question                                                        | Why it matters                                  | Result    |
| --------------------------------------------------------------- | ----------------------------------------------- | --------- |
| When does a play appear: at start, after N seconds, at the end? | Decides now-playing support and the skip filter | _pending_ |
| Do skipped / short plays appear at all?                         | If Apple filters skips, we don't need to        | _pending_ |
| Back-to-back repeat: any visible change?                        | Whether repeats are 100% invisible              | _pending_ |
| Replay of an older song: does it jump to the top?               | Core assumption of the diff algorithm           | _pending_ |
| Stations / Apple Music 1 live radio: do tracks show?            | Coverage                                        | _pending_ |
| iPhone vs. Mac: same behaviour?                                 | Coverage                                        | _pending_ |
| Rate limit: when do 429s start, any headers?                    | Poll budget per developer token                 | _pending_ |
| Does `include=albums` work on this endpoint?                    | "Prefer album artist" option                    | _pending_ |

## 4. Provisional design (built so the spike results only tune constants)

The scrobble engine (`src/core/`) is written so the unknowns above are configuration, not
architecture:

- **Snapshot diff, not a play log.** Each poll is compared to the previous snapshot. New
  plays are the items that appeared at, or moved to, the head of the list while the rest
  of the list stays consistent. Handles both "distinct list" and "true log" semantics.
  Anything that doesn't line up (stale replica, reordering) is treated as an anomaly and
  not scrobbled.
- **Timestamps are estimated** from detection time and track durations, kept monotonic and
  non-overlapping, never in the future, and flagged `ts_approx` in the database.
- **`DETECTION_MODE`** = `start` (a track shows up while it's playing: send now-playing,
  scrobble when it's been on top past Last.fm's threshold or when it's displaced, drop
  displaced tracks that clearly weren't listened to long enough) or `end` (a track shows
  up after it's played: scrobble on detection, chain timestamps backwards).
  Default: `start` (the more conservative of the two). The spike decides.
- **Back-to-back repeats are assumed invisible** and documented as missed.
- **Adaptive polling:** every minute while you're listening, backing off to 5 then 10
  minutes when idle. 30 items of buffer means a 10-minute gap can't lose plays (except
  repeats), only delay them.

## 4b. Simulated accuracy (until real data exists)

`test/tracker.test.ts` simulates a listener (25 seeds × 8 hours: 70% full plays, 15% quick
skips, 15% partial plays, 5% back-to-back repeats, random idle stretches) against an Apple
list with "start" semantics and a fixed 20 s lag, polled every ~60 s with idle back-off.
Measured on 2026-11-02:

| Metric                                                                                        | Result                                                     |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Plays that passed Last.fm's threshold and were scrobbled (recall, excl. back-to-back repeats) | **98.1%**                                                  |
| Start-time error, median / p90 / p99                                                          | **18 s / 31 s / 218 s**                                    |
| Quick skips (< 25 s) scrobbled anyway                                                         | **27%** (mostly short songs where a skip straddles a poll) |
| Scrobbles that don't correspond to a real play                                                | **0** (asserted)                                           |
| Timestamps in the future or out of order                                                      | **0** (asserted)                                           |

These are numbers for the _model_, not Apple. The spike tells us whether the model is right.

## 5. Go / no-go

**Provisional GO.** The API is documented, works server-side with a stored Music User Token,
and returns enough metadata (artist, track, album, duration) to scrobble. The known
weaknesses are real but acceptable for a background scrobbler if disclosed:

1. Timestamps are approximate (estimated to within roughly one poll interval while you're
   listening, worse right after an idle period).
2. Back-to-back repeats of the same song are almost certainly invisible.
3. Delay is at least one poll interval (~1 min) plus whatever Apple's own delay is.

It would become **NO-GO** if the spike shows any of: plays show up hours late or
unpredictably; the list reorders in ways that make diffs unreliable; or the rate limit is
too low to poll even one user every minute.
