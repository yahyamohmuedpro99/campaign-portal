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

## Open operational issues

- **Vercel blocked deployments on the commit author, and it was misread twice.** Every
  deployment after the first came back `readyState: BLOCKED`. It looked like free-tier
  rate limiting, then like a disabled project (`GET /v9/projects/{id}` reports
  `live: false`). Both readings were wrong. The dashboard states the real reason: *"the
  commit author did not have contributing access to the project on Vercel. The Hobby Plan
  does not support collaboration for private repositories."*

  The commits were authored by a git identity other than the account holder; the Vercel account is
  `yahyamohmuedpro99 <yahyamohmuedpro99@gmail.com>`. Vercel reads the author out of the
  git metadata the CLI attaches and, on Hobby with a private repository, refuses anyone
  who is not the account holder. The repository identity is now the personal address, so
  new commits deploy.

  Two lessons worth keeping: `readyState: BLOCKED` carries no reason through the API or
  the CLI — only the dashboard says why — and a Hobby deployment is tied to *who wrote the
  commit*, not to who ran the deploy.
- **Google sign-in needs its OAuth client.** Everything else is done and applied; see
  `docs/google-sign-in-setup.md`.
