# Terms of service notes

Not legal advice. This is a developer reading the terms as of **2026-11-02** and flagging
where skyscrob sits close to a line. If you run a hosted instance for other people, read the
source terms yourself.

## Apple: Developer Program License Agreement §3.3.6(D) "MusicKit"

Source: <https://developer.apple.com/support/terms/apple-developer-program-license-agreement/>
(fetched and quoted 2026-11-02).

| Clause (quoted)                                                                                                                                                                                               | How skyscrob relates                                                                                                                                                               | Risk                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| "You agree not to call the MusicKit APIs or use MusicKit JS ... for purposes unrelated to facilitating access to Your end users' Apple Music subscriptions."                                                  | We read the user's own listening history on their behalf, at their request. Arguably "facilitating access to their subscription data". Arguably not, since we don't play anything. | **Medium. The main ambiguity.**   |
| "album art and music-related text from the MusicKit API may not be used separately from music playback or managing playlists"                                                                                 | We forward track/artist/album names to Last.fm, separately from playback. Read literally, this is the clause we're closest to breaking.                                            | **Medium–high (literal reading)** |
| "Metadata from users (such as playlists and favorites) may be used only to provide a service or function that is clearly disclosed to end users and that is directly relevant to the use of Your Application" | Scrobbling _is_ the disclosed function. The onboarding page says exactly what's read and where it goes.                                                                            | Low, if disclosed (we do)         |
| "You agree not to require payment for or indirectly monetize access to the Apple Music service ... (e.g. in-app purchase, advertising, requesting user info)"                                                 | skyscrob is free, no ads, no analytics. A hosted instance must stay that way. Don't add a paid tier.                                                                               | Low (as built)                    |
| "You may use MusicKit JS only as a stand-alone library ... (e.g., You agree not to recombine MusicKit JS with any other JavaScript code or separately download and re-host it)"                               | We load it from Apple's CDN (`js-cdn.music.apple.com`), never bundle or re-host it.                                                                                                | Low                               |
| "If You access the MusicKit APIs or MusicKit JS, then You must follow the Apple Music Identity Guidelines."                                                                                                   | The product name doesn't contain "Apple" or "Apple Music". We refer to "Apple Music" by name only to describe what it connects to. No Apple logos.                                 | Low                               |

**Precedent:** several App Store apps (FastScrobbler, bijou.fm, others) read the same
recently-played data via MusicKit and send it to Last.fm, and passed App Review. That shows
Apple tolerates the use case in practice. It isn't a license interpretation, and those apps
run on the user's device, not a server holding many users' tokens.

**Developer token:** max lifetime 6 months (`exp` ≤ now + 15777000). We mint short-lived
tokens (12h) inside the Worker. Tokens handed to the browser for MusicKit JS carry an
`origin` claim locked to the deployment's URL, as Apple recommends for web clients.

**Rate limits:** Apple documents only that excess requests get `429 Too Many Requests`
per developer token, and that it "resolves itself shortly". No numbers. See
`docs/feasibility.md` for what the spike measured.

## Last.fm: API Terms of Service

Source: <https://www.last.fm/api/tos>. **The ToS page couldn't be fetched from the build
environment (network policy blocked last.fm)**, so the points below come from the official
intro/scrobbling docs as indexed by search plus what I know of the ToS. Verify against the
live page before running a hosted instance.

- **Non-commercial use** is free. Commercial use needs an agreement (partners@last.fm).
  skyscrob is non-commercial. Keep it that way.
- **Request rate:** accounts get suspended for "continuously making several calls per
  second". The commonly cited figure is ~5 requests/second per IP averaged over 5 minutes.
  skyscrob makes at most ~3 Last.fm calls per user per minute, only when something was
  played.
- **Scrobbling rules** (from the scrobbling docs): only tracks longer than 30 seconds; only
  after half the track or 4 minutes have played (whichever is first); timestamp = when the
  track _started_, UTC; at most 50 scrobbles per batch request. Old timestamps get ignored
  (we treat the cut-off as 14 days).
- **Accuracy:** scrobbles are meant to reflect actual listening. Our timestamps are
  estimated (the Apple API has no play times). That's the same thing every offline/cached
  scrobbler does, but it's disclosed in the README and flagged internally (`ts_approx`).
- **API key per deployer:** every self-hosted copy uses its own Last.fm API key/secret. The
  repo never ships one.
- **Multi-user apps** are the normal use of a Last.fm API account (web auth flow, one
  session key per user). Fine.

## Hosting other people's data (hosted mode)

If you run an instance for strangers, you're the data controller for their tokens and
(briefly) their listening data. GDPR/CCPA-style obligations apply: a privacy policy
(`PRIVACY.md` is written for this), working deletion (built), minimal retention (built:
14-day scrobble window, no long-term history), no selling/sharing (none).

## Bottom line

- **Self-hosting for yourself:** low practical risk. You're the developer and the only
  user; worst case, Apple revokes _your_ MusicKit key.
- **Public hosted instance:** real risk that Apple reads §3.3.6(D) literally and revokes the
  operator's key, which breaks it for everyone at once. **My recommendation: don't run a
  public hosted instance unless you've asked Apple (Developer Support → MusicKit) and got
  a non-objection in writing, or you're comfortable with that failure mode.** The code
  supports hosted mode (`ALLOWED_LASTFM_USERS=*`); the decision is yours.
