'use client';

/**
 * POSTs JSON and always comes back with something the UI can show.
 *
 * The naive version — `const body = await response.json()` before checking
 * `response.ok` — turns every non-JSON failure into a thrown SyntaxError, which
 * the caller's catch reports as "we could not reach the server". That is a lie
 * when the platform returned a perfectly clear error: Vercel answers an
 * oversized request body with the plain text `Request Entity Too Large`, and a
 * timed-out function with an HTML error page. The student was told to check
 * their connection while the actual problem was their 6 MB PDF.
 */

export interface ClientErrorMessage {
  message: string;
  nextAction?: string;
  /** Safe, specific cause written by the server. */
  detail?: string | null;
  /** Matches the server log line and the X-Error-Reference header. */
  reference?: string | null;
  code?: string | null;
}

export type JsonResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: ClientErrorMessage };

/** Platform-level failures that never carry our JSON error envelope. */
function platformError(status: number, raw: string): ClientErrorMessage {
  if (status === 413 || /too large|payload/i.test(raw)) {
    return {
      message: 'That was too much data to send in one request.',
      nextAction: 'Upload fewer files at a time, or paste the schedule as text.',
    };
  }
  if (status === 504 || status === 408) {
    return {
      message: 'That took too long and timed out.',
      nextAction: 'Try again with fewer files.',
    };
  }
  if (status === 401 || status === 403) {
    return { message: 'Your session has expired.', nextAction: 'Sign in again and retry.' };
  }
  if (status >= 500) {
    return {
      message: 'Something went wrong on our side.',
      nextAction: 'Try again in a moment. Nothing you entered was lost.',
    };
  }
  return {
    message: 'That request was rejected.',
    nextAction: 'Check the form and try again.',
  };
}

export async function postJson(url: string, payload: unknown): Promise<JsonResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  // Present even when the body is not ours to parse.
  const headerReference = response.headers.get('X-Error-Reference');
  const headerCode = response.headers.get('X-Error-Code');
  const raw = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    // Our own routes always answer with { error: { message, nextAction } }.
    const envelope = parsed?.error as ClientErrorMessage | undefined;
    if (envelope?.message) {
      return {
        ok: false,
        error: {
          message: envelope.message,
          nextAction: envelope.nextAction,
          detail: envelope.detail ?? null,
          reference: envelope.reference ?? headerReference,
          code: envelope.code ?? headerCode,
        },
      };
    }
    return {
      ok: false,
      error: {
        ...platformError(response.status, raw),
        reference: headerReference,
        code: headerCode ?? `http_${response.status}`,
      },
    };
  }

  if (!parsed) {
    return {
      ok: false,
      error: {
        message: 'We got an unexpected reply from the server.',
        nextAction: 'Try again in a moment.',
      },
    };
  }

  return { ok: true, data: parsed };
}
