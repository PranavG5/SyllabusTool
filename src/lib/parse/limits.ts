/**
 * Hard input caps. These exist to bound cost and to fail fast on files that
 * would burn an API call and then fail anyway.
 *
 * The per-plan numbers come from the `plan_limits` table; these are the
 * absolute ceilings no plan may exceed.
 */

export const ABSOLUTE_MAX_FILE_BYTES = 40 * 1024 * 1024;
export const ABSOLUTE_MAX_FILES = 25;
export const ABSOLUTE_MAX_PDF_PAGES = 300;
/** Beyond this a "PDF" is not a syllabus and we stop reading it. */
export const MAX_DOCUMENT_CHARS = 2_000_000;
/** Below this, a document that reports pages is a scan, not a text PDF. */
export const SCANNED_PDF_CHARS_PER_PAGE = 40;
/** Cost guard: only this many pages of a scanned PDF go to the vision path. */
export const MAX_SCANNED_PDF_PAGES = 20;
/** Images are re-encoded as base64, which inflates by 4/3. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'text/markdown',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export const SUPPORTED_EXTENSIONS = new Set([
  'pdf', 'docx', 'doc', 'txt', 'md', 'csv', 'png', 'jpg', 'jpeg', 'webp',
]);

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i + 1).toLowerCase();
}
