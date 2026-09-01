/**
 * Every failure the user can reach has a code, a plain-language message, and a
 * next action. Raw exceptions never cross the API boundary: `toClientError`
 * is the only thing routes serialise, and it emits nothing but these fields.
 */

export type ErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'invalid_input'
  | 'no_input'
  | 'too_many_files'
  | 'file_too_large'
  | 'input_too_long'
  | 'unsupported_file_type'
  | 'encrypted_pdf'
  | 'unparseable_file'
  | 'pdf_too_many_pages'
  | 'empty_document'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'storage_not_configured'
  | 'storage_upload_failed'
  | 'storage_object_missing'
  | 'model_not_configured'
  | 'database_unavailable'
  | 'model_unavailable'
  | 'extraction_failed'
  | 'storage_failed'
  | 'calendar_not_connected'
  | 'google_auth_failed'
  | 'internal';

interface ErrorShape {
  status: number;
  message: string;
  nextAction: string;
}

const CATALOG: Record<ErrorCode, ErrorShape> = {
  unauthorized: {
    status: 401,
    message: 'You need to be signed in to do that.',
    nextAction: 'Sign in and try again.',
  },
  not_found: {
    status: 404,
    message: "We couldn't find that.",
    nextAction: 'Go back to your schedule and try again.',
  },
  invalid_input: {
    status: 400,
    message: "Something in that request didn't look right.",
    nextAction: 'Check the highlighted fields and try again.',
  },
  no_input: {
    status: 400,
    message: 'There was nothing to read — no files and no pasted text.',
    nextAction: 'Add at least one file or paste your syllabus text.',
  },
  too_many_files: {
    status: 400,
    message: 'That is more files than one batch allows.',
    nextAction: 'Remove a few files and build the schedule in two passes.',
  },
  file_too_large: {
    status: 400,
    message: 'One of those files is over the size limit.',
    nextAction: 'Try exporting a smaller PDF, or paste the schedule as text.',
  },
  input_too_long: {
    status: 400,
    message: 'That is more text than we can process in one go.',
    nextAction: 'Split it into two batches — one course at a time works well.',
  },
  unsupported_file_type: {
    status: 400,
    message: 'We can read PDF, Word, plain text, and image files.',
    nextAction: 'Convert the file, or copy the schedule and paste it as text.',
  },
  encrypted_pdf: {
    status: 400,
    message: 'That PDF is password-protected, so we cannot open it.',
    nextAction: 'Re-save it without a password, or paste the schedule as text.',
  },
  unparseable_file: {
    status: 400,
    message: "We couldn't read any text out of that file.",
    nextAction: 'If it is a scan, upload it as an image instead — we read those.',
  },
  pdf_too_many_pages: {
    status: 400,
    message: 'That PDF has more pages than we process in one batch.',
    nextAction: 'Upload just the pages with the course schedule on them.',
  },
  empty_document: {
    status: 400,
    message: 'That file opened, but there was no text inside it.',
    nextAction: 'Check you uploaded the right file, or paste the text instead.',
  },
  quota_exceeded: {
    status: 429,
    message: "You've used all of this month's schedule builds.",
    nextAction: 'Your quota resets on the 1st. Existing schedules stay editable.',
  },
  rate_limited: {
    status: 429,
    message: "You've started a lot of builds in a short time.",
    nextAction: 'Wait a few minutes and try again.',
  },
  model_unavailable: {
    status: 503,
    message: 'Our extraction service is briefly unavailable.',
    nextAction: 'Wait a minute and press Build again — nothing was lost.',
  },
  extraction_failed: {
    status: 502,
    message: "We couldn't finish reading your syllabus.",
    nextAction: 'Try again, or paste the schedule section as text instead.',
  },
  storage_failed: {
    status: 502,
    message: 'We could not save your upload.',
    nextAction: 'Try again in a moment.',
  },
  storage_not_configured: {
    status: 503,
    message: 'File uploads are not switched on for this deployment yet.',
    nextAction: 'Paste your syllabus text instead — that path works. (Admin: the private storage bucket is missing.)',
  },
  storage_upload_failed: {
    status: 502,
    message: "Your file didn't finish uploading.",
    nextAction: 'Check your connection and try again, or remove that file and paste its text.',
  },
  storage_object_missing: {
    status: 404,
    message: "We could not find that file where it was uploaded.",
    nextAction: 'Upload it again.',
  },
  model_not_configured: {
    status: 503,
    message: 'Extraction is not switched on for this deployment yet.',
    nextAction: 'Nothing you entered was lost. (Admin: ANTHROPIC_API_KEY is not set.)',
  },
  database_unavailable: {
    status: 503,
    message: 'We could not reach our database.',
    nextAction: 'Try again in a moment — this is usually brief.',
  },
  calendar_not_connected: {
    status: 400,
    message: 'No Google Calendar is connected to this account yet.',
    nextAction: 'Connect Google Calendar from the schedule page first.',
  },
  google_auth_failed: {
    status: 502,
    message: 'Google would not accept that calendar connection.',
    nextAction: 'Disconnect and reconnect Google Calendar, then try again.',
  },
  internal: {
    status: 500,
    message: 'Something went wrong on our side.',
    nextAction: "Try again. If it keeps happening, the problem is ours — email support.",
  },
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Shown verbatim to the user. Never contains internals. */
  readonly userMessage: string;
  readonly nextAction: string;
  /**
   * A short, deliberately safe phrase naming the specific cause, shown to the
   * user beneath the message. This is what makes a failure diagnosable without
   * reading server logs — "the storage bucket is missing" tells you far more
   * than "we could not save your upload" — so it must never carry a stack
   * trace, a connection string, a key, or anything from an upstream error
   * body. Put those in `context`, which stays server-side.
   */
  readonly detail: string | null;
  /** Extra context for logs only — never serialised to the client. */
  readonly context: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    options: {
      /** Overrides the catalog message when a specific one reads better. */
      userMessage?: string;
      nextAction?: string;
      detail?: string;
      cause?: unknown;
      context?: Record<string, unknown>;
    } = {},
  ) {
    const shape = CATALOG[code];
    super(options.userMessage ?? shape.message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = shape.status;
    this.userMessage = options.userMessage ?? shape.message;
    this.nextAction = options.nextAction ?? shape.nextAction;
    this.detail = options.detail ?? null;
    this.context = options.context ?? {};
  }
}

export interface ClientError {
  error: {
    code: ErrorCode;
    message: string;
    nextAction: string;
    /** Safe, specific cause. Null when there is nothing more to say. */
    detail: string | null;
    /** Correlates this response with the server log line for the same failure. */
    reference: string;
  };
}

/**
 * Converts anything thrown into a safe client payload. Unknown throwables
 * collapse to `internal` — a stack trace or driver message never escapes.
 *
 * `reference` is echoed into the log line for the same request, so a screenshot
 * of the error is enough to find the exact failure in the logs.
 */
export function toClientError(err: unknown, reference = newReference()): {
  status: number;
  body: ClientError;
} {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.userMessage,
          nextAction: err.nextAction,
          detail: err.detail,
          reference,
        },
      },
    };
  }
  const shape = CATALOG.internal;
  return {
    status: shape.status,
    body: {
      error: {
        code: 'internal',
        message: shape.message,
        nextAction: shape.nextAction,
        detail: null,
        reference,
      },
    },
  };
}

/** Short, human-readable, unambiguous when read aloud off a screenshot. */
export function newReference(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function errorMessage(code: ErrorCode): string {
  return CATALOG[code].message;
}
