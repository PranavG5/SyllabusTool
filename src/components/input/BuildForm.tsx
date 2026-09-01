'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileDrop, type PickedFile } from './FileDrop';
import { ErrorNotice } from '@/components/ErrorNotice';
import { postJson, type ClientErrorMessage } from '@/lib/client-fetch';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import type { JobState } from '@/lib/types';

/**
 * The single input screen: files, pasted text, and the two small term fields
 * relative dates need. One button.
 *
 * Extraction runs as a background job, so this posts, gets a job id back, and
 * polls. The student never waits on an open request that a serverless timeout
 * could kill under them.
 */

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

interface Limits {
  maxFilesPerBatch: number;
  maxFileBytes: number;
  maxInputChars: number;
}

/**
 * The student's own zone, read from their browser. Deadlines are stored against
 * this, so getting it wrong shifts every export by hours — assuming Eastern
 * would be wrong for most of the world and for most of the United States.
 */
function detectTimezone(fallback: string): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
  } catch {
    return fallback;
  }
}

function timezoneOptions(current: string): string[] {
  let all: string[] = [];
  try {
    const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (supported) all = supported('timeZone');
  } catch {
    all = [];
  }
  if (all.length === 0) {
    all = [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver',
      'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
      'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Dubai',
      'Australia/Sydney', 'Australia/Melbourne', 'Pacific/Auckland', 'UTC',
    ];
  }
  return all.includes(current) ? all : [current, ...all];
}

export function BuildForm({
  limits,
  quota,
  defaultTermName,
  defaultTimezone,
}: {
  limits: Limits;
  quota: { used: number; limit: number; remaining: number };
  defaultTermName: string;
  defaultTimezone: string;
}) {
  const router = useRouter();
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [text, setText] = useState('');
  const [termName, setTermName] = useState(defaultTermName);
  const [termStartDate, setTermStartDate] = useState('');
  const [termEndDate, setTermEndDate] = useState('');
  const [meetingDays, setMeetingDays] = useState('');
  const [courseHint, setCourseHint] = useState('');
  // Resolved on the client, because the server has no idea where the student is.
  const [timezone, setTimezone] = useState(defaultTimezone);
  useEffect(() => setTimezone((tz) => detectTimezone(tz)), []);

  const [phase, setPhase] = useState<'idle' | 'uploading' | 'working'>('idle');
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<ClientErrorMessage | null>(null);
  const [rejected, setRejected] = useState<{ filename: string; reason: string }[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number; name: string } | null>(null);

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ids = {
    text: useId(), term: useId(), start: useId(), end: useId(), days: useId(),
    course: useId(), zone: useId(),
  };

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const poll = useCallback(
    (jobId: string, deadline: number) => {
      pollRef.current = setTimeout(async () => {
        try {
          const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
          if (!response.ok) throw new Error('poll failed');
          const state = (await response.json()) as JobState;
          setJob(state);

          if (state.status === 'succeeded' || state.status === 'partial') {
            router.push(`/review?termId=${state.termId ?? ''}&jobId=${jobId}`);
            return;
          }
          if (state.status === 'failed') {
            setPhase('idle');
            setError({
              message: state.errorMessage ?? "We couldn't finish reading your syllabus.",
              nextAction: 'Try again, or paste the schedule section as text instead.',
            });
            return;
          }
          if (Date.now() > deadline) {
            setPhase('idle');
            setError({
              message: 'This is taking longer than it should.',
              nextAction: 'Your work is saved — reload this page in a minute to check on it.',
            });
            return;
          }
          poll(jobId, deadline);
        } catch {
          if (Date.now() > deadline) {
            setPhase('idle');
            setError({ message: 'We lost contact with the server.', nextAction: 'Reload the page to check on your schedule.' });
            return;
          }
          poll(jobId, deadline);
        }
      }, POLL_INTERVAL_MS);
    },
    [router],
  );

  const canSubmit = (files.length > 0 || text.trim().length > 0) && phase === 'idle' && quota.remaining > 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setError(null);
    setRejected([]);
    setPhase('uploading');

    try {
      /**
       * Files go straight from the browser into the private bucket using
       * one-time signed URLs. They never pass through our own API, because a
       * serverless function rejects any request body over 4.5 MB — far below
       * the limits this form advertises. Only the resulting ids are posted.
       */
      let batchId: string | null = null;
      let uploaded: {
        uploadId: string; filename: string; mimeType: string; sizeBytes: number; path: string;
      }[] = [];

      if (files.length > 0) {
        const prepared = await postJson('/api/uploads/prepare', {
          files: files.map((f) => ({
            filename: f.file.name,
            sizeBytes: f.file.size,
            mimeType: f.file.type || 'application/octet-stream',
          })),
        });
        if (!prepared.ok) {
          setPhase('idle');
          setError(prepared.error);
          return;
        }

        batchId = prepared.data.batchId as string;
        const targets = prepared.data.targets as {
          uploadId: string; filename: string; mimeType: string; sizeBytes: number;
          path: string; token: string;
        }[];

        const supabase = getSupabaseBrowserClient();
        for (let i = 0; i < targets.length; i += 1) {
          const target = targets[i]!;
          const picked = files[i]!;
          setUploadProgress({ done: i, total: targets.length, name: picked.file.name });

          const { error: uploadError } = await supabase.storage
            .from('syllabi')
            .uploadToSignedUrl(target.path, target.token, picked.file, {
              contentType: target.mimeType,
            });

          if (uploadError) {
            setPhase('idle');
            setUploadProgress(null);
            // Storage's own reason is the useful part — "mime type not
            // supported", "exceeded maximum size", "bucket not found" each
            // need a different response from the student.
            setError({
              message: `We couldn't upload "${picked.file.name}".`,
              nextAction: 'Check your connection and try again, or remove that file and paste its text instead.',
              detail: uploadError.message ? `Storage said: ${uploadError.message.slice(0, 160)}` : null,
              code: 'storage_upload_failed',
            });
            return;
          }
          uploaded.push({
            uploadId: target.uploadId,
            filename: target.filename,
            mimeType: target.mimeType,
            sizeBytes: target.sizeBytes,
            path: target.path,
          });
        }
        setUploadProgress(null);
      }

      const started = await postJson('/api/extract', {
        batchId,
        uploads: uploaded,
        text: text.trim() || null,
        courseHint: courseHint.trim() || null,
        termName: termName.trim() || 'My term',
        termStartDate: termStartDate || null,
        termEndDate: termEndDate || null,
        meetingDays: meetingDays.trim() || null,
        timezone,
      });

      if (!started.ok) {
        setPhase('idle');
        setError(started.error);
        return;
      }

      const body = started.data;
      setRejected((body.rejectedFiles ?? []) as { filename: string; reason: string }[]);
      setPhase('working');
      setJob({
        id: body.jobId as string, status: 'queued', totalFiles: body.totalFiles as number,
        processedFiles: 0, itemCount: 0, fileErrors: [], errorMessage: null,
        termId: (body.termId as string) ?? null,
      });
      poll(body.jobId as string, Date.now() + POLL_TIMEOUT_MS);
    } catch {
      setPhase('idle');
      setUploadProgress(null);
      setError({ message: 'We could not reach the server.', nextAction: 'Check your connection and try again.' });
    }
  }

  const busy = phase !== 'idle';

  return (
    <form onSubmit={submit} className="space-y-6">
      <section aria-labelledby="files-heading" className="card p-4 sm:p-5">
        <h2 id="files-heading" className="font-semibold text-[var(--color-ink)]">
          Your syllabus material
        </h2>
        <p className="hint mt-0.5 mb-3">Files, pasted text, or both. Several courses at once is fine.</p>

        <FileDrop
          files={files}
          onChange={setFiles}
          maxFiles={limits.maxFilesPerBatch}
          maxFileBytes={limits.maxFileBytes}
          disabled={busy}
        />

        <div className="mt-5">
          <label htmlFor={ids.text} className="label">
            Or paste text
          </label>
          <textarea
            id={ids.text}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            disabled={busy}
            spellCheck={false}
            placeholder={'Paste straight from Canvas — the navigation menu and column headers are fine, we ignore them.'}
            className="field font-mono text-[13px] leading-relaxed"
            aria-describedby={`${ids.text}-hint`}
          />
          <p id={`${ids.text}-hint`} className="hint mt-1">
            {text.length > 0
              ? `${text.length.toLocaleString()} of ${limits.maxInputChars.toLocaleString()} characters`
              : 'Copying the course schedule out of Canvas works as well as uploading a PDF.'}
          </p>
        </div>
      </section>

      <section aria-labelledby="term-heading" className="card p-4 sm:p-5">
        <h2 id="term-heading" className="font-semibold text-[var(--color-ink)]">
          About your term
        </h2>
        <p className="hint mt-0.5 mb-3">
          Syllabi often say &ldquo;Week 3, Thursday&rdquo; instead of a date. These two fields are how
          we turn that into a real one. Leave them blank and those items come back for you to fill in.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor={ids.term} className="label">Term name</label>
            <input id={ids.term} type="text" value={termName} onChange={(e) => setTermName(e.target.value)}
              disabled={busy} className="field" placeholder="Fall 2026" />
          </div>
          <div>
            <label htmlFor={ids.start} className="label">First day of classes</label>
            <input id={ids.start} type="date" value={termStartDate} onChange={(e) => setTermStartDate(e.target.value)}
              disabled={busy} className="field" />
          </div>
          <div>
            <label htmlFor={ids.end} className="label">Last day of classes <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span></label>
            <input id={ids.end} type="date" value={termEndDate} onChange={(e) => setTermEndDate(e.target.value)}
              disabled={busy} className="field" />
          </div>
          <div>
            <label htmlFor={ids.days} className="label">Days your classes meet</label>
            <input id={ids.days} type="text" value={meetingDays} onChange={(e) => setMeetingDays(e.target.value)}
              disabled={busy} className="field" placeholder="MWF, or Tue/Thu"
              aria-describedby={`${ids.days}-hint`} />
            <p id={`${ids.days}-hint`} className="hint mt-1">Used for &ldquo;the second class of week 5&rdquo;.</p>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor={ids.zone} className="label">Your timezone</label>
            <select
              id={ids.zone}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              disabled={busy}
              className="field"
              aria-describedby={`${ids.zone}-hint`}
            >
              {timezoneOptions(timezone).map((tz) => (
                <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
              ))}
            </select>
            <p id={`${ids.zone}-hint`} className="hint mt-1">
              Used for deadlines that name a specific time, like a 7:30 PM exam, so they stay
              correct after the clocks change. Deadlines that only name a day go in your calendar
              as all-day items and are not affected. We detected this from your browser.
            </p>
          </div>
          <div>
            <label htmlFor={ids.course} className="label">Course name <span className="font-normal text-[var(--color-ink-faint)]">(optional)</span></label>
            <input id={ids.course} type="text" value={courseHint} onChange={(e) => setCourseHint(e.target.value)}
              disabled={busy} className="field" placeholder="CS 2110"
              aria-describedby={`${ids.course}-hint`} />
            <p id={`${ids.course}-hint`} className="hint mt-1">Only if the material does not say.</p>
          </div>
        </div>
      </section>

      {error ? (
        <ErrorNotice
          message={error.message}
          nextAction={error.nextAction}
          detail={error.detail}
          reference={error.reference}
          code={error.code}
        />
      ) : null}

      {rejected.length > 0 ? (
        <div role="alert" className="card border-[var(--color-flag-line)] bg-[var(--color-flag-soft)] p-4">
          <p className="font-semibold text-[var(--color-flag)]">
            We skipped {rejected.length} file{rejected.length === 1 ? '' : 's'}, and carried on with the rest.
          </p>
          <ul className="mt-2 space-y-1 text-sm text-[var(--color-ink-soft)]">
            {rejected.map((r) => (
              <li key={r.filename}>
                <strong className="font-medium text-[var(--color-ink)]">{r.filename}</strong> — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={!canSubmit} className="btn btn-primary">
          {phase === 'uploading'
            ? uploadProgress
              ? `Uploading ${uploadProgress.done + 1}/${uploadProgress.total}…`
              : 'Uploading…'
            : phase === 'working'
              ? 'Reading…'
              : 'Build my schedule'}
        </button>

        <p role="status" aria-live="polite" className="hint">
          {uploadProgress
            ? `Uploading ${uploadProgress.name} (${uploadProgress.done + 1} of ${uploadProgress.total})…`
            : phase === 'working' && job
              ? `Reading ${job.totalFiles} source${job.totalFiles === 1 ? '' : 's'}. This usually takes under a minute.`
              : quota.remaining > 0
                ? `${quota.remaining} of ${quota.limit} builds left this month.`
                : "You've used all of this month's builds. Your existing schedule is still editable."}
        </p>
      </div>
    </form>
  );
}
