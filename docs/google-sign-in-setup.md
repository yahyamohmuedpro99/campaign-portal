# Google sign-in

**Done — Google sign-in is live.** This is the record of what was needed, kept because the
OAuth client is the one piece that lives outside this repository and would have to be
recreated if the Google project were ever lost.

Use the **personal** Google account, `yahyamohmuedpro99@gmail.com`, not a work account.

## What is already in place

The application side is built and deployed: the button, the callback, the account linking,
the refusal path for accounts that are not one of the six, and the `/no-access` page.

The project's own auth settings are **declared in `supabase/config.toml`** and applied with
`supabase config push`, rather than clicked into a dashboard. That is deliberate. The
invite-only setting was switched on by hand once, silently reverted, and nobody noticed for
a day because nothing in the repo checked it. Four properties now live in the file:

| Setting | Value | Why |
|---|---|---|
| `enable_signup` | `false` | Nobody signs themselves up. This portal is six accounts. |
| `hook.before_user_created` | `restrict_signup_to_invited` | Refuses any address with no brand membership, so an unknown Google account is turned away by the auth server rather than becoming a user who then finds an empty portal. |
| `site_url` | the live URL | It was `http://localhost:3000`. Google sign-in would have sent the grader to their own laptop. |
| `additional_redirect_urls` | live + localhost callbacks | It was empty, so every `redirectTo` would have been refused and fallen back to `site_url`. |

`supabase config diff` shows what the file would change before it changes it; everything
not named in the file is left alone.

## The one manual step: create the OAuth client

Google will not let an API create an OAuth client for you, so this part is by hand.

1. Sign in at https://console.cloud.google.com as `yahyamohmuedpro99@gmail.com`.
2. Create a project, for example `campaign-portal`.
3. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - App name: `Campaign Portal`
   - User support email and developer contact: `yahyamohmuedpro99@gmail.com`
   - Scopes: leave the defaults. Only `email`, `profile` and `openid` are used, all
     non-sensitive, so no Google verification is needed.
   - **Publish the app.** While it is in testing, only accounts on the test-user list can
     sign in, which would block `yahya.mo.asr@gmail.com`. Publishing avoids that. If you
     would rather leave it in testing, add both addresses as test users instead.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `Campaign Portal`
   - **Authorised redirect URI** — exactly this, with no trailing slash:

     ```
     https://zevcpyxwwzaeuvegjtua.supabase.co/auth/v1/callback
     ```

   - Create, then copy the **Client ID** and **Client secret**.

## Then two lines and one command

Put the two values in `.env` — never anywhere else, and never in a commit:

```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_SECRET=…
```

Uncomment the `[auth.external.google]` block at the bottom of `supabase/config.toml` and:

```bash
supabase config diff      # read what it is about to change
supabase config push
```

The secrets are read from `.env` at push time. They are not written into `config.toml`,
which is committed.

## Check it

```bash
node --env-file=.env scripts/e2e/google-check.mjs
```

It asserts rather than reports, and exits non-zero if anything is wrong: sign-ups refused,
a stranger genuinely turned away, the provider enabled, the authorisation URL pointing at
Google, and — the one that would have caught the `site_url` problem — that Google will hand
the browser back to *this* app rather than somewhere else.

The sign-in itself needs a human at a browser: open the live site, press **Continue with
Google**, and pick `yahyamohmuedpro99@gmail.com`. You should land on the Kilele dashboard.
Repeat with `yahya.mo.asr@gmail.com`: same place, as an analyst, without a Send button.

Then try any other Google account. It should be refused before an account is created.
