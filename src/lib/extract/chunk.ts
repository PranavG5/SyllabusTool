/**
 * Splitting long documents into model-sized excerpts.
 *
 * An 80-page course pack does not go into one request. Chunks overlap so a
 * table row that straddles a boundary is seen whole by at least one chunk;
 * the duplicate items that overlap produces are collapsed by dedupe.ts.
 */

/** ~4 chars/token, so this is roughly a 4k-token excerpt. */
export const DEFAULT_CHUNK_CHARS = 16_000;
export const DEFAULT_OVERLAP_CHARS = 1_200;

export interface Chunk {
  text: string;
  index: number;
  /** Character offset in the source document, for debugging bad extractions. */
  start: number;
}

export interface ChunkOptions {
  chunkChars?: number;
  overlapChars?: number;
}

/**
 * Splits on the last line break inside the window so a chunk rarely ends
 * mid-row. Falls back to a hard cut when a single "line" exceeds the window
 * (which happens with badly extracted PDF tables).
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const chunkChars = Math.max(1_000, options.chunkChars ?? DEFAULT_CHUNK_CHARS);
  const overlapChars = Math.max(0, Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, Math.floor(chunkChars / 2)));

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= chunkChars) return [{ text: trimmed, index: 0, start: 0 }];

  const chunks: Chunk[] = [];
  let cursor = 0;

  while (cursor < trimmed.length) {
    const hardEnd = Math.min(cursor + chunkChars, trimmed.length);
    let end = hardEnd;

    if (hardEnd < trimmed.length) {
      // Prefer a paragraph break, then any line break, in the last 25% of the window.
      const searchFloor = cursor + Math.floor(chunkChars * 0.75);
      const paragraph = trimmed.lastIndexOf('\n\n', hardEnd);
      const line = trimmed.lastIndexOf('\n', hardEnd);
      if (paragraph > searchFloor) end = paragraph;
      else if (line > searchFloor) end = line;
    }

    const slice = trimmed.slice(cursor, end).trim();
    if (slice.length > 0) chunks.push({ text: slice, index: chunks.length, start: cursor });

    if (end >= trimmed.length) break;
    const next = end - overlapChars;
    // Guarantee forward progress even in pathological inputs.
    cursor = next > cursor ? next : end;
  }

  return chunks;
}

/** Rough token estimate for budgeting and cost guards. English prose ~4 chars/token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
