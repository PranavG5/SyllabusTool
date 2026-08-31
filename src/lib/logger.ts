/**
 * Structured server logs. One JSON object per line so they are queryable in
 * Vercel's log drain without a parser.
 *
 * Anything that could carry syllabus content or a secret is redacted before
 * it is written; see REDACT_KEYS.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const REDACT_KEYS = new Set([
  'apiKey', 'api_key', 'authorization', 'cookie', 'password', 'token',
  'access_token', 'refresh_token', 'accessToken', 'refreshToken',
  'feed_token', 'feedToken', 'text', 'extractedText', 'source_snippet',
  'sourceSnippet', 'email', 'client_secret', 'clientSecret',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

function write(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...(redact(fields) as Record<string, unknown>),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => {
    if (process.env.NODE_ENV !== 'production') write('debug', event, fields);
  },
  info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
};

/** Normalises a throwable into log-safe fields. Stack stays server-side. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      errName: err.name,
      errMessage: err.message,
      ...(process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
    };
  }
  return { errName: 'unknown', errMessage: String(err) };
}
