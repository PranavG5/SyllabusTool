import * as Sentry from '@sentry/nextjs';

/**
 * Server-side error tracking. A missing DSN makes every Sentry call a no-op,
 * so local development and self-hosted deployments need no account.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
  // Syllabus text is the user's own coursework and can name real people.
  // None of it belongs in an error tracker.
  sendDefaultPii: false,
  beforeSend(event) {
    if (event.request?.data) delete event.request.data;
    if (event.request?.cookies) delete event.request.cookies;
    if (event.request?.headers) {
      delete event.request.headers.cookie;
      delete event.request.headers.authorization;
      delete event.request.headers['x-job-worker-secret'];
    }
    // Feed URLs carry a bearer token in the path.
    if (event.request?.url) {
      event.request.url = event.request.url.replace(/\/api\/feed\/[0-9a-f]{8,}/, '/api/feed/[token]');
    }
    return event;
  },
});
