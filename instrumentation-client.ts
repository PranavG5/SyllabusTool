import * as Sentry from '@sentry/nextjs';

/**
 * Browser error tracking. Only NEXT_PUBLIC_SENTRY_DSN is readable here, which
 * is by design — a DSN is a write-only ingest key, not a secret.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  beforeSend(event) {
    // A pasted syllabus can end up in a form value; never ship it.
    if (event.request?.data) delete event.request.data;
    return event;
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
