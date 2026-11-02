# Hosted instance: launch checklist

skyscrob is **self-host only** right now. A shared instance that stores other people's tokens
doesn't launch until every box below is ticked. Each one is a hard gate: if any answer is
"no", there is no hosted version, and self-hosting stays the way to use it.

## Gates

- [ ] **Apple, in writing.** Ask Apple Developer Support (developer.apple.com/contact, MusicKit /
      Apple Music API topic) whether a free, non-commercial web service may read users'
      recently-played tracks with their Music User Token on a server and forward track metadata
      to Last.fm. Keep the reply. On-device scrobbler apps passing App Review is _not_ this
      answer: those run on the user's device, while this holds strangers' tokens on a server.

  Status: **not answered yet.** If Apple says no, or never answers, stay self-host only. Don't
  launch on silence.

- [ ] **Last.fm API terms, read live** at <https://www.last.fm/api/tos> (and
      <https://www.last.fm/api/scrobbling>). `docs/tos-notes.md` was written without being able to
      fetch them. Confirm a free multi-user web service is fine without a separate agreement, and
      re-check the rate-limit wording. If in doubt, email partners@last.fm.
- [ ] **Non-commercial, permanently.** No paid tier, no ads, no sponsorships, **no donate
      button**. Apple forbids "indirectly monetiz[ing]" access, and it's unclear whether donations
      count. Last.fm requires a separate agreement for commercial use.
- [ ] **Operator covers the costs:** Apple Developer Program ($99/yr) + Cloudflare Workers Paid
      ($5/mo at the time of writing, plus usage).

## Then, technically

- [ ] Workers Paid plan enabled on the Cloudflare account.
- [ ] `POLL_BATCH_SIZE = "100"` in `wrangler.toml` (each polled user ≈ 6–7 D1 queries; Paid
      allows 1,000 per invocation, Free only 50).
- [ ] `ALLOWED_LASTFM_USERS = "*"`.
- [ ] Watch `npx wrangler tail` for `apple_poll_failed` with `rate_limited`. Apple's rate limit is
      per developer token and unpublished; one shared token serves every user.
- [ ] Past a few hundred active users: move polling fan-out to Cloudflare Queues
      (`docs/future.md`).
- [ ] `PRIVACY.md` names the operator and a contact address.
- [ ] Security contact in `SECURITY.md` is monitored.
