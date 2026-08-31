import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawItem } from '@/lib/extract/schema';
import type { DocumentContext } from '@/lib/extract/prompt';
import { CASES_DIR } from '../fixtures';

/**
 * The whole pipeline, with only the model call stubbed.
 *
 * Real files go in — a real PDF, a real .docx, a real PNG, plain text — and are
 * parsed by the real parsers, chunked by the real chunker, normalised and
 * deduplicated by the real code. Only the network call is replaced, so this
 * covers the plumbing the accuracy suite cannot exercise without an API key:
 * mixed formats merging into one schedule, cross-file deduplication, relative
 * date resolution, and partial failure.
 */

// Per-call scripted responses, keyed by a substring of the filename.
const responses = new Map<string, RawItem[]>();
const calls: { filename: string; kind: string }[] = [];
let failFor: string | null = null;

function raw(p: Partial<RawItem> & { title: string; course_code: string }): RawItem {
  return {
    type: 'assignment',
    course_name: null,
    due_date: null,
    due_time: null,
    relative_reference: null,
    weight: null,
    location: null,
    source_snippet: `source for ${p.title}`,
    confidence: 'high',
    ...p,
  };
}

function itemsFor(ctx: DocumentContext, kind: string): { items: RawItem[]; usage: unknown; model: string } {
  calls.push({ filename: ctx.filename, kind });
  if (failFor && ctx.filename.includes(failFor)) {
    throw new Error('simulated model failure');
  }
  for (const [needle, items] of responses) {
    if (ctx.filename.includes(needle)) {
      return { items, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'stub' };
    }
  }
  return { items: [], usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 'stub' };
}

vi.mock('@/lib/extract/client', () => ({
  DEFAULT_MODEL: 'stub',
  extractionModel: () => 'stub',
  extractFromText: (ctx: DocumentContext) => Promise.resolve(itemsFor(ctx, 'text')),
  extractFromImage: (ctx: DocumentContext) => Promise.resolve(itemsFor(ctx, 'image')),
  extractFromPdfDocument: (ctx: DocumentContext) => Promise.resolve(itemsFor(ctx, 'pdf-scan')),
}));

const { runExtraction } = await import('@/lib/extract/pipeline');
const { parseFile } = await import('@/lib/parse');

async function source(filename: string, mimeType: string) {
  const bytes = new Uint8Array(readFileSync(join(CASES_DIR, filename)));
  const parsed = await parseFile({ filename, mimeType, bytes, maxPdfPages: 60 });
  return { uploadId: `upload-${filename}`, parsed };
}

const TERM = {
  termName: 'Fall 2026',
  termStartDate: '2026-08-24',
  termEndDate: '2026-12-11',
  courseHint: null,
  meetingDaysByCourse: { 'cs 2110': [1, 3, 5] },
  defaultMeetingDays: [] as number[],
};

beforeEach(() => {
  responses.clear();
  calls.length = 0;
  failFor = null;
});

describe('four mixed-format files become one merged schedule', () => {
  it('reads a PDF, a Word file, a screenshot and pasted text in one batch', async () => {
    responses.set('arch350', [
      raw({ title: 'Building Analysis 1', course_code: 'ARCH 350', due_date: '2026-09-10', weight: 10 }),
      raw({ title: 'Midterm Examination', course_code: 'ARCH 350', type: 'exam', due_date: '2026-10-06' }),
    ]);
    responses.set('govt312', [
      raw({ title: 'Case Brief 1', course_code: 'GOVT 312', due_date: '2026-09-15' }),
    ]);
    responses.set('canvas-screenshot', [
      raw({ title: 'Homework 5', course_code: 'PHYS 213', due_date: '2026-09-18', due_time: '23:59' }),
    ]);
    responses.set('Pasted text', [
      raw({ title: 'Problem Set 1', course_code: 'CS 2110', due_date: '2026-08-28' }),
    ]);

    const result = await runExtraction({
      sources: [
        await source('10-arch350-table.pdf', 'application/pdf'),
        await source('12-govt312-word.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
        await source('11-canvas-screenshot.png', 'image/png'),
      ],
      pastedText: 'CS 2110 — Problem Set 1 due Aug 28',
      ...TERM,
    });

    expect(result.fileErrors).toEqual([]);
    expect(result.items).toHaveLength(5);

    // One schedule, four courses, every item attributed correctly.
    const courses = [...new Set(result.items.map((i) => i.courseCode))].sort();
    expect(courses).toEqual(['ARCH 350', 'CS 2110', 'GOVT 312', 'PHYS 213']);

    // Every item traces to the file it came from.
    const bySource = Object.fromEntries(result.items.map((i) => [i.title, i.sourceFilename]));
    expect(bySource['Building Analysis 1']).toBe('10-arch350-table.pdf');
    expect(bySource['Case Brief 1']).toBe('12-govt312-word.docx');
    expect(bySource['Homework 5']).toBe('11-canvas-screenshot.png');
    expect(bySource['Problem Set 1']).toBe('Pasted text');
  });

  it('routes each format down the right extraction path', async () => {
    await runExtraction({
      sources: [
        await source('10-arch350-table.pdf', 'application/pdf'),
        await source('12-govt312-word.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
        await source('11-canvas-screenshot.png', 'image/png'),
      ],
      pastedText: 'some text',
      ...TERM,
    });

    const kindByFile = Object.fromEntries(calls.map((c) => [c.filename, c.kind]));
    // The PDF has a real text layer, so it must NOT go down the vision path.
    expect(kindByFile['10-arch350-table.pdf']).toBe('text');
    expect(kindByFile['12-govt312-word.docx']).toBe('text');
    expect(kindByFile['11-canvas-screenshot.png']).toBe('image');
    expect(kindByFile['Pasted text']).toBe('text');
  });

  it('treats pasted text as a first-class source, not a fallback', async () => {
    responses.set('Pasted text', [raw({ title: 'Essay', course_code: 'ENGL 210', due_date: '2026-10-01' })]);
    const result = await runExtraction({ sources: [], pastedText: 'ENGL 210 essay due Oct 1', ...TERM });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.sourceFilename).toBe('Pasted text');
  });
});

describe('deduplication across files', () => {
  it('collapses the same midterm listed in two documents', async () => {
    responses.set('arch350', [
      raw({ title: 'Midterm Examination', course_code: 'ARCH 350', type: 'exam', due_date: '2026-10-06' }),
    ]);
    responses.set('Pasted text', [
      raw({ title: 'Midterm Exam', course_code: 'ARCH 350', type: 'exam', due_date: '2026-10-06',
            due_time: '14:00', location: 'Sibley 101', weight: 25 }),
    ]);

    const result = await runExtraction({
      sources: [await source('10-arch350-table.pdf', 'application/pdf')],
      pastedText: 'Midterm Exam — Oct 6, 2pm, Sibley 101 (25%)',
      ...TERM,
    });

    expect(result.items).toHaveLength(1);
    const merged = result.items[0]!;
    // The merge keeps the richer field from each copy.
    expect(merged.dueTime).toBe('14:00');
    expect(merged.timeIsDefault).toBe(false);
    expect(merged.location).toBe('Sibley 101');
    expect(merged.weight).toBe(25);
  });

  it('does not merge the same title across different courses', async () => {
    responses.set('arch350', [raw({ title: 'Final Exam', course_code: 'ARCH 350', type: 'exam', due_date: '2026-12-10' })]);
    responses.set('Pasted text', [raw({ title: 'Final Exam', course_code: 'GOVT 312', type: 'exam', due_date: '2026-12-10' })]);

    const result = await runExtraction({
      sources: [await source('10-arch350-table.pdf', 'application/pdf')],
      pastedText: 'GOVT 312 Final Exam Dec 10',
      ...TERM,
    });
    expect(result.items).toHaveLength(2);
  });
});

describe('relative dates resolve through the whole pipeline', () => {
  it('turns "Week 3, Thursday" into a real date', async () => {
    responses.set('Pasted text', [
      raw({
        title: 'Response Paper', course_code: 'CS 2110', confidence: 'high',
        relative_reference: { kind: 'week_weekday', week: 3, weekday: 'thursday', meeting_index: null, raw: 'Week 3, Thu' },
      }),
    ]);
    const result = await runExtraction({ sources: [], pastedText: 'x', ...TERM });
    expect(result.items[0]!.dueDate).toBe('2026-09-10');
    // A resolved relative date is an inference, so it is never reported as high.
    expect(result.items[0]!.confidence).toBe('medium');
  });

  it('refuses to invent a date it cannot resolve', async () => {
    responses.set('Pasted text', [
      raw({
        title: 'Reaction Paper 2', course_code: 'CS 2110',
        relative_reference: { kind: 'unresolvable', week: null, weekday: null, meeting_index: null, raw: 'the class after fall break' },
      }),
    ]);
    const result = await runExtraction({ sources: [], pastedText: 'x', ...TERM });
    expect(result.items[0]!.dueDate).toBeNull();
    expect(result.items[0]!.dueTime).toBeNull();
    expect(result.items[0]!.confidence).toBe('low');
    expect(result.items[0]!.unresolvedReason).toBeTruthy();
  });

  it('defaults a stated date with no time to 11:59 PM and flags it', async () => {
    responses.set('Pasted text', [raw({ title: 'Essay', course_code: 'CS 2110', due_date: '2026-10-01' })]);
    const result = await runExtraction({ sources: [], pastedText: 'x', ...TERM });
    expect(result.items[0]!.dueTime).toBe('23:59');
    expect(result.items[0]!.timeIsDefault).toBe(true);
  });
});

describe('partial failure', () => {
  it('returns what succeeded and names the file that did not', async () => {
    failFor = 'canvas-screenshot';
    responses.set('arch350', [raw({ title: 'Building Analysis 1', course_code: 'ARCH 350', due_date: '2026-09-10' })]);

    const result = await runExtraction({
      sources: [
        await source('10-arch350-table.pdf', 'application/pdf'),
        await source('11-canvas-screenshot.png', 'image/png'),
      ],
      pastedText: null,
      ...TERM,
    });

    expect(result.items).toHaveLength(1);
    expect(result.fileErrors).toHaveLength(1);
    expect(result.fileErrors[0]!.filename).toBe('11-canvas-screenshot.png');
    expect(result.fileErrors[0]!.reason.length).toBeGreaterThan(10);
    expect(result.anySucceeded).toBe(true);
  });

  it('throws only when every source failed', async () => {
    failFor = '.png';
    await expect(
      runExtraction({
        sources: [await source('11-canvas-screenshot.png', 'image/png')],
        pastedText: null,
        ...TERM,
      }),
    ).rejects.toThrow();
  });

  it('refuses a batch with nothing in it', async () => {
    await expect(runExtraction({ sources: [], pastedText: null, ...TERM })).rejects.toThrow();
  });
});

describe('long documents are chunked', () => {
  it('makes more than one model call for a document past the chunk size', async () => {
    const long = Array.from({ length: 3000 }, (_, i) => `Week ${i % 15}: item ${i} due 2026-10-0${(i % 9) + 1}`).join('\n');
    await runExtraction({ sources: [], pastedText: long, ...TERM });
    expect(calls.filter((c) => c.filename === 'Pasted text').length).toBeGreaterThan(1);
  });

  it('accumulates token usage across every chunk', async () => {
    responses.set('Pasted text', [raw({ title: 'A', course_code: 'CS 2110', due_date: '2026-10-01' })]);
    const long = 'x'.repeat(60_000);
    const result = await runExtraction({ sources: [], pastedText: long, ...TERM });
    expect(result.chunkCount).toBeGreaterThan(1);
    expect(result.usage.inputTokens).toBeGreaterThan(100);
  });
});

describe('every item is traceable', () => {
  it('drops an item the model returned without a source snippet', async () => {
    responses.set('Pasted text', [
      raw({ title: 'Real', course_code: 'CS 2110', due_date: '2026-10-01' }),
      raw({ title: 'Ghost', course_code: 'CS 2110', due_date: '2026-10-02', source_snippet: '   ' }),
    ]);
    const result = await runExtraction({ sources: [], pastedText: 'x', ...TERM });
    expect(result.items.map((i) => i.title)).toEqual(['Real']);
  });

  it('gives every surviving item a non-empty snippet and a dedupe key', async () => {
    responses.set('Pasted text', [
      raw({ title: 'A', course_code: 'CS 2110', due_date: '2026-10-01' }),
      raw({ title: 'B', course_code: 'CS 2110', due_date: '2026-10-02' }),
    ]);
    const result = await runExtraction({ sources: [], pastedText: 'x', ...TERM });
    for (const item of result.items) {
      expect(item.sourceSnippet.trim().length).toBeGreaterThan(0);
      expect(item.dedupeKey.length).toBeGreaterThan(0);
    }
  });
});
