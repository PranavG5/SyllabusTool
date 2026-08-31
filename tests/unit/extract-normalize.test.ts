import { describe, it, expect } from 'vitest';
import { normalizeItem, normalizeItems, normalizeCourseCode, canonicalTitle } from '@/lib/extract/normalize';
import { dedupeItems } from '@/lib/extract/dedupe';
import { chunkText, estimateTokens } from '@/lib/extract/chunk';
import type { RawItem } from '@/lib/extract/schema';

const CTX = {
  termStart: { year: 2026, month: 8, day: 24 },
  termEnd: { year: 2026, month: 12, day: 11 },
  meetingDaysByCourse: { 'cs 2110': [1, 3, 5] },
  defaultMeetingDays: [] as number[],
};

function raw(p: Partial<RawItem> = {}): RawItem {
  return {
    title: 'Problem Set 4',
    type: 'assignment',
    course_code: 'CS 2110',
    course_name: 'Object-Oriented Programming',
    due_date: '2026-10-15',
    due_time: null,
    relative_reference: null,
    weight: null,
    location: null,
    source_snippet: 'PS4 — due Oct 15',
    confidence: 'high',
    ...p,
  };
}

describe('course code normalisation', () => {
  it('normalises spacing and case', () => {
    expect(normalizeCourseCode('cs2110')).toBe('CS 2110');
    expect(normalizeCourseCode('CS  2110')).toBe('CS 2110');
    expect(normalizeCourseCode('cs-2110')).toBe('CS 2110');
    expect(normalizeCourseCode(' HIST 105 ')).toBe('HIST 105');
  });

  it('leaves course names that are not codes alone', () => {
    expect(normalizeCourseCode('Introduction to Anthropology')).toBe('Introduction to Anthropology');
  });

  it('handles an empty code', () => {
    expect(normalizeCourseCode('   ')).toBe('Unknown course');
  });
});

describe('title canonicalisation', () => {
  it('collapses common abbreviations to one form', () => {
    const forms = ['Problem Set 4', 'PS4', 'PS 4', 'P-Set 4', 'Problem set #4'];
    const canon = forms.map(canonicalTitle);
    expect(new Set(canon).size).toBe(1);
  });

  it('collapses roman numerals', () => {
    expect(canonicalTitle('Midterm II')).toBe(canonicalTitle('Midterm 2'));
  });

  it('keeps genuinely different work apart', () => {
    expect(canonicalTitle('Problem Set 4')).not.toBe(canonicalTitle('Problem Set 5'));
    expect(canonicalTitle('Midterm 1')).not.toBe(canonicalTitle('Final'));
  });
});

describe('normalizeItem', () => {
  it('leaves a date with no stated time as an all-day deadline', () => {
    const item = normalizeItem(raw(), CTX)!;
    expect(item.dueDate).toBe('2026-10-15');
    // Never 23:59. A syllabus that names a day names a day; inventing a time
    // one minute before midnight makes the item timezone-dependent and can
    // land it on the following date for anyone east of the term's zone.
    expect(item.dueTime).toBeNull();
  });

  it('keeps a time the syllabus actually stated', () => {
    const item = normalizeItem(raw({ due_time: '17:00' }), CTX)!;
    expect(item.dueTime).toBe('17:00');
  });

  it('keeps a stated 11:59 PM, because that one is real', () => {
    // Canvas exports literally say "due by 11:59pm". When the source says it,
    // it is a stated time and becomes a timed event.
    const item = normalizeItem(raw({ due_time: '23:59' }), CTX)!;
    expect(item.dueTime).toBe('23:59');
  });

  it('ignores a time the model returns in an unusable form', () => {
    expect(normalizeItem(raw({ due_time: '25:99' }), CTX)!.dueTime).toBeNull();
  });

  it('resolves a week-relative reference and downgrades from high to medium', () => {
    const item = normalizeItem(
      raw({
        due_date: null,
        confidence: 'high',
        relative_reference: { kind: 'week_weekday', week: 3, weekday: 'thursday', meeting_index: null, raw: 'Week 3, Thu' },
      }),
      CTX,
    )!;
    expect(item.dueDate).toBe('2026-09-10');
    expect(item.confidence).toBe('medium');
  });

  it('emits a null date and low confidence for an unresolvable reference', () => {
    const item = normalizeItem(
      raw({
        due_date: null,
        confidence: 'medium',
        relative_reference: { kind: 'unresolvable', week: null, weekday: null, meeting_index: null, raw: 'the class after spring break' },
      }),
      CTX,
    )!;
    expect(item.dueDate).toBeNull();
    expect(item.confidence).toBe('low');
    expect(item.unresolvedReason).toBeTruthy();
    expect(item.dueTime).toBeNull();
  });

  it('never invents a date when the model gives neither form', () => {
    const item = normalizeItem(raw({ due_date: null, relative_reference: null }), CTX)!;
    expect(item.dueDate).toBeNull();
    expect(item.confidence).toBe('low');
  });

  it('rejects a malformed date rather than passing it through', () => {
    const item = normalizeItem(raw({ due_date: '2026-02-30' }), CTX)!;
    expect(item.dueDate).toBeNull();
    expect(item.confidence).toBe('low');
  });

  it('drops an item with no source snippet', () => {
    expect(normalizeItem(raw({ source_snippet: '   ' }), CTX)).toBeNull();
  });

  it('drops an item with no title', () => {
    expect(normalizeItem(raw({ title: '' }), CTX)).toBeNull();
  });

  it('rejects an out-of-range weight but keeps a valid one', () => {
    expect(normalizeItem(raw({ weight: 150 }), CTX)!.weight).toBeNull();
    expect(normalizeItem(raw({ weight: 12.5 }), CTX)!.weight).toBe(12.5);
  });

  it('uses per-course meeting days for a week_meeting reference', () => {
    const item = normalizeItem(
      raw({
        due_date: null,
        relative_reference: { kind: 'week_meeting', week: 5, weekday: null, meeting_index: 2, raw: '2nd class, wk 5' },
      }),
      CTX,
    )!;
    expect(item.dueDate).toBe('2026-09-23'); // Wednesday of week 5, MWF
  });
});

describe('dedupe', () => {
  it('collapses the same item seen in two files', () => {
    const items = normalizeItems([raw(), raw({ source_snippet: 'Problem Set 4 due October 15, 2026' })], CTX);
    expect(dedupeItems(items)).toHaveLength(1);
  });

  it('collapses PS4 and Problem Set 4 into one item', () => {
    const items = normalizeItems([raw({ title: 'PS4' }), raw({ title: 'Problem Set 4' })], CTX);
    const merged = dedupeItems(items);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe('Problem Set 4'); // the fuller title survives
  });

  it('keeps the richer fields from each copy', () => {
    const items = normalizeItems(
      [
        raw({ weight: null, due_time: null, location: null }),
        raw({ weight: 10, due_time: '17:00', location: 'Gates B01', source_snippet: 'PS4 — due Oct 15 at 5pm in Gates B01 (10%)' }),
      ],
      CTX,
    );
    const merged = dedupeItems(items);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.weight).toBe(10);
    expect(merged[0]!.dueTime).toBe('17:00');
    expect(merged[0]!.location).toBe('Gates B01');
  });

  it('folds an undated mention into the dated one', () => {
    const items = normalizeItems(
      [raw(), raw({ due_date: null, relative_reference: null, source_snippet: 'Problem Set 4 (see schedule)' })],
      CTX,
    );
    const merged = dedupeItems(items);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.dueDate).toBe('2026-10-15');
    expect(merged[0]!.unresolvedReason).toBeNull();
  });

  it('keeps genuinely different items apart', () => {
    const items = normalizeItems(
      [raw(), raw({ title: 'Problem Set 5', due_date: '2026-10-22' }), raw({ course_code: 'HIST 105' })],
      CTX,
    );
    expect(dedupeItems(items)).toHaveLength(3);
  });

  it('does not merge the same title in two different courses', () => {
    const items = normalizeItems([raw(), raw({ course_code: 'MATH 200' })], CTX);
    expect(dedupeItems(items)).toHaveLength(2);
  });

  it('keeps a recurring quiz on different dates apart', () => {
    const items = normalizeItems(
      [raw({ title: 'Quiz', due_date: '2026-09-01' }), raw({ title: 'Quiz', due_date: '2026-09-08' })],
      CTX,
    );
    expect(dedupeItems(items)).toHaveLength(2);
  });
});

describe('chunking', () => {
  it('returns one chunk for short text', () => {
    expect(chunkText('short syllabus')).toEqual([{ text: 'short syllabus', index: 0, start: 0 }]);
  });

  it('returns nothing for empty text', () => {
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('splits long text with overlap and covers the whole document', () => {
    const lines = Array.from({ length: 800 }, (_, i) => `Week ${i}: assignment ${i} due 2026-01-01`);
    const text = lines.join('\n');
    const chunks = chunkText(text, { chunkChars: 4000, overlapChars: 400 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every line must survive somewhere.
    const joined = chunks.map((c) => c.text).join('\n');
    for (const line of [lines[0]!, lines[400]!, lines[799]!]) {
      expect(joined).toContain(line);
    }
  });

  it('makes progress even when a single line exceeds the window', () => {
    const chunks = chunkText('x'.repeat(50_000), { chunkChars: 2000, overlapChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 2000)).toBe(true);
  });

  it('estimates tokens', () => {
    expect(estimateTokens('a'.repeat(4000))).toBe(1000);
  });
});

describe('long and short spellings converge', () => {
  // These pairs are what actually appears when a student uploads both the
  // syllabus and the course calendar for the same class.
  const pairs: [string, string][] = [
    ['Midterm Examination', 'Midterm Exam'],
    ['Final Examination', 'Final Exam'],
    ['Exam 2', 'Examination 2'],
    ['Quiz 3', 'Quizzes 3'],
    ['Problem Sets 4', 'Problem Set 4'],
    ['Prelim 1', 'Prelims 1'],
    ['Research Papers', 'Research Paper'],
    ['Group Presentations', 'Group Presentation'],
  ];

  it.each(pairs)('treats "%s" and "%s" as the same item', (a, b) => {
    expect(canonicalTitle(a)).toBe(canonicalTitle(b));
  });

  it('still keeps genuinely different work apart', () => {
    expect(canonicalTitle('Midterm Exam')).not.toBe(canonicalTitle('Final Exam'));
    expect(canonicalTitle('Exam 1')).not.toBe(canonicalTitle('Exam 2'));
    expect(canonicalTitle('Final Project')).not.toBe(canonicalTitle('Final Exam'));
    expect(canonicalTitle('Lab Report 1')).not.toBe(canonicalTitle('Lab Report 2'));
    expect(canonicalTitle('Reading Response')).not.toBe(canonicalTitle('Reading Quiz'));
  });

  it('dedupes them for real, not just in the canonical form', () => {
    const items = normalizeItems(
      [
        raw({ title: 'Midterm Examination', type: 'exam', due_date: '2026-10-06' }),
        raw({ title: 'Midterm Exam', type: 'exam', due_date: '2026-10-06', due_time: '14:00', location: 'Sibley 101' }),
      ],
      CTX,
    );
    const merged = dedupeItems(items);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.dueTime).toBe('14:00');
    expect(merged[0]!.location).toBe('Sibley 101');
  });

  it('takes a stated time from whichever copy has one', () => {
    const items = normalizeItems(
      [
        raw({ title: 'Midterm', type: 'exam', due_date: '2026-10-06' }),
        raw({ title: 'Midterm', type: 'exam', due_date: '2026-10-06', due_time: '19:30' }),
      ],
      CTX,
    );
    const merged = dedupeItems(items);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.dueTime).toBe('19:30');
  });

  it('leaves a merged item all-day when neither copy stated a time', () => {
    const items = normalizeItems(
      [
        raw({ title: 'Essay', due_date: '2026-11-02' }),
        raw({ title: 'Essay', due_date: '2026-11-02', source_snippet: 'Essay — Nov 2 (see Canvas)' }),
      ],
      CTX,
    );
    const merged = dedupeItems(items);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.dueTime).toBeNull();
  });
});
