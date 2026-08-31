import 'server-only';

/**
 * The extraction pipeline: files and pasted text in, deduplicated items out.
 *
 * Partial failure is a first-class outcome. One unreadable file in a batch of
 * four must not lose the other three, so every source is processed
 * independently and its failure is recorded against the filename rather than
 * thrown. The caller reports `fileErrors` to the student alongside the items
 * that did come through.
 */

import { AppError } from '@/lib/errors';
import { logger, errorFields } from '@/lib/logger';
import { addUsage, ZERO_USAGE, type TokenUsage } from '@/lib/pricing';
import { parseISODate, type CivilDate } from '@/lib/datetime';
import { chunkText } from './chunk';
import {
  extractFromImage, extractFromPdfDocument, extractFromText, extractionModel,
} from './client';
import type { DocumentContext } from './prompt';
import { normalizeItems, type NormalizeContext, type NormalizedItem } from './normalize';
import { dedupeItems } from './dedupe';
import type { ParsedFile } from '@/lib/parse';
import type { JobFileError } from '@/lib/types';

export interface PipelineSource {
  /** Stable id so items can be traced back to the upload row they came from. */
  uploadId: string | null;
  parsed: ParsedFile;
}

export interface PipelineInput {
  sources: PipelineSource[];
  /** Pasted text is a first-class source, not a fallback. */
  pastedText: string | null;
  termName: string | null;
  termStartDate: string | null;
  termEndDate: string | null;
  courseHint: string | null;
  meetingDaysByCourse: Record<string, number[]>;
  defaultMeetingDays: number[];
}

export interface PipelineItem extends NormalizedItem {
  sourceUploadId: string | null;
  sourceFilename: string | null;
}

export interface PipelineResult {
  items: PipelineItem[];
  fileErrors: JobFileError[];
  usage: TokenUsage;
  model: string;
  chunkCount: number;
  /** True when at least one source produced items. */
  anySucceeded: boolean;
}

const PASTED_TEXT_LABEL = 'Pasted text';

function toCivil(value: string | null): CivilDate | null {
  return value ? parseISODate(value) : null;
}

/** One source (a file, or the pasted text) processed end to end. */
async function runSource(
  source: PipelineSource,
  input: PipelineInput,
): Promise<{ items: NormalizedItem[]; usage: TokenUsage; chunks: number }> {
  const { parsed } = source;
  const normalizeCtx: NormalizeContext = {
    termStart: toCivil(input.termStartDate),
    termEnd: toCivil(input.termEndDate),
    meetingDaysByCourse: input.meetingDaysByCourse,
    defaultMeetingDays: input.defaultMeetingDays,
  };

  const baseCtx = (chunkIndex: number, chunkCount: number): DocumentContext => ({
    filename: parsed.filename,
    termName: input.termName,
    termStartDate: input.termStartDate,
    termEndDate: input.termEndDate,
    courseHint: input.courseHint,
    chunkIndex,
    chunkCount,
  });

  // Vision paths are single-call: an image or a scan is one document.
  if (parsed.kind === 'image') {
    if (!parsed.base64 || !parsed.mediaType) {
      throw new AppError('unparseable_file', {
        userMessage: `We couldn't read "${parsed.filename}" as an image.`,
      });
    }
    const call = await extractFromImage(baseCtx(0, 1), parsed.base64, parsed.mediaType);
    return { items: normalizeItems(call.items, normalizeCtx), usage: call.usage, chunks: 1 };
  }

  if (parsed.kind === 'pdf-scan') {
    if (!parsed.base64) {
      throw new AppError('unparseable_file', {
        userMessage: `We couldn't read "${parsed.filename}".`,
      });
    }
    const call = await extractFromPdfDocument(baseCtx(0, 1), parsed.base64);
    return { items: normalizeItems(call.items, normalizeCtx), usage: call.usage, chunks: 1 };
  }

  const chunks = chunkText(parsed.text);
  if (chunks.length === 0) {
    throw new AppError('empty_document', {
      userMessage: `"${parsed.filename}" had no readable text.`,
    });
  }

  let usage = ZERO_USAGE;
  const items: NormalizedItem[] = [];

  // Sequential: chunks of one document share a prompt-cache prefix, and
  // firing them in parallel would race the cache write and multiply rate-limit
  // pressure for no latency win that matters at this size.
  for (const chunk of chunks) {
    const call = await extractFromText(baseCtx(chunk.index, chunks.length), chunk.text);
    usage = addUsage(usage, call.usage);
    items.push(...normalizeItems(call.items, normalizeCtx));
  }

  return { items, usage, chunks: chunks.length };
}

export async function runExtraction(input: PipelineInput): Promise<PipelineResult> {
  const sources: PipelineSource[] = [...input.sources];

  if (input.pastedText && input.pastedText.trim().length > 0) {
    sources.push({
      uploadId: null,
      parsed: {
        kind: 'text',
        filename: PASTED_TEXT_LABEL,
        text: input.pastedText.trim(),
        base64: null,
        mediaType: null,
        pageCount: null,
      },
    });
  }

  if (sources.length === 0) throw new AppError('no_input');

  const collected: PipelineItem[] = [];
  const fileErrors: JobFileError[] = [];
  let usage = ZERO_USAGE;
  let chunkCount = 0;
  let anySucceeded = false;

  for (const source of sources) {
    const started = Date.now();
    try {
      const result = await runSource(source, input);
      usage = addUsage(usage, result.usage);
      chunkCount += result.chunks;
      anySucceeded = true;
      for (const item of result.items) {
        collected.push({
          ...item,
          sourceUploadId: source.uploadId,
          sourceFilename: source.parsed.filename,
        });
      }
      logger.info('pipeline.source_done', {
        filename: source.parsed.filename,
        kind: source.parsed.kind,
        items: result.items.length,
        chunks: result.chunks,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      // One bad file must not sink the batch.
      const reason =
        err instanceof AppError
          ? err.userMessage
          : 'Something went wrong while reading this file.';
      fileErrors.push({ filename: source.parsed.filename, reason });
      logger.warn('pipeline.source_failed', {
        filename: source.parsed.filename,
        kind: source.parsed.kind,
        ...errorFields(err),
      });
    }
  }

  // Dedupe across every source at once: the same midterm in the syllabus and
  // in the course calendar is one item.
  const deduped = dedupeItems(collected) as PipelineItem[];

  logger.info('pipeline.done', {
    sources: sources.length,
    failed: fileErrors.length,
    rawItems: collected.length,
    items: deduped.length,
    chunkCount,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
  });

  if (!anySucceeded) {
    throw new AppError('extraction_failed', {
      userMessage:
        fileErrors.length === 1
          ? fileErrors[0]!.reason
          : "We couldn't read any of those files.",
      nextAction: 'Check the file formats, or paste the schedule text instead.',
      context: { fileErrors },
    });
  }

  return {
    items: deduped,
    fileErrors,
    usage,
    model: extractionModel(),
    chunkCount,
    anySucceeded,
  };
}
