# Verifying the .ics in real calendar apps

`tests/unit/ics.test.ts` proves the file is well-formed: folding at 75 octets,
correct escaping, stable UIDs, DST-correct instants. What it cannot prove is how
three real clients behave. Do this by hand before launch, and again whenever
`src/lib/ics/build.ts` changes.

Export a schedule that deliberately includes:

- an item at **11:59 PM** (the default) — the DST-sensitive case,
- an item with an **explicit time** such as a 7:30 PM exam,
- an item on **each side of a DST transition** (early October and early December
  for a northern-hemisphere autumn term),
- an item with **no time at all** (clear the time in the review table) — exports
  as all-day,
- an item with a **location**,
- an item whose title contains a **comma, semicolon and accented characters** —
  exercises TEXT escaping,
- **two courses**, to confirm both appear.

## Google Calendar

1. Settings → Import & export → Import, pick the `.ics`, choose a calendar.
2. Check every time renders as expected, in your own timezone.
3. **Import the same file again.** Google matches on `UID`: you should end with
   the same number of events, not double. This is the single most important
   check.
4. Edit an item in the app, re-export, re-import. The event should *update* —
   `SEQUENCE` is what makes that happen.

## Apple Calendar (macOS and iOS)

1. macOS: File → Import. iOS: open the file from Mail or Files.
2. Confirm the alarms came through (1 day and 2 hours before).
3. Confirm all-day items sit on the right day and do not bleed into the next —
   the classic off-by-one when a client mishandles the exclusive `DTEND`.

## Outlook

Test **both**, they behave differently:

- **outlook.com**: Add calendar → Upload from file.
- **Outlook desktop**: File → Open & Export → Import/Export → iCalendar.

Outlook is the strictest about line folding and CRLF endings; a file the other
two accept can still be rejected here. Also check that the description text
survives — that is where the source snippet lives.

## The subscribable feed

The feed is the path most users keep. Test it separately:

- **Google**: Other calendars → From URL, paste the `https://…/api/feed/<token>.ics`
  address. Google refreshes on its own schedule — up to 24 hours, sometimes
  longer. Do not expect an immediate update.
- **Apple**: File → New Calendar Subscription, paste the address, set
  auto-refresh. Apple honours the `REFRESH-INTERVAL` we publish (1 hour).
- **Outlook**: Add calendar → Subscribe from web.

Then edit an item in the app and confirm the change lands after a refresh. Also
confirm the `webcal://` link opens the right dialog on macOS and iOS.

## What to record

Keep a short table of client, version, date tested, and result. When a user
reports "the times are wrong in Outlook", the first question is which of these
last passed.
