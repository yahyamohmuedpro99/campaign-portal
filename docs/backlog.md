# Backlog

Things found and consciously not done, with what it would take.

## Known limits

- **Five wrong passwords locks a shared link for fifteen minutes.** A client who fat-fingers
  their password waits. A progressive delay would be kinder than a hard cutoff.
- **The recipient list on the confirmation screen shows the first 25.** For a send of
  40,000 an owner may reasonably want to search it. The audience function already supports
  paging; only the interface is missing.
- **A brand with several members cannot see who else is on the team.** The membership
  policy is deliberately restricted to your own row to prevent enumeration. A view exposing
  names without user ids would be a better answer.
- **Delivery-report polling stops after 30 days.** Reasonable for this data, arbitrary as a
  rule.
- **The importer is a command-line tool.** A marketer cannot load a file themselves. A
  presigned upload straight to storage with a worker behind it is the shape of the answer.

## Data questions worth asking the client

- The ~23,000 twelve-digit numbers beginning `0257` are unusable as written. If they are a
  mangled Kenyan format, one rule recovers all of them; guessing would text strangers.
- Around 12% of Kilele contacts have no consent value at all. They are treated as
  not contactable. If the source system means "yes" by silence, that is a large audience
  currently excluded, and the opposite mistake is worse.
- The campaign exports have no status column. Draft is inferred from the name and a zero
  send count, which is a guess about a convention.
- The `reported_*` figures disagree with the engagement log by a wide margin in every
  brand. Worth knowing which the client trusts before either is used for a decision.

## If there were another day

- Materialise per-campaign observed counts. The dashboard query counts distinct contacts
  over 300,000 events for the largest brand; it is fast enough now and will not stay that
  way.
- A background job to reconcile a send against the provider from scratch, for when a
  cursor is lost.
- Contact detail pages, so a name on the exclusion list can be opened.
- Dark-mode review. The tokens are defined for both themes but only light has been looked
  at closely.

## Resolved, kept because the diagnosis was the hard part

- **Vercel blocked every deployment, and it was misread twice.** Every deployment after
  the first came back `readyState: BLOCKED`. It looked like free-tier rate limiting, then
  like a disabled project (`GET /v9/projects/{id}` reports `live: false`). Both readings
  were wrong. The dashboard gives the real reason, and only the dashboard does: *"the
  commit author did not have contributing access to the project on Vercel. The Hobby Plan
  does not support collaboration for private repositories."*

  The commits carried a different git identity from the one that owns the Vercel account.
  Vercel reads the author out of the git metadata the CLI attaches — for command-line
  deploys too, not only git-integration ones — maps it to a GitHub login, and on Hobby
  with a private repository refuses anyone who is not the account holder. Setting the
  repository's `user.email` to the account holder's fixed it; the next deploy succeeded.

  Two things worth keeping: `readyState: BLOCKED` carries no reason through the API or the
  CLI, and a Hobby deployment is tied to *who wrote the commit*, not to who ran the deploy.

- **Google sign-in.** Live. The OAuth client is the one piece of this system that lives
  outside the repository; `docs/google-sign-in-setup.md` records what it needs so it can be
  recreated. Signing in links the Google identity to the existing seeded user rather than
  creating a second account, which was an assumption until a real sign-in confirmed it.

- **The scheduler.** `delivery-reports-tick` has run every minute for 22 hours — 1,307
  successful runs against 4 failures, all four in the first three minutes before the
  `pg_net` schema path was corrected. Most of those runs happened with nobody using the
  app, which is the property the brief actually asks for.
