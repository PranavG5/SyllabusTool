import { describe, it, expect, beforeAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixtures, type ExpectedItem, type Fixture } from '../fixtures';
import { parseFile } from '@/lib/parse';
import { runExtraction, type PipelineItem } from '@/lib/extract/pipeline';
import { canonicalTitle, normalizeCourseCode } from '@/lib/extract/normalize';
import { estimateCostUsd } from '@/lib/pricing';
import { parseISODate } from '@/lib/datetime';

/**
 * The regression gate for extraction accuracy.
 *
 * Skipped unless RUN_ACCURACY_TESTS=1 because it makes real API calls that
 * cost real money. CI runs it on the extraction paths; `npm test` does not.
 */
const ENABLED = process.env.RUN_ACCURACY_TESTS === '1' && Boolean(process.env.ANTHROPIC_API_KEY);
const suite = ENABLED ? describe : describe.skip;

interface Score {
  id: string;
  name: string;
  recall: number;
  precision: number;
  matched: number;
  expected: number;
  extracted: number;
  wrongDates: string[];
  inventedDates: string[];
  forbidden: string[];
  costUsd: number;
}

const scores: Score[] = [];

function key(course: string, title: string): string {
  return `${normalizeCourseCode(course).toLowerCase()}::${canonicalTitle(title)}`;
}

/** An expected title matches loosely: the canonical forms must overlap. */
function matches(expected: ExpectedItem, item: PipelineItem): boolean {
  if (normalizeCourseCode(expected.course).toLowerCase() !== item.courseCode.toLowerCase()) {
    return false;
  }
  const a = canonicalTitle(expected.title);
  const b = canonicalTitle(item.title);
  return a === b || b.includes(a) || a.includes(b);
}

async function extractFixture(fixture: Fixture): Promise<PipelineItem[]> {
  const ctx = fixture.expectation.context;
  const parsed = await parseFile({
    filename: fixture.filename,
    mimeType: fixture.mimeType,
    bytes: fixture.bytes,
    maxPdfPages: 60,
  });

  const result = await runExtraction({
    sources: [{ uploadId: null, parsed }],
    pastedText: null,
    termName: ctx.termName,
    termStartDate: ctx.termStart,
    termEndDate: ctx.termEnd,
    courseHint: ctx.courseHint,
    meetingDaysByCourse: {},
    defaultMeetingDays: ctx.meetingDays,
  });

  scores.push({
    id: fixture.id,
    name: fixture.expectation.name,
    recall: 0, precision: 0, matched: 0,
    expected: fixture.expectation.expectedItems.length,
    extracted: result.items.length,
    wrongDates: [], inventedDates: [], forbidden: [],
    costUsd: estimateCostUsd(result.model, result.usage),
  });

  return result.items;
}

suite('extraction accuracy', () => {
  const fixtures = loadFixtures();

  beforeAll(() => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
  });

  for (const fixture of fixtures) {
    const exp = fixture.expectation;

    it(`${fixture.id}: ${exp.name}`, async () => {
      const items = await extractFixture(fixture);
      const score = scores[scores.length - 1]!;

      // ---- Recall: did we find the work? A wrong date is a miss, not a hit.
      const wrongDates: string[] = [];
      let matched = 0;
      for (const want of exp.expectedItems) {
        const hit = items.find((item) => matches(want, item));
        if (!hit) continue;
        if (want.dueDate && hit.dueDate !== want.dueDate) {
          wrongDates.push(`${want.course} ${want.title}: expected ${want.dueDate}, got ${hit.dueDate ?? 'null'}`);
          continue;
        }
        // `dueTime: null` is a real assertion — it says the syllabus gave no
        // time and the item must stay all-day rather than being handed an
        // invented 11:59 PM.
        if (want.dueTime !== undefined && hit.dueTime !== want.dueTime) {
          wrongDates.push(
            `${want.course} ${want.title}: expected time ${want.dueTime ?? 'none (all-day)'}, got ${hit.dueTime ?? 'none'}`,
          );
          continue;
        }
        matched += 1;
      }
      const recall = exp.expectedItems.length === 0 ? 1 : matched / exp.expectedItems.length;

      // ---- Precision: did we invent work?
      const allowed = new Set(exp.expectedItems.map((e) => key(e.course, e.title)));
      for (const t of exp.allowedExtraTitles ?? []) allowed.add(canonicalTitle(t));
      for (const d of exp.expectedDatelessItems ?? []) allowed.add(key(d.course, d.title));

      const spurious = items.filter((item) => {
        if (allowed.has(key(item.courseCode, item.title))) return false;
        const canon = canonicalTitle(item.title);
        if (allowed.has(canon)) return false;
        // An allowed-extra prefix ("lab 1" covering "Lab 1: Calorimetry").
        for (const a of allowed) {
          if (canon.includes(a) || a.includes(canon)) return false;
        }
        return true;
      });
      const precision = items.length === 0 ? 1 : (items.length - spurious.length) / items.length;

      // ---- The absolute gate: no invented dates.
      const inventedDates: string[] = [];
      for (const want of exp.expectedDatelessItems ?? []) {
        const hit = items.find((item) => matches({ ...want, title: want.title }, item));
        if (hit && hit.dueDate !== null) {
          inventedDates.push(`${want.course} ${want.title}: invented ${hit.dueDate}`);
        }
      }

      // ---- Forbidden titles: office hours, nav chrome, policy text.
      const forbidden: string[] = [];
      for (const bad of exp.mustNotExtract ?? []) {
        const hit = items.find((item) => item.title.toLowerCase().includes(bad.toLowerCase()));
        if (hit) forbidden.push(`${bad} -> "${hit.title}"`);
      }

      // ---- Every item must be traceable and internally consistent.
      for (const item of items) {
        expect(item.sourceSnippet.trim().length, `${item.title} has no source snippet`).toBeGreaterThan(0);
        if (item.dueDate) {
          expect(parseISODate(item.dueDate), `${item.title} has an unparseable date`).not.toBeNull();
          // A dated item may legitimately have no time — that is an all-day
          // deadline, and the common case.
        } else {
          // A time without a date is fine and worth keeping: the syllabus said
          // "2:30 PM" but gave nothing we could pin a day to. Discarding it
          // would make the student retype what the document already told us.
          expect(item.confidence, `${item.title} is undated but not low confidence`).toBe('low');
        }
      }

      Object.assign(score, { recall, precision, matched, wrongDates, inventedDates, forbidden });

      expect(inventedDates, 'invented a date for an item the document does not date').toEqual([]);
      expect(forbidden, 'extracted something that is not coursework').toEqual([]);
      expect(wrongDates, 'matched an item but with the wrong date or time').toEqual([]);
      expect(recall, `recall ${recall.toFixed(2)} below floor ${exp.minRecall}`).toBeGreaterThanOrEqual(exp.minRecall);
      expect(
        precision,
        `precision ${precision.toFixed(2)} below floor ${exp.minPrecision}; spurious: ${spurious.map((s) => s.title).join(', ')}`,
      ).toBeGreaterThanOrEqual(exp.minPrecision);
    });
  }

  it('writes an accuracy report', () => {
    const dir = join(process.cwd(), 'tests', '.tmp');
    mkdirSync(dir, { recursive: true });
    const totalCost = scores.reduce((s, x) => s + x.costUsd, 0);
    const meanRecall = scores.reduce((s, x) => s + x.recall, 0) / Math.max(scores.length, 1);
    const meanPrecision = scores.reduce((s, x) => s + x.precision, 0) / Math.max(scores.length, 1);
    const report = { generatedAt: new Date().toISOString(), meanRecall, meanPrecision, totalCostUsd: totalCost, cases: scores };
    writeFileSync(join(dir, 'accuracy-report.json'), JSON.stringify(report, null, 2));
    console.log(
      `\naccuracy: recall ${(meanRecall * 100).toFixed(1)}%  precision ${(meanPrecision * 100).toFixed(1)}%  cost $${totalCost.toFixed(4)}`,
    );
  });
});

describe('fixture set integrity', () => {
  const fixtures = loadFixtures();

  it('covers the messy cases the product has to handle', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    const ids = fixtures.map((f) => f.id).join(' ');
    expect(ids).toMatch(/table/);
    expect(ids).toMatch(/week-relative/);
    expect(ids).toMatch(/no-times/);
    expect(ids).toMatch(/two-courses/);
    expect(ids).toMatch(/screenshot/);
    // A real PDF and a real image, not just text files pretending.
    expect(fixtures.some((f) => f.mimeType === 'application/pdf')).toBe(true);
    expect(fixtures.some((f) => f.mimeType.startsWith('image/'))).toBe(true);
  });

  it('declares a usable expectation for every fixture', () => {
    for (const f of fixtures) {
      const e = f.expectation;
      expect(e.name, `${f.id} has no name`).toBeTruthy();
      expect(e.minRecall).toBeGreaterThan(0);
      expect(e.minPrecision).toBeGreaterThan(0);
      expect(Array.isArray(e.expectedItems)).toBe(true);
      for (const item of e.expectedItems) {
        expect(item.title, `${f.id} expectation missing title`).toBeTruthy();
        expect(item.course, `${f.id} expectation missing course`).toBeTruthy();
        if (item.dueDate) expect(parseISODate(item.dueDate), `${f.id}: bad date ${item.dueDate}`).not.toBeNull();
      }
    }
  });

  it('parses every text fixture offline', async () => {
    for (const f of fixtures) {
      if (f.mimeType.startsWith('image/')) continue;
      const parsed = await parseFile({
        filename: f.filename, mimeType: f.mimeType, bytes: f.bytes, maxPdfPages: 60,
      });
      expect(parsed.kind, `${f.id} should parse as text`).toBe('text');
      expect(parsed.text.length, `${f.id} produced no text`).toBeGreaterThan(200);
    }
  });

  it('routes the screenshot fixture down the vision path', async () => {
    const png = fixtures.find((f) => f.mimeType === 'image/png')!;
    const parsed = await parseFile({
      filename: png.filename, mimeType: png.mimeType, bytes: png.bytes, maxPdfPages: 60,
    });
    expect(parsed.kind).toBe('image');
    expect(parsed.base64).toBeTruthy();
    expect(parsed.mediaType).toBe('image/png');
  });
});
