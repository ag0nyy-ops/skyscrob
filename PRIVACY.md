# Privacy

Plain English. Applies to any skyscrob instance running this code unmodified. If someone else
runs an instance, they're the one holding your data, so check who that is.

## What's stored

| What                                                                                   | Why                                            | How long                                           |
| -------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| Your Last.fm username                                                                  | To know who you are                            | Until you delete your data                         |
| Your Last.fm session key, **encrypted** (AES-256-GCM)                                  | To scrobble for you                            | Until you delete your data or revoke it on last.fm |
| Your Apple Music User Token, **encrypted** (AES-256-GCM)                               | To read your recently-played list              | Until you disconnect, delete, or it expires        |
| Your settings (a few on/off switches)                                                  | To apply them                                  | Until you delete your data                         |
| The last ~30 entries of your recently-played list, as track IDs, plus a few timestamps | To tell what's new since the last check        | Replaced every check                               |
| Scrobbles from the last 14 days (artist, track, album, estimated time, status)         | To avoid duplicates and show you what was sent | Deleted automatically after 15 days                |
| A hash of your login cookie                                                            | To keep you signed in                          | 30 days, or until you sign out                     |

Nothing else. No email, no IP address log, no device info, no long-term listening history.
(Last.fm keeps your scrobbles, of course; that's the point.)

## What's never done

- No analytics, telemetry, tracking pixels, or ads.
- No third-party scripts, except Apple's MusicKit JS, loaded from Apple only when you click
  "Connect Apple Music", because that's how Apple's sign-in works.
- Tokens are never logged, never shown back to you, never sent anywhere except to Apple (your
  Apple token) and Last.fm (your Last.fm session key).
- Your data is never sold or shared. It goes to exactly one place: your Last.fm profile.

## Who can see it

- The server code only, using an encryption key held as a Cloudflare secret.
- The instance operator _could_ in principle read the database and the encryption key. If you
  self-host, that's you.
- Cloudflare hosts the database and runs the code (see Cloudflare's own privacy policy).
  Cloudflare's request logs may include IP addresses; skyscrob doesn't write them anywhere.

## Deleting

Dashboard → **Delete all my data**. That immediately deletes your user record, both tokens,
settings, sessions and every stored scrobble row. Then, to also cut off access at the source:

- Last.fm: <https://www.last.fm/settings/applications> → revoke.
- Apple: on iPhone, **Settings → Screen Time / Privacy** or on the web at
  <https://account.apple.com> (Apps using your Apple Account / Apple Music connections) → remove.

Backups: Cloudflare D1 keeps point-in-time recovery data for up to 30 days, managed by
Cloudflare. skyscrob doesn't make any other copies.
