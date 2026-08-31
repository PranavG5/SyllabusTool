# Google Calendar OAuth

## The scope, and why it is the one we ask for

```
https://www.googleapis.com/auth/calendar.app.created
```

This grants access **only to calendars this application itself created**. It
cannot read, modify, or delete the user's existing calendars, and it cannot see
their other events. That is a structural guarantee, not a policy we promise to
follow: even a bug that tried to write to the primary calendar would be refused
by Google.

The obvious alternatives are worse for the user:

| Scope | Grants | Why not |
|---|---|---|
| `calendar` | Full read/write on every calendar | Enormously more than we need |
| `calendar.events` | Read/write events on every calendar | Still reads their whole life |
| `calendar.app.created` | Only calendars we created | **What we use** |

`calendar.app.created` is still classified **sensitive** by Google, so a
production app needs verification.

## Setting it up

1. Google Cloud Console → new project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **OAuth consent screen**:
   - User type: External.
   - App name, support email, developer contact.
   - App domain, plus links to your `/privacy` and `/terms` pages. Both must be
     live and reachable before you submit.
   - Scopes: add `.../auth/calendar.app.created` and nothing else. Every extra
     scope adds weeks to review.
4. **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorised redirect URI: `https://YOUR_DOMAIN/api/google/callback`
   - Add `http://localhost:3000/api/google/callback` for development.
5. Put the client ID and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

While unverified the app works for up to 100 test users, added under **Audience
→ Test users**. That is enough to build and demo with.

## Verification — budget the time

Sensitive scopes require review before you can go past 100 users. Google asks
for:

- A **privacy policy** at a URL on your verified domain that specifically
  describes your use of Google user data, including the Limited Use statement.
  Ours is at `/privacy` and already carries it.
- A **demo video** showing: the consent screen with the scope visible, what the
  user does next, and what the app does with the data. Record the real flow.
- A **justification** for the scope. Ours: *"We create one calendar named after
  the student's academic term and write their coursework deadlines into it. We
  request `calendar.app.created` specifically so that we cannot access any of
  their other calendars."*
- **Domain verification** in Google Search Console.

**Expect several weeks and at least one round of questions.** Start this the day
you decide to ship, not the week before.

## How the flow works here

| Step | File |
|---|---|
| Start, with CSRF state in an httpOnly cookie | `src/app/api/google/start/route.ts` |
| Callback: verify state, exchange code, encrypt and store the refresh token | `src/app/api/google/callback/route.ts` |
| Create the dedicated calendar, write events | `src/lib/google/calendar.ts` |
| Disconnect: revoke at Google, then delete our copy | `src/app/api/google/disconnect/route.ts` |

Notes on the details that bite:

- `access_type=offline` **and** `prompt=consent` are both required to get a
  refresh token. Without `prompt=consent`, a user who has authorised before gets
  none, and the connection silently dies at the first token expiry. The callback
  treats a missing refresh token as a failed connection rather than storing a
  time bomb.
- Refresh tokens are AES-256-GCM encrypted (`src/lib/crypto.ts`) before storage,
  and `SELECT` on the ciphertext columns is revoked from the `anon` and
  `authenticated` roles, so a compromised anon key yields neither plaintext nor
  ciphertext.
- Event ids are derived from the item's row id, the same identity the ICS `UID`
  uses, so syncing twice updates events rather than duplicating them.
- Deleting an account revokes the token with Google before erasing local rows —
  that ordering matters, because revocation needs the plaintext.
