#!/usr/bin/env node
/**
 * Regenerates the binary fixtures (a real PDF, a real screenshot) from the
 * HTML sources in ./html using headless Chromium.
 *
 * The generated files are committed, so running the test suite does not need a
 * browser. Re-run this only when you change the HTML:
 *
 *   node tests/fixtures/generate.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const hit = CANDIDATES.find((p) => existsSync(p));
  if (hit) return hit;
  const glob = CANDIDATES[0].replace('chromium-1194', 'chromium-*');
  throw new Error(`No Chromium found. Set CHROME_PATH, or install one at ${glob}.`);
}

const chrome = findChrome();
const profile = mkdtempSync(join(tmpdir(), 'fixture-chrome-'));
const base = ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${profile}`];

function run(args) {
  execFileSync(chrome, [...base, ...args], { stdio: 'pipe', timeout: 120_000 });
}

// Chromium writes --print-to-pdf / --screenshot relative to cwd in some builds,
// so generate into a temp dir and move the result into place.
const out = mkdtempSync(join(tmpdir(), 'fixture-out-'));

const pdfSrc = `file://${resolve(here, 'html/10-arch350-pdf.html')}`;
const pdfTmp = join(out, 'arch350.pdf');
run([`--print-to-pdf=${pdfTmp}`, '--no-pdf-header-footer', pdfSrc]);
renameSync(pdfTmp, join(here, 'cases/10-arch350-table.pdf'));
console.log('wrote cases/10-arch350-table.pdf');

const pngSrc = `file://${resolve(here, 'html/11-canvas-screenshot.html')}`;
const pngTmp = join(out, 'canvas.png');
run([`--screenshot=${pngTmp}`, '--window-size=1000,780', '--hide-scrollbars', pngSrc]);
renameSync(pngTmp, join(here, 'cases/11-canvas-screenshot.png'));
console.log('wrote cases/11-canvas-screenshot.png');

// The Word fixture needs no browser — it is assembled from XML parts.
const { buildDocx } = await import(`file://${resolve(here, '../../scripts/make-docx.mjs')}`);
void buildDocx;
execFileSync(process.execPath, [
  resolve(here, '../../scripts/make-docx.mjs'),
  join(here, 'cases/12-govt312-word.docx'),
], { stdio: 'inherit' });
