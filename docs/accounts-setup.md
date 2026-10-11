# Switching on accounts, follows and watchlists

What this is: optional accounts (sign in with an emailed code, or Google, Microsoft or GitHub) that
keep watchlists of NSNs, suppliers, manufacturers, supply classes, solicitations, agencies and saved
Open-demand searches, and show which public records were added since each item was last reviewed.
The code is built, tested and merged with a master switch OFF, so nothing shows on the live site
until the steps below are done. Modelled on SpotTheMoney's setup (its `CLAUDE.md`, "Accounts and
watchlists with WorkOS").

## How it fits together

- **Sign-in:** WorkOS AuthKit. `/auth/login` sends the visitor to WorkOS, `/auth/callback` trades the
  code for tokens and sets the cookies, `/auth/logout` (POST only) ends the session. Code:
  `web/src/pages/auth/*`, `web/src/lib/server/session.ts`.
- **Cookies** (all first party, always Secure and SameSite=Lax): `nsn_session` (the sealed session,
  HttpOnly, 30 days), `nsn_signed_in` (a flag pages can read so anonymous visitors never call the
  Function, 30 days), `nsn_oauth_state` (the sign-in handshake, 10 minutes).
- **Data:** Supabase (project `slprnvtdgzmpeqsmemgq`). The Pages Function calls Supabase PostgREST
  (`/rest/v1/rpc/<function>`) over HTTPS with the visitor's WorkOS access token. Row-level security
  keys on `auth.jwt()->>'sub'`. **Nothing for accounts goes through Hyperdrive** (its free plan stops
  at 100,000 queries a day); cards and shared lists use the Supabase REST endpoint too.
- **Schema:** `db/migrations/0009_accounts_watchlists.sql`. It runs by itself on the next deploy to
  `main` (deploy.yml runs `db/migrate.mjs` against `SUPABASE_DB_URL`), even with the switch off. It
  only adds tables and functions in `public`, plus indexes and select grants on a few `pub` tables.
- **Account API:** `/api/me`, `/api/account/<action>`. Never cached; POSTs must carry the page's own
  Origin.
- **Master switch:** `ACCOUNTS_ENABLED` in `web/src/lib/account.ts`. It is a build-time constant, so
  flipping it needs a new deploy. While false: no Follow buttons, no header watchlist button, no
  Save this search, `/watchlist/` says accounts are coming, `/auth/*` and `/api/account/*` answer 404
  and `/api/me` answers `{"signedIn":false,"available":false}`.

## Steps (Peter)

### 1. WorkOS

1. In the WorkOS team `pfouge.com`, create a project named `nsnexplorer` and use its **Production**
   environment.
2. Redirects: redirect URI `https://nsnexplorer.com/auth/callback`; sign-in (initiate login) URL
   `https://nsnexplorer.com/auth/login`; sign-out redirect `https://nsnexplorer.com/`.
3. Authentication methods: turn on **Magic Auth** (emailed code). Do not turn on passwords or Apple.
4. Session settings: 5-minute access token, 30-day inactivity timeout, 365-day maximum (as on
   SpotTheMoney).
5. JWT template (Authentication -> Sessions -> JWT template), so Supabase accepts the token:
   ```json
   {"role": "authenticated"}
   ```
6. Providers (Authentication -> Providers): enable **Google**, **Microsoft** and **GitHub**. Each
   needs its own OAuth app made for this site (do not reuse SpotTheMoney's):
   - GitHub: OAuth app "NSN Explorer", callback URL = the redirect URI WorkOS shows for GitHub.
   - Google: a Google Cloud OAuth client (consent screen External, In production), redirect URI =
     the one WorkOS shows for Google.
   - Microsoft: an Entra ID app registration, redirect URI = the one WorkOS shows for Microsoft.
   Paste each client ID and secret into WorkOS.
7. Note the **client ID** (`client_...`, public) and make an **API key** (`sk_...`, secret) named
   `nsnexplorer-pages`.

### 2. Supabase

1. Authentication -> Sign In / Providers -> **Third-Party Auth** -> add **WorkOS** with the issuer
   `https://api.workos.com/user_management/<WorkOS client ID>`.
2. Settings -> API: copy the project URL (`https://slprnvtdgzmpeqsmemgq.supabase.co`) and the
   **publishable key** (`sb_publishable_...`, public by design).
3. Confirm the migration ran (after the first deploy of this branch): `select filename from
   public.schema_migrations where filename like '0009%';` Exposed schemas stay at the default
   (`public`); `pub` must NOT be exposed.

### 3. Cloudflare Pages (project for nsnexplorer.com, Production)

Settings -> Variables and Secrets:

| Name | Type | Value |
|---|---|---|
| `WORKOS_CLIENT_ID` | plain text | the WorkOS client ID |
| `SUPABASE_URL` | plain text | `https://slprnvtdgzmpeqsmemgq.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | plain text | the `sb_publishable_...` key |
| `WORKOS_API_KEY` | secret | the WorkOS API key |
| `WORKOS_COOKIE_PASSWORD` | secret | 32 or more random characters: `openssl rand -base64 32` |

With any of these missing the site shows nothing account-related and `/api/me` answers
`available:false`, so a half-finished setup is harmless. (The three public values can instead be
committed as the defaults in `web/src/lib/account-config.ts`, `PUBLIC_DEFAULTS`.)

The Content-Security-Policy already allows the sign-out form to reach `api.workos.com`
(`form-action`, in `web/src/lib/csp.ts` and `web/public/_headers`). Sign-in itself is a plain link, so
needs nothing else. Pages Functions are already enabled for this project (the NSN pages use them).

### 4. Switch it on

1. In `web/src/lib/account.ts`, change `false || forcedOn()` to `true`. Commit and push to `main`.
2. After the deploy, check by hand:
   - `https://nsnexplorer.com/api/me` -> `{"signedIn":false,"available":true}`
   - `https://nsnexplorer.com/auth/login` -> redirects to a WorkOS page; sign in; you land on
     `/watchlist/`.
   - Press Follow on an NSN page, reload: it reads "Following"; `/watchlist/` shows the item with
     its card. Header bookmark shows a count when something changed.
   - Share a list, open the link in a private window (cards load, no email shown), copy it from a
     second account, sign out, and delete the test account from `/watchlist/`.
3. Update the page copy if the lead wants it: `privacy` (#accounts), `terms` (#accounts), `about`
   (WorkOS credit), and the guide `how-to-follow-parts-suppliers-and-solicitations` (it carries a
   "not switched on yet" note while the switch is off; that note disappears by itself).

## Checking it locally (no outside service)

```
PUBLIC_ACCOUNTS_FORCE=1 DATABASE_URL=postgresql://root:gpxlocal@127.0.0.1:5432/gpx_w_entity npm run build --workspace=web
node web/scripts/accounts-db-prepare.mjs postgresql://root:gpxlocal@127.0.0.1:5432/gpx_w_entity gpx_acct
node web/scripts/verify-accounts-db.mjs  postgresql://root:gpxlocal@127.0.0.1:5432/gpx_acct
node web/scripts/verify-accounts-e2e.mjs postgresql://root:gpxlocal@127.0.0.1:5432/gpx_acct <dist-dir>
node web/scripts/accounts-shots.mjs      postgresql://root:gpxlocal@127.0.0.1:5432/gpx_acct <dist-dir> <out-dir>
```

`PUBLIC_ACCOUNTS_FORCE=1` forces the switch on for that build only. The verifiers use fakes for WorkOS
and Supabase (`web/scripts/accounts-fakes.mjs`) and need Playwright; they refuse a non-local database.
wrangler in a sandbox sometimes drops connections: rerun, after `pkill -f "[w]orkerd"`.

## What an account keeps (for the privacy page)

WorkOS user id, email, lists and their items (kind, key, label, optional note, when added and last
reviewed, and for solicitations a snapshot of status, return-by and quantity so a change can be
shown), whether a list is shared and its link slug. Not kept: which pages a signed-in visitor reads.
Limits: 20 lists, 500 items per list. Deleting the account removes all of it and the WorkOS user.
