# Enabling Google sign-in

Two steps, both in web consoles, about ten minutes. Everything on the application side is
already built and deployed: the button, the callback, the account linking, the refusal
path for accounts that are not one of the six, and the `/no-access` page they land on.

Use the **personal** Google account, `yahyamohmuedpro99@gmail.com`, not a work account.

## 1. Create the OAuth client (Google Cloud Console)

1. Sign in at https://console.cloud.google.com as `yahyamohmuedpro99@gmail.com`.
2. Create a project, for example `campaign-portal`.
3. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - App name: `Campaign Portal`
   - User support email and developer contact: `yahyamohmuedpro99@gmail.com`
   - Scopes: leave the defaults. Only `email`, `profile` and `openid` are used, all
     non-sensitive, so no Google verification is needed.
   - **Publish the app.** While it is in testing, only accounts added to the test-user list
     can sign in, which would block `yahya.mo.asr@gmail.com`. Publishing avoids that. If
     you would rather leave it in testing, add both addresses as test users instead.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `Campaign Portal`
   - **Authorised redirect URI** — exactly this, with no trailing slash:

     ```
     https://zevcpyxwwzaeuvegjtua.supabase.co/auth/v1/callback
     ```

   - Create, then copy the **Client ID** and **Client secret**.

## 2. Turn the provider on (Supabase dashboard)

1. Open https://supabase.com/dashboard/project/zevcpyxwwzaeuvegjtua/auth/providers
2. Find **Google**, enable it, paste the Client ID and Client secret, and save.
3. Go to **Authentication → URL Configuration** and set:
   - Site URL: `https://campaign-portal-ivory.vercel.app`
   - Additional redirect URLs:
     ```
     https://campaign-portal-ivory.vercel.app/auth/callback
     http://localhost:3000/auth/callback
     ```

### Optional, and recommended

On the same **Authentication** section:

- **Sign In / Providers → Auth Hooks → Before User Created**: choose the Postgres function
  `public.restrict_signup_to_invited`. It is already created and already granted to the
  auth admin role. It refuses any address that does not already hold a brand membership,
  which is what turns an unknown Google account into a clean refusal rather than a new
  account that then finds an empty portal.
- **Sign In / Providers → Allow new users to sign up**: turn off. Google sign-in keeps
  working for the six, because the auth server links a Google identity to an existing user
  with the same verified address and only the create-a-new-user branch is refused.

Neither is load-bearing on its own. An account with no membership can already read nothing,
because every row-level security policy is keyed to a membership it does not have, and the
callback signs such an account straight back out.

## 3. Check it

```bash
node --env-file=.env scripts/e2e/google-check.mjs
```

It reports whether Supabase is advertising Google as a provider and whether the
authorisation URL it generates is well formed. The sign-in itself needs a human at a
browser: open the live site, press **Continue with Google**, and pick
`yahyamohmuedpro99@gmail.com`. You should land on the Kilele dashboard. Repeat with
`yahya.mo.asr@gmail.com` and you should land in the same place as an analyst, without a
Send button.

Then try it with any other Google account. It should be refused and land on `/no-access`.
