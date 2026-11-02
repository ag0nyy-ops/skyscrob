# Phase 0 spike (throwaway)

Measures how Apple Music's `GET /v1/me/recent/played/tracks` actually behaves, so the
scrobbler is built around real data instead of guesses. Zero dependencies, Node 20+.
Takes ~40 minutes, most of it just listening to music.

Nothing here is used by the real service. Tokens go in `spike/.secrets.json` and logs in
`spike/logs/`, both gitignored.

## 1. Get a Music User Token (2 min)

You need your MusicKit key (`.p8`), its Key ID, and your Team ID.

```bash
APPLE_TEAM_ID=XXXXXXXXXX APPLE_KEY_ID=YYYYYYYYYY APPLE_P8=~/Downloads/AuthKey_YYYYYYYYYY.p8 node spike/token-server.mjs
```

Open http://localhost:8790, click **Authorize Apple Music**, sign in. Then Ctrl+C.

## 2. Start the poller (leave it running)

**Quit the Music app on your Mac first** (we want to see what the cloud sees from the phone).

```bash
node spike/poll.mjs
```

Every time you do something on the phone, type a short note in that terminal and hit
Enter, the moment you do it. That's a timestamped marker; it's how we measure delay.

## 3. Do these on your iPhone (type the marker right as you tap)

| #   | What to do                                                                                       | Markers to type                |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| 1   | Play a song you haven't played today, let it **finish**                                          | `A play`, then `A end`         |
| 2   | Play another song, **skip after ~10s**                                                           | `B play`, `B skip`             |
| 3   | Play a song, skip at **~60%**                                                                    | `C play`, `C skip`             |
| 4   | Play a song to the end, then **immediately play the same song again** (or repeat-one) to the end | `D play`, `D again`, `D end`   |
| 5   | Play song **A** again (it's further down the list now)                                           | `A replay`                     |
| 6   | Play **3 tracks of an album** in order, no skipping                                              | `album start`, `album end`     |
| 7   | Play an **artist/genre station** for 2 songs                                                     | `station start`, `station end` |
| 8   | Play **Apple Music 1 (live radio)** for ~2 min                                                   | `live start`, `live stop`      |
| 9   | **Pause** a song at ~30s, wait 5 min, then stop                                                  | `E play`, `E pause`            |
| 10  | Open Music on your **Mac**, play one song fully, quit it                                         | `mac play`, `mac end`          |
| 11  | Stop playing for **15 min** (leave poller running)                                               | `idle`                         |

Then Ctrl+C the poller and run the rate-limit probe (one burst, ~1 min):

```bash
node spike/poll.mjs --burst 200
```

## 4. Send the results

```bash
node spike/analyze.mjs spike/logs/<the poll file>.jsonl
```

Paste that output to me (it's song names + timings, no tokens). If you're OK with your
listening data in the repo as a test fixture, also run it with
`--fixture test/fixtures/spike-session-1.json` and commit that file.
