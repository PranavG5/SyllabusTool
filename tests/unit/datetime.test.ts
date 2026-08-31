import { describe, it, expect } from 'vitest';
import {
  parseISODate, formatISODate, addDays, diffDays, dayOfWeek, parseWallTime,
  zonedWallTimeToUtc, zoneOffsetMs, toIcsUtcStamp, toIcsDateStamp,
  startOfWeekMonday, isValidTimeZone, todayIn, DEFAULT_DUE_TIME,
} from '@/lib/datetime';

describe('civil date parsing', () => {
  it('accepts well-formed ISO dates', () => {
    expect(parseISODate('2026-10-15')).toEqual({ year: 2026, month: 10, day: 15 });
  });

  it('rejects dates that do not exist', () => {
    expect(parseISODate('2026-02-30')).toBeNull();
    expect(parseISODate('2025-02-29')).toBeNull();
    expect(parseISODate('2026-13-01')).toBeNull();
    expect(parseISODate('10/15/2026')).toBeNull();
    expect(parseISODate('')).toBeNull();
  });

  it('accepts a real leap day', () => {
    expect(parseISODate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
  });

  it('round-trips', () => {
    expect(formatISODate({ year: 2026, month: 1, day: 5 })).toBe('2026-01-05');
  });
});

describe('calendar arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(addDays({ year: 2026, month: 1, day: 30 }, 3)).toEqual({ year: 2026, month: 2, day: 2 });
  });

  it('adds days across a year boundary', () => {
    expect(addDays({ year: 2026, month: 12, day: 30 }, 5)).toEqual({ year: 2027, month: 1, day: 4 });
  });

  it('subtracts days', () => {
    expect(addDays({ year: 2026, month: 3, day: 2 }, -3)).toEqual({ year: 2026, month: 2, day: 27 });
  });

  it('measures day differences', () => {
    expect(diffDays({ year: 2026, month: 9, day: 8 }, { year: 2026, month: 9, day: 1 })).toBe(7);
  });

  it('reports the weekday', () => {
    // 2026-08-31 is a Monday.
    expect(dayOfWeek({ year: 2026, month: 8, day: 31 })).toBe(1);
    expect(dayOfWeek({ year: 2026, month: 9, day: 6 })).toBe(0);
  });

  it('finds the Monday of the containing week, including from a Sunday', () => {
    expect(startOfWeekMonday({ year: 2026, month: 9, day: 3 }))
      .toEqual({ year: 2026, month: 8, day: 31 });
    expect(startOfWeekMonday({ year: 2026, month: 9, day: 6 }))
      .toEqual({ year: 2026, month: 8, day: 31 });
    expect(startOfWeekMonday({ year: 2026, month: 8, day: 31 }))
      .toEqual({ year: 2026, month: 8, day: 31 });
  });
});

describe('wall time parsing', () => {
  it('parses 24-hour times', () => {
    expect(parseWallTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseWallTime('9:05')).toEqual({ hour: 9, minute: 5 });
  });

  it('rejects impossible times', () => {
    expect(parseWallTime('24:00')).toBeNull();
    expect(parseWallTime('12:60')).toBeNull();
    expect(parseWallTime('noon')).toBeNull();
  });
});

describe('timezone conversion', () => {
  it('validates IANA zone names', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });

  it('reports the correct offset either side of US DST', () => {
    // 2026-07-01 12:00Z -> EDT (UTC-4); 2026-01-01 12:00Z -> EST (UTC-5)
    expect(zoneOffsetMs(Date.UTC(2026, 6, 1, 12), 'America/New_York')).toBe(-4 * 3600_000);
    expect(zoneOffsetMs(Date.UTC(2026, 0, 1, 12), 'America/New_York')).toBe(-5 * 3600_000);
  });

  // The whole point of storing an IANA zone: 11:59 PM must stay 11:59 PM.
  it('keeps an 11:59 PM deadline at 11:59 PM across the DST boundary', () => {
    const tz = 'America/New_York';
    // US DST 2026: begins Mar 8, ends Nov 1.
    const beforeSpring = zonedWallTimeToUtc({ year: 2026, month: 3, day: 6 }, { hour: 23, minute: 59 }, tz);
    const afterSpring  = zonedWallTimeToUtc({ year: 2026, month: 3, day: 10 }, { hour: 23, minute: 59 }, tz);
    const beforeFall   = zonedWallTimeToUtc({ year: 2026, month: 10, day: 30 }, { hour: 23, minute: 59 }, tz);
    const afterFall    = zonedWallTimeToUtc({ year: 2026, month: 11, day: 3 }, { hour: 23, minute: 59 }, tz);

    // EST is UTC-5 -> 04:59Z next day; EDT is UTC-4 -> 03:59Z next day.
    expect(toIcsUtcStamp(beforeSpring)).toBe('20260307T045900Z');
    expect(toIcsUtcStamp(afterSpring)).toBe('20260311T035900Z');
    expect(toIcsUtcStamp(beforeFall)).toBe('20261031T035900Z');
    expect(toIcsUtcStamp(afterFall)).toBe('20261104T045900Z');

    // Rendered back in the term's zone, every one of them reads 23:59.
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    for (const d of [beforeSpring, afterSpring, beforeFall, afterFall]) {
      expect(fmt.format(d)).toBe('23:59');
    }
  });

  it('handles the spring-forward gap deterministically', () => {
    // 2026-03-08 02:30 does not exist in America/New_York.
    const d = zonedWallTimeToUtc({ year: 2026, month: 3, day: 8 }, { hour: 2, minute: 30 }, 'America/New_York');
    expect(toIcsUtcStamp(d)).toBe('20260308T063000Z'); // == 03:30 EDT
  });

  it('handles the fall-back overlap deterministically', () => {
    // 2026-11-01 01:30 happens twice; we take the first (EDT) occurrence.
    const d = zonedWallTimeToUtc({ year: 2026, month: 11, day: 1 }, { hour: 1, minute: 30 }, 'America/New_York');
    expect(toIcsUtcStamp(d)).toBe('20261101T053000Z');
  });

  it('works for southern-hemisphere zones where DST runs the other way', () => {
    const tz = 'Australia/Sydney';
    const jan = zonedWallTimeToUtc({ year: 2026, month: 1, day: 15 }, { hour: 23, minute: 59 }, tz);
    const jul = zonedWallTimeToUtc({ year: 2026, month: 7, day: 15 }, { hour: 23, minute: 59 }, tz);
    expect(toIcsUtcStamp(jan)).toBe('20260115T125900Z'); // AEDT = UTC+11
    expect(toIcsUtcStamp(jul)).toBe('20260715T135900Z'); // AEST = UTC+10
  });

  it('works for a half-hour-offset zone', () => {
    const d = zonedWallTimeToUtc({ year: 2026, month: 6, day: 1 }, { hour: 23, minute: 59 }, 'Asia/Kolkata');
    expect(toIcsUtcStamp(d)).toBe('20260601T182900Z'); // UTC+5:30
  });

  it('works for UTC itself', () => {
    const d = zonedWallTimeToUtc({ year: 2026, month: 6, day: 1 }, { hour: 23, minute: 59 }, 'UTC');
    expect(toIcsUtcStamp(d)).toBe('20260601T235900Z');
  });
});

describe('ics stamps', () => {
  it('formats an all-day date', () => {
    expect(toIcsDateStamp({ year: 2026, month: 10, day: 5 })).toBe('20261005');
  });
});

describe('todayIn', () => {
  it('reports the civil date in the requested zone', () => {
    // 2026-01-01 03:00Z is still 2025-12-31 in New York.
    const now = new Date(Date.UTC(2026, 0, 1, 3, 0, 0));
    expect(todayIn('America/New_York', now)).toEqual({ year: 2025, month: 12, day: 31 });
    expect(todayIn('UTC', now)).toEqual({ year: 2026, month: 1, day: 1 });
  });
});

describe('defaults', () => {
  it('defaults unspecified deadlines to 11:59 PM', () => {
    expect(DEFAULT_DUE_TIME).toBe('23:59');
  });
});
