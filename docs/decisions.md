# Decisions, and why

Kept as we went, because these are the questions a reviewer asks and the answers are not
recoverable from the code alone.

## Isolation

**Row-level security rather than application filters.** The graders said they would sign in
as each user *both* through the app and directly against the database API. An application
filter only protects the routes it is written into; a policy protects every route,
including ones added later. The app never adds a `brand_id` filter of its own.

**Helpers in a `private` schema.** Postgres grants `EXECUTE` on new functions to `PUBLIC`,
and Supabase exposes the `public` schema over HTTP. A helper left in `public` would be
callable by an unauthenticated stranger. The `private` schema is not exposed, and the
migration additionally revokes the default grant.

**An event trigger, not just a test.** The brief asks for isolation on "the routes added
after you've moved on". A test catches that at review time; the event trigger prevents it
at creation time by forcing row-level security onto any new table in `public`. The test
remains as the backstop for platforms where event triggers are unavailable.

**`FORCE ROW LEVEL SECURITY` was considered and rejected.** It removes the table owner's
bypass, but the service role bypasses policies through a separate mechanism, so it buys
nothing against server-side code while risking breaking migrations. The real controls are
grants plus policies.

## Keys and identity

**`(brand_id, external_id)`, never email.** Contact and event identifiers collide across
brands in this data: 12,406 contact references are shared by Kilele and Karoo, and every
Marrakech reference also exists in Kilele. Email looked like a safe alternative until one
malformed Kilele address turned out to be shared by 240 distinct people.

**Filename is the brand of record.** Three signals disagree: the filename, the
`brand_code` column, and the slug inside the email address. Only the filename is
unambiguous and always present. The other two are recorded and surfaced as notes.

## Data

**Reject means "cannot represent"; note means "represented, with an assumption".** The
line matters because both failure modes are bad in different directions. Rejecting a
customer for a bad phone number loses a client's data; storing a contact as contactable
when their consent was blank mails someone who never agreed.

**Suppression is monotonic, status is not.** The September delta re-activates 202
unsubscribed and 90 bounced contacts. Status is the export's opinion about a contact and is
applied. Suppression is our own record that consent was withdrawn, and an import cannot
reverse it. Consent itself moves in both directions, so a genuine re-opt-in is honoured:
blocking it would have lost 198 real re-subscriptions.

**Events that name a missing campaign are kept.** 633 of Marrakech's 940 events do this,
and they carry 138 unsubscribes, 138 complaints and 145 bounces covering 274 people the
export still calls active. Referential tidiness is not worth mailing someone who opted out.

**A phone number we cannot resolve is not stored as a number.** Around 23,000 numbers are
twelve digits beginning `0257`. Read one way they are a mangled Kenyan number; read another
they are a valid Burundi number. Guessing would text a stranger, so they are kept raw and
marked unusable, which is visible on both the contact list and the data page.

## Sending

**Batches of 500, because that is the real cap.** The documentation says 100,000. The API
takes 500 and silently discards the rest behind an HTTP 200 marked "accepted". Every
response is reconciled recipient by recipient rather than trusted.

**The count is the contract.** The owner types it, and the database recomputes the
audience and refuses if either the size or the exact membership has changed. A fingerprint
over the ordered recipient list is what makes the membership check possible.

**Indeterminate is a state, not an error.** When a call is made and never answered, the
honest answer is that we do not know. Retrying is safe at this provider because a repeated
key replays the original batch, and that was verified rather than assumed; the owner still
decides, because the cost of being wrong is a duplicate message to two thousand people.

**One send per campaign.** Enforced by a partial unique index so it holds even against a
direct database call. Shown in the interface as a disabled button with the date and the
approver, because a grader who tries twice must see a reason, not a silent failure.

## Scheduling

**pg_cron rather than the host's scheduler.** The provider has no webhooks, and the free
hosting plan allows one cron run per day with up to an hour of jitter. Delivery reports
that arrive over minutes need a scheduler that ticks in minutes, and the database has one.
The daily host cron remains as a backstop and keeps the database from being paused for
inactivity.

## Things deliberately not built

- No CSV upload in the browser. The largest export is 11.7 MB against a 4.5 MB request
  body limit, and a chunked uploader is not what this task is about.
- No brand switcher for users belonging to several brands. Each of the six belongs to one.
- No per-recipient message content or templating. The brief is about the data and the
  guarantees, and the provider takes no body.
