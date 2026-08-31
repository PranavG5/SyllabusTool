import 'server-only';

/**
 * Turning an uploaded file into something the extractor can read.
 *
 * Order of preference, per file:
 *   1. A real text parser (pdf-parse, mammoth, UTF-8 decode).
 *   2. Vision — only for images, and for PDFs that turn out to be scans.
 *
 * Every rejection here saves an API call, which is the point: an encrypted
 * PDF or a 400-page course pack should cost nothing to refuse.
 */

import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { AppError } from '@/lib/errors';
import { logger, errorFields } from '@/lib/logger';
import {
  ABSOLUTE_MAX_PDF_PAGES, MAX_DOCUMENT_CHARS, MAX_IMAGE_BYTES,
  MAX_SCANNED_PDF_PAGES, SCANNED_PDF_CHARS_PER_PAGE,
  SUPPORTED_EXTENSIONS, SUPPORTED_MIME_TYPES, extensionOf,
} from './limits';
import type { ImageMediaType } from '@/lib/extract/client';

export type ParsedKind = 'text' | 'image' | 'pdf-scan';

export interface ParsedFile {
  kind: ParsedKind;
  filename: string;
  /** Present when kind === 'text'. */
  text: string;
  /** Present when kind is 'image' or 'pdf-scan'. */
  base64: string | null;
  mediaType: ImageMediaType | null;
  pageCount: number | null;
}

export interface ParseInput {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Per-plan page ceiling; capped again by ABSOLUTE_MAX_PDF_PAGES. */
  maxPdfPages: number;
}

const IMAGE_MEDIA_TYPES: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Collapses the ragged whitespace PDF text extraction produces. */
export function tidyText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    // Three or more blank lines carry no information and cost tokens.
    .replace(/\n{3,}/g, '\n\n')
    // Long runs of spaces are column padding; keep two as a column hint.
    .replace(/[ \t]{3,}/g, '  ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function assertSupported(filename: string, mimeType: string): void {
  const ext = extensionOf(filename);
  if (!SUPPORTED_MIME_TYPES.has(mimeType) && !SUPPORTED_EXTENSIONS.has(ext)) {
    throw new AppError('unsupported_file_type', {
      userMessage: `We can't read "${filename}" — we handle PDF, Word, text, and image files.`,
    });
  }
}

function isPdf(filename: string, mimeType: string): boolean {
  return mimeType === 'application/pdf' || extensionOf(filename) === 'pdf';
}

function isDocx(filename: string, mimeType: string): boolean {
  return (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword' ||
    ['docx', 'doc'].includes(extensionOf(filename))
  );
}

function imageMediaType(filename: string, mimeType: string): ImageMediaType | null {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp') {
    return mimeType;
  }
  return IMAGE_MEDIA_TYPES[extensionOf(filename)] ?? null;
}

async function parsePdf(input: ParseInput): Promise<ParsedFile> {
  const pageCeiling = Math.min(input.maxPdfPages, ABSOLUTE_MAX_PDF_PAGES);
  let result: Awaited<ReturnType<typeof pdfParse>>;

  try {
    result = await pdfParse(Buffer.from(input.bytes));
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const message = err instanceof Error ? err.message.toLowerCase() : '';
    if (name === 'PasswordException' || message.includes('password')) {
      throw new AppError('encrypted_pdf', {
        userMessage: `"${input.filename}" is password-protected, so we can't open it.`,
      });
    }
    logger.warn('parse.pdf_failed', { filename: input.filename, ...errorFields(err) });
    throw new AppError('unparseable_file', {
      userMessage: `We couldn't read "${input.filename}" as a PDF.`,
      cause: err,
    });
  }

  const pageCount = result.numpages ?? 0;
  if (pageCount > pageCeiling) {
    throw new AppError('pdf_too_many_pages', {
      userMessage: `"${input.filename}" has ${pageCount} pages; we read up to ${pageCeiling} in one batch.`,
      nextAction: 'Upload just the pages with the course schedule on them.',
    });
  }

  const text = tidyText(result.text ?? '');

  // A PDF with pages but almost no extractable text is a scan. Hand the file
  // itself to the vision path rather than extracting from nothing.
  const isScan = pageCount > 0 && text.length < pageCount * SCANNED_PDF_CHARS_PER_PAGE;
  if (isScan) {
    if (pageCount > MAX_SCANNED_PDF_PAGES) {
      throw new AppError('pdf_too_many_pages', {
        userMessage: `"${input.filename}" looks like a scan, and we read up to ${MAX_SCANNED_PDF_PAGES} scanned pages at a time.`,
        nextAction: 'Upload just the schedule pages, or paste the text instead.',
      });
    }
    logger.info('parse.pdf_scanned', { filename: input.filename, pageCount, textLength: text.length });
    return {
      kind: 'pdf-scan',
      filename: input.filename,
      text: '',
      base64: Buffer.from(input.bytes).toString('base64'),
      mediaType: null,
      pageCount,
    };
  }

  if (text.length === 0) {
    throw new AppError('empty_document', {
      userMessage: `"${input.filename}" opened, but there was no text inside it.`,
    });
  }

  return {
    kind: 'text',
    filename: input.filename,
    text: text.slice(0, MAX_DOCUMENT_CHARS),
    base64: null,
    mediaType: null,
    pageCount,
  };
}

async function parseDocx(input: ParseInput): Promise<ParsedFile> {
  let text: string;
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(input.bytes) });
    text = tidyText(result.value ?? '');
  } catch (err) {
    logger.warn('parse.docx_failed', { filename: input.filename, ...errorFields(err) });
    throw new AppError('unparseable_file', {
      userMessage: `We couldn't read "${input.filename}" as a Word document.`,
      nextAction: 'Re-save it as .docx or a PDF, or paste the text instead.',
      cause: err,
    });
  }

  if (text.length === 0) {
    throw new AppError('empty_document', {
      userMessage: `"${input.filename}" opened, but there was no text inside it.`,
    });
  }
  return { kind: 'text', filename: input.filename, text: text.slice(0, MAX_DOCUMENT_CHARS), base64: null, mediaType: null, pageCount: null };
}

function parsePlainText(input: ParseInput): ParsedFile {
  const text = tidyText(new TextDecoder('utf-8', { fatal: false }).decode(input.bytes));
  if (text.length === 0) {
    throw new AppError('empty_document', {
      userMessage: `"${input.filename}" was empty.`,
    });
  }
  return { kind: 'text', filename: input.filename, text: text.slice(0, MAX_DOCUMENT_CHARS), base64: null, mediaType: null, pageCount: null };
}

function parseImage(input: ParseInput, mediaType: ImageMediaType): ParsedFile {
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new AppError('file_too_large', {
      userMessage: `"${input.filename}" is too large to read as an image.`,
      nextAction: 'Screenshot just the schedule, or upload the original PDF.',
    });
  }
  return {
    kind: 'image',
    filename: input.filename,
    text: '',
    base64: Buffer.from(input.bytes).toString('base64'),
    mediaType,
    pageCount: null,
  };
}

export async function parseFile(input: ParseInput): Promise<ParsedFile> {
  assertSupported(input.filename, input.mimeType);

  if (input.bytes.byteLength === 0) {
    throw new AppError('empty_document', { userMessage: `"${input.filename}" was empty.` });
  }

  if (isPdf(input.filename, input.mimeType)) return parsePdf(input);
  if (isDocx(input.filename, input.mimeType)) return parseDocx(input);

  const media = imageMediaType(input.filename, input.mimeType);
  if (media) return parseImage(input, media);

  return parsePlainText(input);
}
