import 'server-only';

/** Shared shaping for the two ICS surfaces: the download and the feed. */

import { NextResponse } from 'next/server';
import { buildIcs } from './build';
import type { SchedulePayload } from '@/lib/types';
import { siteUrl } from '@/lib/http';

/** "Fall 2026 — Coursework": one thing the student can hide or delete. */
export function calendarNameFor(termName: string): string {
  return `${termName} — Coursework`;
}

export function icsFilenameFor(termName: string): string {
  const slug = termName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'coursework';
  return `${slug}-coursework.ics`;
}

export interface IcsResponseOptions {
  /** Subscribable feeds advertise a refresh interval; downloads do not. */
  feedUrl?: string;
  download?: boolean;
}

export function icsResponse(payload: SchedulePayload, options: IcsResponseOptions = {}): NextResponse {
  const body = buildIcs(payload, {
    calendarName: calendarNameFor(payload.term.name),
    feedUrl: options.feedUrl,
    appUrl: `${siteUrl()}/schedule`,
    refreshInterval: options.feedUrl ? 'PT1H' : undefined,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'text/calendar; charset=utf-8',
    // A calendar feed is a bearer-token URL; never let a proxy hold a copy.
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  };
  if (options.download) {
    headers['Content-Disposition'] = `attachment; filename="${icsFilenameFor(payload.term.name)}"`;
  }

  return new NextResponse(body, { status: 200, headers });
}
