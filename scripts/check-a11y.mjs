#!/usr/bin/env node
/**
 * Accessibility checks that would otherwise be a claim rather than a fact:
 *
 *   1. Every form control has an accessible name.
 *   2. Every button and link has an accessible name.
 *   3. Every image has alt text.
 *   4. Text contrast meets WCAG AA (4.5:1 normal, 3:1 large).
 *   5. Every interactive element is reachable by keyboard.
 *   6. Headings do not skip levels.
 *
 * Drives Chromium over the DevTools Protocol with Node's built-in WebSocket,
 * so it adds no dependency to the project.
 *
 *   node scripts/check-a11y.mjs http://localhost:3100 / /login /privacy
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_PATH ??
  ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']
    .find((p) => existsSync(p));
if (!CHROME) throw new Error('No Chromium found; set CHROME_PATH.');

const base = process.argv[2] ?? 'http://localhost:3100';
const paths = process.argv.slice(3);
if (paths.length === 0) paths.push('/');

const port = 9800 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'a11y-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const body = await res.json();
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Chromium did not expose a debugging endpoint.');
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let msgId = 0;
const pending = new Map();
let sessionId = null;
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  const p = pending.get(msg.id);
  if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
});
const send = (method, params = {}, useSession = true) => {
  const id = ++msgId;
  const payload = { id, method, params };
  if (useSession && sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, false));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

const AUDIT = String.raw`(() => {
  const problems = [];

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      if (text) return text;
    }
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label?.textContent?.trim()) return label.textContent.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
    if (el.tagName === 'BUTTON' || el.tagName === 'A') {
      const text = (el.textContent ?? '').trim();
      if (text) return text;
      const t = el.getAttribute('title');
      if (t) return t;
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return '(placeholder only) ' + placeholder;
    return '';
  };

  const describe = (el) =>
    el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') +
    (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '');

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  // 1 + 2: accessible names.
  for (const el of document.querySelectorAll('input, select, textarea, button, a[href]')) {
    if (el.type === 'hidden') continue;
    if (!visible(el) && !el.closest('.sr-only')) continue;
    const name = accessibleName(el);
    if (!name) problems.push({ rule: 'name', el: describe(el), detail: 'no accessible name' });
    else if (name.startsWith('(placeholder only)')) {
      problems.push({ rule: 'name', el: describe(el), detail: 'labelled only by placeholder' });
    }
  }

  // 3: images.
  for (const img of document.querySelectorAll('img')) {
    if (img.getAttribute('alt') === null) problems.push({ rule: 'alt', el: describe(img), detail: 'no alt attribute' });
  }

  // 4: contrast.
  const parseColor = (value) => {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((n) => parseFloat(n));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = ({ r, g, b }) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const effectiveBackground = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0.5) return bg;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 && n.textContent.trim())
      .map((n) => n.textContent.trim()).join(' ');
    if (!ownText) continue;

    const style = getComputedStyle(el);
    const fg = parseColor(style.color);
    if (!fg || fg.a < 0.5) continue;
    const bg = effectiveBackground(el);
    const l1 = luminance(fg), l2 = luminance(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    const size = parseFloat(style.fontSize);
    const weight = parseInt(style.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? 3 : 4.5;

    if (ratio < required) {
      problems.push({
        rule: 'contrast', el: describe(el),
        detail: ratio.toFixed(2) + ':1 (needs ' + required + ':1) "' + ownText.slice(0, 40) + '"',
      });
    }
  }

  // 5: keyboard reachability.
  for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')) {
    if (!visible(el)) continue;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && parseInt(tabindex, 10) < 0 && !el.disabled) {
      problems.push({ rule: 'keyboard', el: describe(el), detail: 'removed from tab order' });
    }
  }
  for (const el of document.querySelectorAll('[onclick]')) {
    const t = el.tagName;
    if (t !== 'BUTTON' && t !== 'A' && t !== 'INPUT' && !el.hasAttribute('tabindex')) {
      problems.push({ rule: 'keyboard', el: describe(el), detail: 'click handler on a non-focusable element' });
    }
  }

  // 6: heading order.
  const levels = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .filter(visible).map((h) => Number(h.tagName[1]));
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] > levels[i - 1] + 1) {
      problems.push({ rule: 'headings', el: 'h' + levels[i], detail: 'jumps from h' + levels[i - 1] });
    }
  }
  if (document.querySelectorAll('h1').length !== 1) {
    problems.push({ rule: 'headings', el: 'document', detail: document.querySelectorAll('h1').length + ' h1 elements (expected 1)' });
  }
  if (!document.documentElement.getAttribute('lang')) {
    problems.push({ rule: 'lang', el: 'html', detail: 'no lang attribute' });
  }

  return problems;
})()`;

let total = 0;
for (const path of paths) {
  await send('Page.navigate', { url: `${base}${path}` });
  await new Promise((resolve) => {
    const onMessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === 'Page.loadEventFired') { ws.removeEventListener('message', onMessage); resolve(); }
    };
    ws.addEventListener('message', onMessage);
    setTimeout(() => { ws.removeEventListener('message', onMessage); resolve(); }, 15000);
  });
  await new Promise((r) => setTimeout(r, 400));

  const { result } = await send('Runtime.evaluate', { expression: AUDIT, returnByValue: true });
  const problems = result.value ?? [];
  total += problems.length;
  console.log(`${path.padEnd(12)} ${problems.length === 0 ? 'clean' : `${problems.length} problem(s)`}`);
  for (const p of problems) console.log(`   [${p.rule}] ${p.el}: ${p.detail}`);
}

ws.close();
chrome.kill();

if (total > 0) { console.error(`\n${total} accessibility problem(s).`); process.exit(1); }
console.log('\nNo accessibility problems found.');
