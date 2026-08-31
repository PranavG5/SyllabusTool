'use client';

import { useCallback, useId, useRef, useState } from 'react';

/**
 * Drag-and-drop that is also a real file input.
 *
 * The visible drop zone is a <button> wrapping a hidden <input type="file">,
 * so it is reachable and operable from the keyboard — a div with onDrop is
 * not. Drag-and-drop is the enhancement; the input is the control.
 */

export interface PickedFile {
  id: string;
  file: File;
}

const ACCEPT = '.pdf,.docx,.doc,.txt,.md,.png,.jpg,.jpeg,.webp';

export function FileDrop({
  files,
  onChange,
  maxFiles,
  maxFileBytes,
  disabled,
}: {
  files: PickedFile[];
  onChange: (files: PickedFile[]) => void;
  maxFiles: number;
  maxFileBytes: number;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const helpId = useId();

  const add = useCallback(
    (incoming: FileList | null) => {
      if (!incoming) return;
      const next = [...files];
      const problems: string[] = [];

      for (const file of Array.from(incoming)) {
        if (next.length >= maxFiles) {
          problems.push(`We take up to ${maxFiles} files at a time, so "${file.name}" was left out.`);
          continue;
        }
        if (file.size > maxFileBytes) {
          problems.push(
            `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${Math.round(maxFileBytes / 1024 / 1024)} MB.`,
          );
          continue;
        }
        if (next.some((f) => f.file.name === file.name && f.file.size === file.size)) continue;
        next.push({ id: `${file.name}-${file.size}-${file.lastModified}`, file });
      }

      setNotice(problems.length > 0 ? problems.join(' ') : null);
      onChange(next);
    },
    [files, maxFiles, maxFileBytes, onChange],
  );

  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
        aria-describedby={helpId}
        className={`flex w-full flex-col items-center justify-center gap-1 rounded-[var(--radius-card)] border-2 border-dashed px-4 py-7 text-center transition-colors ${
          dragging
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
            : 'border-[var(--color-line)] bg-[var(--color-paper)] hover:border-[var(--color-ink-faint)]'
        } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
      >
        <span className="font-semibold text-[var(--color-ink)]">
          {dragging ? 'Drop them here' : 'Choose files or drop them here'}
        </span>
        <span className="hint">PDF, Word, text, or a screenshot</span>
      </button>

      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => {
          add(e.target.files);
          // Reset so re-picking the same file still fires a change event.
          e.target.value = '';
        }}
      />
      <p id={helpId} className="hint mt-1.5">
        Up to {maxFiles} files, {Math.round(maxFileBytes / 1024 / 1024)} MB each. Several courses at
        once is fine.
      </p>

      {notice ? (
        <p role="alert" className="mt-2 text-sm text-[var(--color-flag)]">
          {notice}
        </p>
      ) : null}

      {files.length > 0 ? (
        <ul className="mt-3 space-y-1.5" aria-label="Files to process">
          {files.map((picked) => (
            <li
              key={picked.id}
              className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-ink)]">
                {picked.file.name}
              </span>
              <span className="hint shrink-0">{(picked.file.size / 1024).toFixed(0)} KB</span>
              <button
                type="button"
                className="btn btn-ghost shrink-0"
                onClick={() => onChange(files.filter((f) => f.id !== picked.id))}
              >
                Remove
                <span className="sr-only"> {picked.file.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
