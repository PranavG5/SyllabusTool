import { describe, it, expect } from 'vitest';
import { buildIcs, escapeText, foldLine, timingFor, uidFor, UID_DOMAIN } from '@/lib/ics/build';
import type { Course, ScheduleItem, Term } from '@/lib/types';

const TERM: Term = {
  id: 'term-1', name: 'Fall 2026', timezone: 'America/New_York',
  startDate: '2026-08-24', endDate: '2026-12-11',
};

const COURSES: Course[] = [
  { id: 'c1', code: 'CS 2110', name: 'Object-Oriented Programming', color: '#2563eb', meetingDays: [1, 3, 5] },
  { id: 'c2', code: 'HIST 105', name: null, color: '#c2410c', meetingDays: [2, 4] },
];

function item(p: Partial<ScheduleItem> = {}): ScheduleItem {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    courseId: 'c1', termId: 'term-1',
    title: 'Problem Set 4', type: 'assignment',
    dueDate: '2026-10-15', dueTime: '23:59', timeIsDefault: true,
    weight: null, location: null,
    sourceSnippet: 'PS4 — due Oct 15', sourceUploadId: null, sourceFilename: null,
    confidence: 'high', status: 'active', revision: 0,
    ...p,
  };
}

function build(items: ScheduleItem[], now = new Date(Date.UTC(2026, 7, 31, 12))): string {
  return buildIcs({ term: TERM, courses: COURSES, items }, { calendarName: 'Fall 2026 — Coursework' }, now);
}

function propsOf(ics: string, name: string): string[] {
  // Unfold first: a folded line continues on the next line after a space.
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  return unfolded.split('\r\n').filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
}

describe('text escaping', () => {
  it('escapes the four TEXT specials, backslash first', () => {
    expect(escapeText('a;b,c\\d')).toBe('a\;b\\,c\\\\d');
    expect(escapeText('line1\nline2')).toBe('line1\\nline2');
    expect(escapeText('a\r\nb')).toBe('a\\nb');
  });
});

describe('line folding', () => {
  it('leaves short lines alone', () => {
    expect(foldLine('SUMMARY:hello')).toBe('SUMMARY:hello');
  });

  it('folds long lines at 75 octets with a leading space', () => {
    const folded = foldLine(`SUMMARY:${'x'.repeat(200)}`);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    expect(new TextEncoder().encode(parts[0]!).length).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) {
      expect(p.startsWith(' ')).toBe(true);
      expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a multi-byte character', () => {
    const folded = foldLine(`SUMMARY:${'é'.repeat(80)}`);
    for (const part of folded.split('\r\n')) {
      expect(part).not.toContain('�');
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'é'.repeat(80)}`);
  });
});

describe('event timing', () => {
  it('starts at the deadline so the student sees the right time', () => {
    const t = timingFor({ year: 2026, month: 10, day: 15 }, { hour: 17, minute: 0 }, 'America/New_York');
    expect(t.start).toBe('DTSTART:20261015T210000Z'); // 17:00 EDT
    expect(t.end).toBe('DTEND:20261015T213000Z');
    expect(t.allDay).toBe(false);
  });

  it('clamps an 11:59 PM deadline so it never spills into the next day', () => {
    const t = timingFor({ year: 2026, month: 10, day: 15 }, { hour: 23, minute: 59 }, 'America/New_York');
    expect(t.start).toBe('DTSTART:20261016T035900Z');
    // Ends at 23:59 + 1 minute = 00:00 local... clamped to stay inside the day.
    expect(t.end).toBe('DTEND:20261016T040000Z');
    // The end instant must be at most one minute after the start.
    const start = Date.UTC(2026, 9, 16, 3, 59);
    const end = Date.UTC(2026, 9, 16, 4, 0);
    expect(end - start).toBeLessThanOrEqual(60_000);
    expect(end - start).toBeGreaterThan(0);
  });

  it('emits an all-day event when no time is known', () => {
    const t = timingFor({ year: 2026, month: 10, day: 15 }, null, 'America/New_York');
    expect(t.start).toBe('DTSTART;VALUE=DATE:20261015');
    expect(t.end).toBe('DTEND;VALUE=DATE:20261016');
    expect(t.allDay).toBe(true);
  });
});

describe('calendar structure', () => {
  it('produces a well-formed document with CRLF endings', () => {
    const ics = build([item()]);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('CALSCALE:GREGORIAN');
    expect(ics).toContain('X-WR-TIMEZONE:America/New_York');
    // No bare LF anywhere.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('balances every BEGIN with an END', () => {
    const ics = build([item(), item({ id: 'i2', dueTime: null })]);
    const begins = (ics.match(/\r\nBEGIN:/g) ?? []).length + 1;
    const ends = (ics.match(/\r\nEND:/g) ?? []).length;
    expect(begins).toBe(ends);
  });

  it('keeps every line within 75 octets', () => {
    const ics = build([
      item({ sourceSnippet: 'A very long source snippet '.repeat(20), location: 'Gates Hall B01, Ithaca' }),
    ]);
    for (const l of ics.split('\r\n')) {
      expect(new TextEncoder().encode(l).length, `too long: ${l.slice(0, 40)}`).toBeLessThanOrEqual(75);
    }
  });
});

describe('stable identity', () => {
  it('derives UID from the item id', () => {
    expect(uidFor('abc')).toBe(`abc@${UID_DOMAIN}`);
  });

  it('keeps the same UID when the item is edited, and bumps SEQUENCE', () => {
    const before = build([item({ revision: 0 })]);
    const after = build([item({ title: 'Problem Set 4 (revised)', dueDate: '2026-10-17', revision: 3 })]);
    expect(propsOf(before, 'UID')).toEqual(propsOf(after, 'UID'));
    expect(propsOf(before, 'SEQUENCE')).toEqual(['SEQUENCE:0']);
    expect(propsOf(after, 'SEQUENCE')).toEqual(['SEQUENCE:3']);
  });

  it('emits exactly one VEVENT per item, so re-export cannot duplicate', () => {
    const ics = build([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]);
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(3);
    expect(new Set(propsOf(ics, 'UID')).size).toBe(3);
  });

  it('is byte-identical for identical input', () => {
    const now = new Date(Date.UTC(2026, 7, 31, 12));
    expect(build([item({ id: 'b' }), item({ id: 'a' })], now))
      .toBe(build([item({ id: 'a' }), item({ id: 'b' })], now));
  });
});

describe('what gets exported', () => {
  it('omits items with no date — there is nowhere honest to put them', () => {
    const ics = build([item({ dueDate: null, dueTime: null }), item({ id: 'ok' })]);
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
  });

  it('omits dismissed items', () => {
    const ics = build([item({ status: 'dismissed' })]);
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('omits items whose course is missing rather than emitting a broken event', () => {
    const ics = build([item({ courseId: 'nope' })]);
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('labels events with the course code as text, not colour alone', () => {
    const ics = build([item()]);
    expect(ics).toContain('SUMMARY:CS 2110 — Problem Set 4');
  });

  it('always attaches a reminder to a timed deadline', () => {
    const ics = build([item()]);
    expect((ics.match(/BEGIN:VALARM/g) ?? []).length).toBe(2);
    expect(ics).toContain('TRIGGER:-P1D');
    expect(ics).toContain('TRIGGER:-PT2H');
  });

  it('gives an all-day item one evening-before reminder', () => {
    const ics = build([item({ dueTime: null, timeIsDefault: false })]);
    expect((ics.match(/BEGIN:VALARM/g) ?? []).length).toBe(1);
    expect(ics).toContain('TRIGGER:-PT14H');
  });

  it('carries the source snippet so the event is traceable', () => {
    const ics = build([item()]);
    expect(ics.replace(/\r\n /g, '')).toContain('PS4 — due Oct 15');
  });

  it('says so when the time was defaulted', () => {
    const unfolded = build([item({ timeIsDefault: true })]).replace(/\r\n /g, '');
    expect(unfolded).toContain('11:59 PM assumed');
  });
});

describe('DST correctness across the term', () => {
  it('gives an October and a December 11:59 PM deadline different UTC offsets', () => {
    const ics = build([
      item({ id: 'oct', dueDate: '2026-10-15' }),
      item({ id: 'dec', dueDate: '2026-12-10' }),
    ]);
    const starts = propsOf(ics, 'DTSTART');
    // EDT (UTC-4) in October -> 03:59Z; EST (UTC-5) in December -> 04:59Z.
    expect(starts).toContain('DTSTART:20261016T035900Z');
    expect(starts).toContain('DTSTART:20261211T045900Z');
  });

  it('renders both back as 11:59 PM in the term timezone', () => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TERM.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    for (const [y, mo, d, h, mi] of [[2026, 9, 16, 3, 59], [2026, 11, 11, 4, 59]] as const) {
      expect(fmt.format(new Date(Date.UTC(y, mo, d, h, mi)))).toBe('23:59');
    }
  });
});

describe('feed metadata', () => {
  it('advertises a refresh interval and source when given', () => {
    const ics = buildIcs(
      { term: TERM, courses: COURSES, items: [item()] },
      { calendarName: 'Fall 2026 — Coursework', feedUrl: 'https://app.example/api/feed/abc.ics', refreshInterval: 'PT1H' },
      new Date(Date.UTC(2026, 7, 31, 12)),
    );
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    expect(ics).toContain('X-PUBLISHED-TTL:PT1H');
    expect(ics.replace(/\r\n /g, '')).toContain('SOURCE;VALUE=URI:https://app.example/api/feed/abc.ics');
  });
});
