import 'server-only';

/**
 * The one place the Anthropic API is called.
 *
 * `server-only` at the top makes a client-component import a build error, so
 * ANTHROPIC_API_KEY cannot reach the browser bundle by accident.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ExtractionResultSchema, type RawItem } from './schema';
import { EXTRACTION_SYSTEM_PROMPT, buildUserPrompt, buildImageUserPrompt, type DocumentContext } from './prompt';
import { AppError } from '@/lib/errors';
import { logger, errorFields } from '@/lib/logger';
import { addUsage, ZERO_USAGE, type TokenUsage } from '@/lib/pricing';

export const DEFAULT_MODEL = 'claude-opus-5';
const MAX_OUTPUT_TOKENS = 16_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 800;

export function extractionModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

let cached: Anthropic | null = null;

function client(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AppError('internal', { context: { reason: 'ANTHROPIC_API_KEY is not configured' } });
  }
  cached = new Anthropic({
    apiKey,
    // The SDK retries connection errors and 429/5xx on its own; the loop below
    // adds retries for the failure it cannot see — a response that does not
    // satisfy the schema.
    maxRetries: 2,
    timeout: 120_000,
  });
  return cached;
}

export interface ExtractionCall {
  items: RawItem[];
  usage: TokenUsage;
  model: string;
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

function usageFrom(u: Anthropic.Messages.Usage | undefined): TokenUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) return typeof err.status === 'number' && err.status >= 500;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter, so concurrent jobs do not resynchronise. */
function backoffMs(attempt: number): number {
  return Math.round(Math.random() * BASE_BACKOFF_MS * 2 ** attempt);
}

/**
 * The system prompt is byte-stable across every call, so marking it cacheable
 * turns the second and later chunks of a batch into cache reads at ~10% of the
 * input rate. Per-document context deliberately lives in the user turn.
 */
function systemBlocks(): Anthropic.Messages.TextBlockParam[] {
  return [
    {
      type: 'text',
      text: EXTRACTION_SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

function outputConfig() {
  const effort = process.env.ANTHROPIC_EFFORT?.trim();
  const format = zodOutputFormat(ExtractionResultSchema);
  return effort ? { format, effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : { format };
}

async function runWithRetry(
  content: Anthropic.Messages.MessageParam['content'],
  label: string,
): Promise<ExtractionCall> {
  const model = extractionModel();
  let usage = ZERO_USAGE;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await client().messages.parse({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemBlocks(),
        thinking: { type: 'adaptive' },
        output_config: outputConfig(),
        messages: [{ role: 'user', content }],
      });

      usage = addUsage(usage, usageFrom(response.usage));

      if (response.stop_reason === 'refusal') {
        // A syllabus should never trip a safety classifier; if it does, that
        // file is not extractable and the batch should say so rather than retry.
        logger.warn('extract.refused', { label, model });
        throw new AppError('extraction_failed', {
          userMessage: 'We were not able to process that file.',
          nextAction: 'Try a different file, or paste the schedule text instead.',
        });
      }

      const parsed = response.parsed_output;
      if (!parsed) {
        lastError = new Error('model output did not match the extraction schema');
        logger.warn('extract.unparsed', { label, model, attempt, stopReason: response.stop_reason });
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new AppError('extraction_failed', { context: { label, reason: 'unparsed_output' } });
      }

      return { items: parsed.items, usage, model };
    } catch (err) {
      if (err instanceof AppError) throw err;
      lastError = err;
      if (isRetryable(err) && attempt < MAX_ATTEMPTS - 1) {
        const delay = backoffMs(attempt);
        logger.warn('extract.retrying', { label, attempt, delay, ...errorFields(err) });
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  logger.error('extract.failed', { label, model, ...errorFields(lastError) });
  if (lastError instanceof Anthropic.RateLimitError || lastError instanceof Anthropic.InternalServerError) {
    throw new AppError('model_unavailable', { cause: lastError });
  }
  if (lastError instanceof Anthropic.AuthenticationError) {
    throw new AppError('internal', { cause: lastError, context: { reason: 'anthropic auth rejected' } });
  }
  throw new AppError('extraction_failed', { cause: lastError, context: { label } });
}

/** Extracts from one text excerpt. */
export function extractFromText(ctx: DocumentContext, text: string): Promise<ExtractionCall> {
  return runWithRetry(
    [{ type: 'text', text: buildUserPrompt(ctx, text) }],
    `${ctx.filename}#${ctx.chunkIndex}`,
  );
}

/**
 * Extracts from a scanned PDF by handing the file itself to the model.
 * The Messages API reads PDF document blocks with vision, so a scan needs no
 * rasterisation step on our side.
 */
export function extractFromPdfDocument(ctx: DocumentContext, base64: string): Promise<ExtractionCall> {
  return runWithRetry(
    [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: buildImageUserPrompt(ctx) },
    ],
    `${ctx.filename}#pdf-scan`,
  );
}

/** Extracts from an image — screenshots and photographed schedules. */
export function extractFromImage(
  ctx: DocumentContext,
  base64: string,
  mediaType: ImageMediaType,
): Promise<ExtractionCall> {
  return runWithRetry(
    [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: buildImageUserPrompt(ctx) },
    ],
    `${ctx.filename}#image`,
  );
}
