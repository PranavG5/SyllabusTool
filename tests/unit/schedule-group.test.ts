import { describe, it, expect } from 'vitest';
import { groupSchedule, monthGrid } from '@/lib/schedule/group';
import { formatISODate } from '@/lib/datetime';
import type { ScheduleItem } from '@/lib/types';

function item(p: Partial<ScheduleItem> & { id: string }): ScheduleItem {
  return {
    courseId: 'c1', termId: 't1', title: 'Thing', type: 'assignment',
    dueDate: null, dueTime: null, weight: null, location: null,
    sourceSnippet: 's', sourceUploadId: null, sourceFilename: null,
    confidence: 'high', status: 'active', revision: 0,
    ...p,
  };
}

// Wednesday 2026-09-09, 15:00 UTC -> 11:00 in New York.
const NOW = new Date(Date.UTC(2026, 8, 9, 15));
const TZ = 'America/New_York';

describe('groupSchedule', () => {
  it('pins the rest of this week at the top', () => {
    const g = groupSchedule(
      [
        item({ id: 'a', dueDate: '2026-09-09' }), // today
        item({ id: 'b', dueDate: '2026-09-11' }), // Friday, same week
        item({ id: 'c', dueDate: '2026-09-14' }), // next Monday
      ],
      TZ, NOW,
    );
    expect(g.thisWeek.map((i) => i.id)).toEqual(['a', 'b']);
    expect(g.upcoming[0]!.items.map((i) => i.id)).toEqual(['c']);
  });

  it('moves past items into completed, most recent first', () => {
    const g = groupSchedule(
      [
        item({ id: 'old', dueDate: '2026-09-01' }),
        item({ id: 'recent', dueDate: '2026-09-08' }),
      ],
      TZ, NOW,
    );
    expect(g.completed.map((i) => i.id)).toEqual(['recent', 'old']);
    expect(g.thisWeek).toHaveLength(0);
  });

  it('treats today as still upcoming, not completed', () => {
    const g = groupSchedule([item({ id: 'today', dueDate: '2026-09-09' })], TZ, NOW);
    expect(g.thisWeek.map((i) => i.id)).toEqual(['today']);
    expect(g.completed).toHaveLength(0);
  });

  it('surfaces undated items instead of dropping them', () => {
    const g = groupSchedule([item({ id: 'x', dueDate: null })], TZ, NOW);
    expect(g.undated.map((i) => i.id)).toEqual(['x']);
  });

  it('excludes dismissed items from every group', () => {
    const g = groupSchedule([item({ id: 'x', dueDate: '2026-09-11', status: 'dismissed' })], TZ, NOW);
    expect([...g.thisWeek, ...g.completed, ...g.undated].flat()).toHaveLength(0);
    expect(g.upcoming).toHaveLength(0);
  });

  it('groups later items into Monday-anchored weeks', () => {
    const g = groupSchedule(
      [
        item({ id: 'a', dueDate: '2026-09-15' }),
        item({ id: 'b', dueDate: '2026-09-20' }), // Sunday, same week as the 15th
        item({ id: 'c', dueDate: '2026-09-21' }), // next Monday
      ],
      TZ, NOW,
    );
    expect(g.upcoming).toHaveLength(2);
    expect(formatISODate(g.upcoming[0]!.start)).toBe('2026-09-14');
    expect(g.upcoming[0]!.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(g.upcoming[1]!.items.map((i) => i.id)).toEqual(['c']);
  });

  it('sorts within a day by time', () => {
    const g = groupSchedule(
      [
        item({ id: 'late', dueDate: '2026-09-11', dueTime: '23:59' }),
        item({ id: 'early', dueDate: '2026-09-11', dueTime: '09:00' }),
      ],
      TZ, NOW,
    );
    expect(g.thisWeek.map((i) => i.id)).toEqual(['early', 'late']);
  });

  it('puts all-day items first within a day, as calendars do', () => {
    const g = groupSchedule(
      [
        item({ id: 'timed', dueDate: '2026-09-11', dueTime: '09:00' }),
        item({ id: 'allday', dueDate: '2026-09-11', dueTime: null }),
      ],
      TZ, NOW,
    );
    expect(g.thisWeek.map((i) => i.id)).toEqual(['allday', 'timed']);
  });

  it('uses the term timezone to decide what "today" is', () => {
    // 2026-09-10 02:00Z is still 2026-09-09 in New York.
    const lateNight = new Date(Date.UTC(2026, 8, 10, 2));
    const ny = groupSchedule([item({ id: 'x', dueDate: '2026-09-09' })], TZ, lateNight);
    const utc = groupSchedule([item({ id: 'x', dueDate: '2026-09-09' })], 'UTC', lateNight);
    expect(ny.thisWeek).toHaveLength(1);
    expect(utc.completed).toHaveLength(1);
  });
});

describe('monthGrid', () => {
  it('returns six Monday-first weeks covering the month', () => {
    const grid = monthGrid(2026, 9);
    expect(grid).toHaveLength(6);
    expect(grid.every((w) => w.length === 7)).toBe(true);
    // September 2026 starts on a Tuesday, so the grid opens on Mon Aug 31.
    expect(formatISODate(grid[0]![0]!)).toBe('2026-08-31');
    expect(formatISODate(grid[5]![6]!)).toBe('2026-10-11');
  });

  it('handles a month starting on a Monday', () => {
    // 2026-06-01 is a Monday.
    expect(formatISODate(monthGrid(2026, 6)[0]![0]!)).toBe('2026-06-01');
  });
});
