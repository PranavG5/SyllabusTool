# Deployment

## Current state

| Piece | Status |
|---|---|
| Supabase project `syllabus-tool` | **Live** — `oeglyntvzfmcbejyuygj`, us-east-1, free tier |
| Schema, RLS, functions, storage bucket | **Applied** — migrations 0001–0005 |
| Live security posture | **Verified** — see below |
| Git `main` branch | **Pushed** |
| Vercel project | **Blocked** — the connected integration returns 403 on project creation |
| `SUPABASE_SERVICE_ROLE_KEY` | **Needed from you** — no API exposes it, by design |
| `ANTHROPIC_API_KEY` | **Needed from you** — extraction cannot run without it |

`Fesst` was paused to free a Supabase free-tier slot, as agreed. Restore it from
the Supabase dashboard whenever you need it; nothing else about it was touched.

## What was verified against the live database

Queried from outside with the public anon key, exactly as a browser would:

- All nine user-data tables return `401 permission denied` to `anon`.
- `plan_limits` is readable, which is intended — the UI shows real limits.
- Every `SECURITY DEFINER` function is unreachable; PostgREST does not even
  list `rotate_feed_token` or `handle_new_auth_user` for `anon`.
- Supabase's security advisor is clean apart from two deliberate findings:
  `rate_limits` has RLS on with no policies (doubly closed on purpose), and
  `rotate_feed_token` is callable by signed-in users (that is its job).

## Finishing the deploy

### 1. Create the Vercel project

The MCP integration is refused with
`403 forbidden … "action":"create","resource":"project"`, so this one step has
to happen in the dashboard:

1. Vercel → **Add New → Project** → import `PranavG5/SyllabusTool`.
2. Name it **`syllabus-tool`**. Framework detection (Next.js) is correct; leave
   the build settings alone.
3. Set **Production Branch** to `main` (Settings → Git).
4. Do **not** deploy yet — add the environment variables first, or the first
   build will deploy an app that cannot reach its database.

### 2. Set the environment variables

Paste these into Settings → Environment Variables, for **Production, Preview and
Development**. The generated secrets are in `.deploy/vercel-env.txt`, which is
gitignored — copy them out before this workspace is reclaimed.

```
NEXT_PUBLIC_SUPABASE_URL=https://oeglyntvzfmcbejyuygj.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_PeETvlFAp2L8Xl8RgK0Ymw_Xi_Ias89
NEXT_PUBLIC_SITE_URL=https://<your-vercel-domain>
SUPABASE_SERVICE_ROLE_KEY=<Supabase → Settings → API → service_role>
ANTHROPIC_API_KEY=<console.anthropic.com → API keys>
ANTHROPIC_MODEL=claude-opus-5
TOKEN_ENCRYPTION_KEY=<from .deploy/vercel-env.txt>
JOB_WORKER_SECRET=<from .deploy/vercel-env.txt>
CRON_SECRET=<from .deploy/vercel-env.txt>
```

Two of these you have to fetch yourself:

- **`SUPABASE_SERVICE_ROLE_KEY`** — Supabase deliberately does not expose the
  secret key through any API, so no tool can read it. Dashboard → Project
  Settings → API → `service_role`. It bypasses RLS; treat it like a root
  password and never put it anywhere with a `NEXT_PUBLIC_` prefix.
- **`ANTHROPIC_API_KEY`** — extraction is the product; without this the demo and
  every build return a clean "our extraction service is unavailable" error.

`NEXT_PUBLIC_SITE_URL` must match the real domain. It builds the calendar-feed
URLs and the Google OAuth redirect, so a wrong value produces feed links that
point at the wrong host.

### 3. Point Supabase Auth at the deployed domain

Supabase → Authentication → URL Configuration:

- **Site URL**: `https://<your-vercel-domain>`
- **Redirect URLs**: add `https://<your-vercel-domain>/auth/callback`

Without this, magic-link sign-in bounces users to `localhost`.

To enable "Continue with Google" for sign-in (separate from Google Calendar):
Authentication → Providers → Google, with credentials from a Google Cloud OAuth
client. The app works with email magic links alone if you skip it.

### 4. Deploy

Push to `main`, or hit Deploy in the dashboard. The build needs no environment
variables to succeed — every secret is read at request time — so a green build
does not by itself prove the configuration is right. Check step 5.

### 5. Verify

```bash
SITE=https://<your-vercel-domain>

curl -s -o /dev/null -w "%{http_code} landing\n"  $SITE/
curl -s -o /dev/null -w "%{http_code} privacy\n"  $SITE/privacy
curl -s -o /dev/null -w "%{http_code} schedule (expect 307 to /login)\n" $SITE/schedule

# Auth guards
curl -s -o /dev/null -w "%{http_code} api/schedule (expect 401)\n" $SITE/api/schedule
curl -s -o /dev/null -w "%{http_code} worker (expect 401)\n" -X POST $SITE/api/jobs/x/process
curl -s -o /dev/null -w "%{http_code} cron (expect 401)\n" $SITE/api/cron/purge
curl -s -o /dev/null -w "%{http_code} feed, bad token (expect 404)\n" $SITE/api/feed/notatoken.ics

# The real end-to-end check: the demo needs both Supabase and Anthropic.
curl -s -X POST $SITE/api/demo/extract -H 'Content-Type: application/json' \
  -d '{"text":"CS 2110\nProblem Set 1 due Sep 4\nPrelim 1 on Sep 30 at 7:30 PM"}' | head -c 400
```

The last call is the one that matters. It should return two items: Problem Set 1
with `"dueTime": null` (a day-level deadline) and Prelim 1 with `"dueTime":
"19:30"` (a stated time).

Then sign in, upload a syllabus, and confirm the schedule renders.

### 6. Cron

`vercel.json` already registers the daily retention sweep on `/api/cron/purge`.
Vercel picks it up on the first production deploy. Confirm it appears under
Settings → Cron Jobs, and that `CRON_SECRET` is set — the route returns 401
without it, so a misconfigured cron fails loudly rather than silently skipping
the 30-day file deletion.

### 7. Google Calendar (optional, and slow)

The app runs without it — students can still download `.ics` and subscribe to
the feed. When you want it, `docs/GOOGLE_OAUTH.md` has the setup and the
verification requirements. Budget several weeks for Google's review; the
calendar scope is classified sensitive.

## Rotating a leaked secret

- `TOKEN_ENCRYPTION_KEY` — **do not rotate casually.** It decrypts stored Google
  refresh tokens; changing it orphans every existing calendar connection and
  users must reconnect. If you must, clear `calendar_connections` first.
- `JOB_WORKER_SECRET` / `CRON_SECRET` — safe to rotate any time. Update the
  Vercel variable and redeploy.
- `SUPABASE_SERVICE_ROLE_KEY` — rotate in the Supabase dashboard, then update
  Vercel.
- A user's calendar feed token — the student rotates it themselves from
  `/account`; the old URL stops working immediately.
