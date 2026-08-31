#!/usr/bin/env node
/**
 * Measures horizontal overflow at a phone viewport and captures screenshots.
 *
 * Uses the DevTools Protocol directly over Node's built-in WebSocket, so it
 * needs no browser-automation dependency. Chromium's --window-size does not
 * reliably set the CSS viewport in headless mode; Emulation.setDeviceMetricsOverride
 * does, which is why this exists rather than a plain --screenshot call.
 *
 *   node scripts/check-responsive.mjs http://localhost:3100 /  /privacy
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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

const OUT_DIR = process.env.SHOT_DIR ?? '/tmp/shots';
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true, scale: 3 },
  { name: 'tablet', width: 768, height: 1024, mobile: true, scale: 2 },
  { name: 'desktop', width: 1280, height: 900, mobile: false, scale: 1 },
];

const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
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

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.sessionId = null;
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    });
  }
  send(method, params = {}, useSession = true) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (useSession && this.sessionId) payload.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const cdp = new Session(ws);

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }, false);
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, false);
cdp.sessionId = sessionId;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

const failures = [];

for (const vp of VIEWPORTS) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width, height: vp.height, deviceScaleFactor: vp.scale, mobile: vp.mobile,
  });

  for (const path of paths) {
    await cdp.send('Page.navigate', { url: `${base}${path}` });
    // Wait for the load event rather than a fixed sleep.
    await new Promise((resolve) => {
      const onMessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.method === 'Page.loadEventFired') { ws.removeEventListener('message', onMessage); resolve(); }
      };
      ws.addEventListener('message', onMessage);
      setTimeout(() => { ws.removeEventListener('message', onMessage); resolve(); }, 15000);
    });
    await new Promise((r) => setTimeout(r, 400));

    const { result } = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const de = document.documentElement;
        const overflowing = [];
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.right > de.clientWidth + 1 || r.left < -1) {
            overflowing.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.getAttribute('class') || '').slice(0, 70),
              text: (el.textContent || '').trim().slice(0, 40),
              left: Math.round(r.left), right: Math.round(r.right),
            });
          }
        }
        return {
          viewport: de.clientWidth,
          scrollWidth: de.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          overflowing: overflowing.slice(0, 6),
        };
      })()`,
    });

    const m = result.value;
    const overflows = m.scrollWidth > m.viewport + 1;
    const label = `${vp.name.padEnd(7)} ${path.padEnd(10)}`;
    console.log(
      `${label} viewport=${m.viewport} scrollWidth=${m.scrollWidth} ${overflows ? 'OVERFLOW' : 'ok'}`,
    );
    if (overflows) {
      failures.push({ viewport: vp.name, path, ...m });
      for (const o of m.overflowing) {
        console.log(`          -> <${o.tag} class="${o.cls}"> [${o.left}..${o.right}] "${o.text}"`);
      }
    }

    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const name = `${vp.name}-${(path === '/' ? 'landing' : path.replace(/\//g, '-').replace(/^-/, ''))}.png`;
    writeFileSync(join(OUT_DIR, name), Buffer.from(data, 'base64'));
  }
}

ws.close();
chrome.kill();

if (failures.length > 0) {
  console.error(`\n${failures.length} page/viewport combination(s) scroll horizontally.`);
  process.exit(1);
}
console.log('\nNo horizontal overflow at any viewport.');
