import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = join(here, 'cases');

export interface ExpectedItem {
  title: string;
  type?: string;
  course: string;
  dueDate?: string;
  dueTime?: string;
  timeIsDefault?: boolean;
  weight?: number;
}

export interface FixtureExpectation {
  name: string;
  notes: string;
  context: {
    termName: string | null;
    termStart: string | null;
    termEnd: string | null;
    meetingDays: number[];
    courseHint: string | null;
  };
  expectedItems: ExpectedItem[];
  /** Items that must come back with NO date. Inventing one here is a hard fail. */
  expectedDatelessItems?: { title: string; course: string }[];
  /** Extra items this document may legitimately yield; excluded from precision. */
  allowedExtraTitles?: string[];
  /** Substrings that must never appear as an item title. */
  mustNotExtract?: string[];
  minRecall: number;
  minPrecision: number;
}

export interface Fixture {
  id: string;
  filename: string;
  path: string;
  mimeType: string;
  bytes: Uint8Array;
  expectation: FixtureExpectation;
}

const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function loadFixtures(): Fixture[] {
  const files = readdirSync(CASES_DIR).filter((f) => !f.endsWith('.expected.json')).sort();
  return files.map((filename) => {
    const id = filename.replace(/\.[^.]+$/, '');
    const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    const expectationPath = join(CASES_DIR, `${id}.expected.json`);
    const expectation = JSON.parse(readFileSync(expectationPath, 'utf8')) as FixtureExpectation;
    return {
      id,
      filename,
      path: join(CASES_DIR, filename),
      mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream',
      bytes: new Uint8Array(readFileSync(join(CASES_DIR, filename))),
      expectation,
    };
  });
}
