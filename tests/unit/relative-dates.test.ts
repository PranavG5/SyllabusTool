import { describe, it, expect } from 'vitest';
import { resolveRelativeDate, parseMeetingDays, type RelativeReference, type RelativeContext } from '@/lib/schedule/relative-dates';
import { formatISODate } from '@/lib/datetime';

// Fall 2026 term: classes begin Monday 2026-08-24, end Friday 2026-12-11.
const FALL: RelativeContext = {
  termStart: { year: 2026, month: 8, day: 24 },
  termEnd: { year: 2026, month: 12, day: 11 },
  meetingDays: [1, 3, 5], // MWF
};

function ref(partial: Partial<RelativeReference>): RelativeReference {
  return { kind: 'week_weekday', week: null, weekday: null, meetingIndex: null, raw: '', ...partial };
}

function iso(r: ReturnType<typeof resolveRelativeDate>): string {
  if (!r.resolved) throw new Error(`expected resolved, got: ${r.reason}`);
  return formatISODate(r.date);
}

describe('week + weekday references', () => {
  it('resolves "Week 1, Monday" to the term start when the term starts on a Monday', () => {
    expect(iso(resolveRelativeDate(ref({ week: 1, weekday: 'monday' }), FALL))).toBe('2026-08-24');
  });

  it('resolves "Week 3, Thursday"', () => {
    // Week 1 Monday = Aug 24; week 3 Monday = Sep 7; Thursday = Sep 10.
    expect(iso(resolveRelativeDate(ref({ week: 3, weekday: 'thursday' }), FALL))).toBe('2026-09-10');
  });

  it('resolves a Sunday to the end of the academic week, not the start', () => {
    // Week 2 runs Mon Aug 31 - Sun Sep 6.
    expect(iso(resolveRelativeDate(ref({ week: 2, weekday: 'sunday' }), FALL))).toBe('2026-09-06');
  });

  it('handles a term that starts mid-week', () => {
    // Classes begin Wednesday 2026-09-02, so week 1 is the Mon Aug 31 week.
    const ctx: RelativeContext = { ...FALL, termStart: { year: 2026, month: 9, day: 2 }, meetingDays: [2, 4] };
    expect(iso(resolveRelativeDate(ref({ week: 1, weekday: 'friday' }), ctx))).toBe('2026-09-04');
    expect(iso(resolveRelativeDate(ref({ week: 4, weekday: 'wednesday' }), ctx))).toBe('2026-09-23');
  });

  it('flags but still resolves a week-1 day that precedes the term start', () => {
    const ctx: RelativeContext = { ...FALL, termStart: { year: 2026, month: 9, day: 2 } };
    const r = resolveRelativeDate(ref({ week: 1, weekday: 'monday' }), ctx);
    expect(r.resolved).toBe(true);
    if (r.resolved) {
      expect(formatISODate(r.date)).toBe('2026-08-31');
      expect(r.downgrade).toBe(true);
    }
  });
});

describe('meeting-based references', () => {
  it('resolves "the second class of week 5" against MWF', () => {
    // Week 5 Monday = Sep 21; second meeting = Wednesday Sep 23.
    expect(iso(resolveRelativeDate(ref({ kind: 'week_meeting', week: 5, meetingIndex: 2 }), FALL)))
      .toBe('2026-09-23');
  });

  it('resolves the nth class meeting of the term', () => {
    // MWF from Mon Aug 24: 1=Aug24, 2=Aug26, 3=Aug28, 4=Aug31, 5=Sep2.
    expect(iso(resolveRelativeDate(ref({ kind: 'nth_meeting', meetingIndex: 5 }), FALL))).toBe('2026-09-02');
  });

  it('refuses a meeting index the course does not have', () => {
    const r = resolveRelativeDate(ref({ kind: 'week_meeting', week: 2, meetingIndex: 4 }), FALL);
    expect(r.resolved).toBe(false);
  });

  it('refuses meeting references when meeting days are unknown', () => {
    const ctx: RelativeContext = { ...FALL, meetingDays: [] };
    const r = resolveRelativeDate(ref({ kind: 'week_meeting', week: 2, meetingIndex: 1 }), ctx);
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toMatch(/days this class meets/i);
  });
});

describe('refusing to guess', () => {
  it('returns unresolved for "the class after spring break"', () => {
    const r = resolveRelativeDate(ref({ kind: 'unresolvable', raw: 'the class after spring break' }), FALL);
    expect(r.resolved).toBe(false);
  });

  it('returns unresolved when the term start date is unknown', () => {
    const ctx: RelativeContext = { ...FALL, termStart: null };
    const r = resolveRelativeDate(ref({ week: 3, weekday: 'thursday' }), ctx);
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toMatch(/term start date/i);
  });

  it('rejects a week number far outside the term', () => {
    const r = resolveRelativeDate(ref({ week: 28, weekday: 'monday' }), FALL);
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toMatch(/past the end of the term/i);
  });

  it('rejects a week number outside the allowed range outright', () => {
    expect(resolveRelativeDate(ref({ week: 99, weekday: 'monday' }), FALL).resolved).toBe(false);
  });
});

describe('parseMeetingDays', () => {
  it('parses compact US codes', () => {
    expect(parseMeetingDays('MWF')).toEqual([1, 3, 5]);
    expect(parseMeetingDays('TR')).toEqual([2, 4]);
    expect(parseMeetingDays('MTWRF')).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses long and abbreviated day names', () => {
    expect(parseMeetingDays('Tuesday and Thursday')).toEqual([2, 4]);
    expect(parseMeetingDays('Mon/Wed')).toEqual([1, 3]);
    expect(parseMeetingDays('Tues, Thurs')).toEqual([2, 4]);
  });

  it('returns nothing it cannot understand', () => {
    expect(parseMeetingDays('')).toEqual([]);
    expect(parseMeetingDays('online, async')).toEqual([]);
  });
});
