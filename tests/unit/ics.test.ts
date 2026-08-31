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
    dueDate: '2026-10-15', dueTime: null,
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
  // Asserted by character code, not by string literal. The first version of
  // this test wrote the expectation as '\;', which JavaScript collapses to a
  // bare ';' — so it agreed with an implementation that was not escaping
  // semicolons at all. Codes cannot be fooled that way.
  const BACKSLASH = String.fromCharCode(92);

  it('escapes a semicolon as backslash-semicolon', () => {
    const out = escapeText('Gates B01; Statler');
    expect(out).toBe(`Gates B01${BACKSLASH}; Statler`);
    expect(out.charCodeAt(9)).toBe(92);
    expect(out).toHaveLength('Gates B01; Statler'.length + 1);
  });

  it('escapes a comma as backslash-comma', () => {
    expect(escapeText('a,b')).toBe(`a${BACKSLASH},b`);
  });

  it('escapes a backslash by doubling it', () => {
    expect(escapeText(`a${BACKSLASH}b`)).toBe(`a${BACKSLASH}${BACKSLASH}b`);
  });

  it('escapes backslashes first, so later escapes are not double-escaped', () => {
    // Input: a \ b ; c  ->  a \\ b \; c
    const out = escapeText(`a${BACKSLASH}b;c`);
    expect(out).toBe(`a${BACKSLASH}${BACKSLASH}b${BACKSLASH};c`);
  });

  it('escapes newlines as literal backslash-n', () => {
    expect(escapeText('line1\nline2')).toBe(`line1${BACKSLASH}nline2`);
    expect(escapeText('a\r\nb')).toBe(`a${BACKSLASH}nb`);
    expect(escapeText('a\rb')).toBe(`a${BACKSLASH}nb`);
  });

  it('leaves a colon alone — only DQUOTE contexts need it escaped', () => {
    expect(escapeText('Due 5:00 PM')).toBe('Due 5:00 PM');
  });

  it('escapes everything at once', () => {
    const out = escapeText(`Lab; part 2, "notes"${BACKSLASH}x\nnext`);
    expect(out).toBe(`Lab${BACKSLASH}; part 2${BACKSLASH}, "notes"${BACKSLASH}${BACKSLASH}x${BACKSLASH}nnext`);
  });
});

describe('escaping survives a round trip through the calendar', () => {
  const BACKSLASH = String.fromCharCode(92);

  it('emits escaped specials in SUMMARY and LOCATION', () => {
    const ics = build([
      item({ title: 'Lab; part 2, final', location: 'Gates B01; Statler' }),
    ]);
    const unfolded = ics.replace(/\r\n[ \t]/g, '');
    expect(unfolded).toContain(`SUMMARY:CS 2110 — Lab${BACKSLASH}; part 2${BACKSLASH}, final`);
    expect(unfolded).toContain(`LOCATION:Gates B01${BACKSLASH}; Statler`);
  });

  it('never emits a bare semicolon or comma inside a TEXT value', () => {
    const ics = build([item({ title: 'A; B, C', location: 'X; Y', sourceSnippet: 'row; cell, cell' })]);
    const unfolded = ics.replace(/\r\n[ \t]/g, '');
    for (const line of unfolded.split('\r\n')) {
      const [name, ...rest] = line.split(':');
      if (!['SUMMARY', 'LOCATION', 'DESCRIPTION', 'CATEGORIES'].includes(name ?? '')) continue;
      const value = rest.join(':');
      // Every ; and , in the value must be preceded by a backslash.
      for (let i = 0; i < value.length; i += 1) {
        if (value[i] === ';' || value[i] === ',') {
          expect(value.charCodeAt(i - 1), `unescaped ${value[i]} in ${name}`).toBe(92);
        }
      }
    }
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

  it('always attaches reminders to a timed deadline', () => {
    const ics = build([item({ dueTime: '17:00' })]);
    expect((ics.match(/BEGIN:VALARM/g) ?? []).length).toBe(2);
    expect(ics).toContain('TRIGGER:-P1D');
    expect(ics).toContain('TRIGGER:-PT2H');
  });

  it('offsets an all-day reminder into waking hours', () => {
    const ics = build([item({ dueTime: null })]);
    expect((ics.match(/BEGIN:VALARM/g) ?? []).length).toBe(2);
    // An all-day event starts at local midnight, so -P1D would fire at
    // midnight. -PT14H is 10:00 the previous morning; PT9H is 09:00 on the day.
    expect(ics).toContain('TRIGGER:-PT14H');
    expect(ics).toContain('TRIGGER:PT9H');
    expect(ics).not.toContain('TRIGGER:-P1D');
  });

  it('carries the source snippet so the event is traceable', () => {
    const ics = build([item()]);
    expect(ics.replace(/\r\n /g, '')).toContain('PS4 — due Oct 15');
  });

  it('says plainly that an all-day item had no stated time', () => {
    const unfolded = build([item({ dueTime: null })]).replace(/\r\n /g, '');
    expect(unfolded).toContain('did not give a time');
    expect(unfolded).not.toContain('11:59 PM');
  });
});

describe('a day-level deadline stays on its day, everywhere', () => {
  // This is the reason all-day is the default. A 23:59 timed event is one
  // minute from midnight: rendered in any zone east of the term's, it lands on
  // the following date. An all-day event is a floating date and cannot.
  it('emits a floating DATE, not an instant', () => {
    const ics = build([item({ dueDate: '2026-10-15', dueTime: null })]);
    expect(propsOf(ics, 'DTSTART')).toEqual(['DTSTART;VALUE=DATE:20261015']);
    // DTEND is exclusive, so a one-day event ends on the 16th.
    expect(propsOf(ics, 'DTEND')).toEqual(['DTEND;VALUE=DATE:20261016']);
    expect(ics).not.toContain('T235900Z');
  });

  it('reads as the same calendar day in every timezone', () => {
    const ics = build([item({ dueDate: '2026-10-15', dueTime: null })]);
    const stamp = propsOf(ics, 'DTSTART')[0]!.split(':')[1]!;
    expect(stamp).toBe('20261015');
    // A floating date carries no offset at all, so there is nothing for a
    // client in Auckland or Los Angeles to shift.
    expect(stamp).not.toMatch(/[TZ]/);
  });

  it('would have drifted to the 16th as a 23:59 timed event', () => {
    // Demonstrates the failure the default avoids: the same deadline as a
    // timed 23:59 event in New York is already the 16th in UTC.
    const timed = build([item({ dueDate: '2026-10-15', dueTime: '23:59' })]);
    expect(propsOf(timed, 'DTSTART')).toEqual(['DTSTART:20261016T035900Z']);
  });
});

describe('DST correctness for times the syllabus actually stated', () => {
  it('gives an October and a December 7:30 PM exam different UTC offsets', () => {
    const ics = build([
      item({ id: 'oct', dueDate: '2026-10-15', dueTime: '19:30', type: 'exam' }),
      item({ id: 'dec', dueDate: '2026-12-10', dueTime: '19:30', type: 'exam' }),
    ]);
    const starts = propsOf(ics, 'DTSTART');
    // EDT (UTC-4) in October -> 23:30Z; EST (UTC-5) in December -> 00:30Z next day.
    expect(starts).toContain('DTSTART:20261015T233000Z');
    expect(starts).toContain('DTSTART:20261211T003000Z');
  });

  it('renders both back as 7:30 PM in the term timezone', () => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TERM.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    for (const [y, mo, d, h, mi] of [[2026, 9, 15, 23, 30], [2026, 11, 11, 0, 30]] as const) {
      expect(fmt.format(new Date(Date.UTC(y, mo, d, h, mi)))).toBe('19:30');
    }
  });

  it('still clamps a stated 11:59 PM so it does not spill into the next day', () => {
    const ics = build([item({ dueDate: '2026-10-15', dueTime: '23:59' })]);
    expect(propsOf(ics, 'DTEND')).toEqual(['DTEND:20261016T040000Z']);
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
