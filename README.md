# Syllabus Tool

Turns a student's syllabus material into a semester schedule they can export to
any calendar app.

Four screens: **Landing** (with a live demo that needs no account) → **Input**
(drag files, paste text, or both) → **Review** (an editable table where every row
links back to the source text) → **Schedule** (list and month views, plus
export). Landing page to exported calendar in under two minutes.

## Running it

```bash
npm install
cp .env.example .env.local     # fill in the values below
npm run dev
```

### Environment

| Variable | Where it goes | What it does |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | Anon key; RLS is what protects the data |
| `NEXT_PUBLIC_SITE_URL` | client + server | Public origin, used to build feed and OAuth URLs |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Bypasses RLS; used only where a session cannot exist |
| `ANTHROPIC_API_KEY` | **server only** | Extraction |
| `ANTHROPIC_MODEL` | server | Defaults to `claude-opus-5` |
| `ANTHROPIC_EFFORT` | server | Optional (`low`…`max`); the first cost lever to reach for |
| `TOKEN_ENCRYPTION_KEY` | **server only** | 32 bytes base64: `openssl rand -base64 32` |
| `JOB_WORKER_SECRET` | **server only** | Shared secret for the background worker route |
| `CRON_SECRET` | **server only** | Bearer token for the retention sweep (falls back to `JOB_WORKER_SECRET`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | **server only** | Google Calendar; optional — the app runs without it |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | server / client | Error tracking; optional |

Nothing without the `NEXT_PUBLIC_` prefix ever reaches the browser, and
`npm run test:unit` fails the build if one does — including a scan of the
compiled client chunks.

### Database

Apply `supabase/migrations/*.sql` in order (Supabase CLI, the SQL editor, or
`psql`). They create ten tables, enable Row Level Security on every one, add the
policies, and create the private `syllabi` storage bucket.

### Scheduled jobs

`vercel.json` registers a daily cron on `/api/cron/purge`, which deletes uploaded
files and their rows 30 days after processing.

## Architecture

```
Input  ──▶ POST /api/extract ──▶ quota gate (SQL, advisory-locked)
                              ──▶ parse + validate every file  (fails fast, costs nothing)
                              ──▶ create job row, return 202
                                        │
                          after() ──────┴──▶ POST /api/jobs/[id]/process   (own timeout budget)
                                                   │
   UI polls GET /api/jobs/[id] ◀───────────────────┤ chunk ▸ model ▸ normalise ▸ dedupe ▸ persist
   (re-triggers a dropped job)                     └──▶ usage_events (tokens + cost)
```

Extraction never blocks a request. A job is a database row; the poll endpoint
re-triggers one that is still `queued` past a grace period, so a dropped trigger
self-heals without a queue service to operate.

### Where the important decisions live

| Concern | File | The decision |
|---|---|---|
| Model contract | `src/lib/extract/schema.ts` | Strict structured output. Field descriptions are the extraction spec. |
| Never inventing a date | `src/lib/schedule/relative-dates.ts` | The model emits a structured reference; TypeScript resolves it. Unresolvable → null date, low confidence. |
| Dates vs. times | `src/lib/extract/normalize.ts` | A syllabus that names a day gets an all-day event. Only a stated time becomes a timed event. See "Why most deadlines are all-day" below. |
| DST | `src/lib/datetime.ts` | Stated times are civil date + wall time + IANA zone, converted at export, so a 7:30 PM exam stays 7:30 PM across the boundary. |
| No duplicate calendar events | `src/lib/ics/build.ts` | UID from the row id, SEQUENCE from a DB-maintained revision counter. |
| Quota | `supabase/migrations/0002_functions.sql` | One SQL function under a per-user advisory lock. A paid tier is a row in `plan_limits`. |
| Tenant isolation | `supabase/migrations/0003_rls.sql` | Postgres policies plus column-level grants, not application `WHERE` clauses. |

## Diagnosing a broken deployment

```bash
curl -s https://<your-domain>/api/health | jq
```

Names whichever dependency is broken rather than leaving you to infer it from a
vague user-facing message. Status only, never values — safe to paste into a bug
report. Every error response also carries a six-character reference echoed into
the server log line, so a screenshot is enough to find the exact request.

## Tests

```bash
npm run db:test:up     # throwaway Postgres for the RLS suite (or set TEST_DATABASE_URL)
npm test               # 228 tests, offline
npm run verify         # typecheck + unit + RLS
```

| Suite | What it proves |
|---|---|
| `tests/rls/isolation.test.ts` | User A cannot read, write, or delete user B's rows — against a real Postgres running the real migrations. Includes the privilege-escalation attempts (self-upgrading a plan, marking a job failed to dodge quota, reading OAuth ciphertext). |
| `tests/rls/quota.test.ts` | Monthly quota, per-batch caps, hourly rate limit — including twenty concurrent requests against a limit of ten. |
| `tests/unit/datetime.test.ts` | Deadlines survive both DST transitions, in both hemispheres. |
| `tests/unit/ics.test.ts` | Folding at 75 octets, TEXT escaping, stable UIDs, no duplicate events. |
| `tests/unit/no-secrets-in-client.test.ts` | No server secret in any client module or built chunk. |
| `tests/integration/pipeline.test.ts` | Four mixed-format files (a real PDF, a real .docx, a real PNG, pasted text) becoming one merged schedule, with only the model call stubbed. Covers cross-file dedupe, relative-date resolution, chunking, and partial failure. |
| `tests/accuracy/extraction.test.ts` | Extraction accuracy on twelve fixtures. **Costs money; opt in — see the caveat below.** |

```bash
RUN_ACCURACY_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... npm run test:accuracy
```

> **This suite has not been run.** It was written against twelve fixtures with
> per-case recall and precision floors, and its offline parts (parsing, routing,
> fixture integrity) pass — but no Anthropic API key was available in the
> environment this was built in, so the model has never actually been called and
> **extraction accuracy is unmeasured**. Run it and record the baseline before
> putting this in front of students; expect to tune the floors and the prompt on
> the first pass.

Two more checks drive a real browser and need the app running
(`npm run build && npm start`):

```bash
node scripts/check-responsive.mjs http://localhost:3000 / /login /privacy
node scripts/check-a11y.mjs       http://localhost:3000 / /login /privacy
```

They assert no horizontal scroll at 390 / 768 / 1280 px, and that every control
has an accessible name and every text colour clears WCAG AA.

## Why most deadlines are all-day

A syllabus line like `Problem Set 4 .......... October 15` names **a day**, not a
moment. The obvious implementation — default the time to 11:59 PM and export a
timed event — is actively wrong, and wrong in the worst possible way:

- 23:59 is one minute from midnight, so the event is *maximally* sensitive to
  timezone. `2026-10-15 23:59` in `America/New_York` is `2026-10-16 03:59Z`.
  A student whose phone is set to UTC, or who is on exchange in Europe, sees
  that deadline on **October 16**.
- The one thing this product must never get wrong is which day something is due.

So a deadline with no stated time is stored with `due_time = NULL` and exported
as an **all-day event**: a floating `DTSTART;VALUE=DATE:20261015` that carries no
offset for any client to shift. It reads "October 15" on every device, in every
timezone, whether or not the student travels.

The timezone machinery is still there and still exercised — it applies to the
minority of items whose syllabus *did* state a time:

| Source text | Stored | Exported as |
|---|---|---|
| `Problem Set 4 — October 15` | `due_time` NULL | All-day event on Oct 15 |
| `Prelim 1 — Sep 30, 7:30 PM` | `19:30` + term zone | Timed event, DST-correct |
| `due by 11:59pm` (Canvas says this) | `23:59` + term zone | Timed event — the source stated it |

A student can add a time to any row in the review table, which turns it into a
timed event; clearing it turns it back. Reminders differ accordingly: all-day
items fire at 10:00 the day before and 09:00 on the day (an all-day event starts
at local midnight, so a naive `-P1D` would alarm at midnight), timed items at one
day and two hours before.

## Cost control

Every extraction writes a row to `usage_events` with input, output, and cache
token counts plus a dollar estimate, so unit economics are visible from day one.

Levers, cheapest first:

1. **Prompt caching** is already on — the system prompt is byte-stable across
   chunks, so every chunk after the first bills cached input at ~10%. Watch
   `cache_read_tokens` in `usage_events`; if it is zero, something made the
   prompt vary.
2. **`ANTHROPIC_EFFORT`** — set to `medium` and measure against the fixture set
   before making it the default.
3. **`ANTHROPIC_MODEL`** — a smaller model is a real option, but change it only
   with the accuracy suite as the gate.

Hard caps that cost nothing to enforce: 10 files per batch, 20 MB per file, 60
PDF pages, 400k characters of pasted text (free tier). Encrypted PDFs and
unparseable files are rejected before any API call.

## Before you take real users

- [ ] Fill in the bracketed placeholders in `/privacy` and `/terms`, and have a
      lawyer review both.
- [ ] Complete Google OAuth verification — see `docs/GOOGLE_OAUTH.md`. The
      calendar scope is sensitive and review takes weeks.
- [ ] Run `RUN_ACCURACY_TESTS=1 npm run test:accuracy` and record the baseline.
- [ ] Import the exported `.ics` into Google, Apple, and Outlook by hand —
      see `docs/CALENDAR_TESTING.md`.
- [ ] Set `CRON_SECRET` and confirm the retention sweep runs.

## Not in v1, on purpose

No workload analysis, grade calculators, study-time estimation, collaboration,
LMS integrations, notifications, mobile apps, or chat about the syllabus. The
core loop first.
