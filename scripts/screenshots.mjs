#!/usr/bin/env node
/**
 * Render the captured terminal sessions in docs/sessions/ to PNGs in docs/.
 *
 *   node scripts/screenshots.mjs            # needs Chrome on --remote-debugging-port=9222
 *
 * The .txt files are real output, pasted verbatim from a live run. This only
 * decides how they look; it never invents a line. Regenerate the text by
 * re-running the commands shown at the top of each file.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sessions = join(root, 'docs', 'sessions');
const CDP = 'http://127.0.0.1:9222';

const THEME = {
  bg: '#0d1117',
  chrome: '#161b22',
  border: '#30363d',
  text: '#c9d1d9',
  dim: '#8b949e',
  prompt: '#3fb950',
  command: '#e6edf3',
  accent: '#58a6ff',
  warn: '#d29922',
  good: '#3fb950',
};

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Colour a line by what it is, not by parsing it. Keep this list short. */
function classify(line) {
  if (line.startsWith('$ ')) return 'cmd';
  if (/^attic: /.test(line)) return 'accent';
  if (/hits the \d+-result cap|ceiling reached|^checkpointed:|^warning:|frontier at/.test(line)) return 'warn';
  if (/^backfill complete$|^wrote \d|^indexed /.test(line)) return 'good';
  if (/flake rate|^ {2}\w/.test(line)) return 'text';
  return 'dim';
}

function renderLine(line) {
  const kind = classify(line);
  if (kind === 'cmd') {
    return `<span class="prompt">$</span> <span class="cmd">${escape(line.slice(2))}</span>`;
  }
  return `<span class="${kind}">${escape(line) || '&nbsp;'}</span>`;
}

function page(title, body) {
  const lines = body.split('\n').map(renderLine).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; }
  body { padding: 24px; font-family: 'JetBrains Mono','Cascadia Code','SF Mono',Consolas,monospace; }
  .window { width: 1000px; border-radius: 10px; overflow: hidden; border: 1px solid ${THEME.border};
            box-shadow: 0 12px 34px rgba(0,0,0,.45); background: ${THEME.bg}; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: ${THEME.chrome};
         border-bottom: 1px solid ${THEME.border}; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .title { flex: 1; text-align: center; color: ${THEME.dim}; font-size: 12px; letter-spacing: .3px;
           margin-right: 46px; }
  pre { margin: 0; padding: 20px 22px; font-size: 13.5px; line-height: 1.62; color: ${THEME.text};
        white-space: pre-wrap; word-break: break-word; }
  .prompt { color: ${THEME.prompt}; font-weight: 700; }
  .cmd    { color: ${THEME.command}; font-weight: 600; }
  .accent { color: ${THEME.accent}; }
  .warn   { color: ${THEME.warn}; }
  .good   { color: ${THEME.good}; }
  .text   { color: ${THEME.text}; }
  .dim    { color: ${THEME.dim}; }
  </style></head><body>
  <div class="window">
    <div class="bar">
      <span class="dot" style="background:#ff5f57"></span>
      <span class="dot" style="background:#febc2e"></span>
      <span class="dot" style="background:#28c840"></span>
      <span class="title">${escape(title)}</span>
    </div>
    <pre>${lines}</pre>
  </div></body></html>`;
}

async function rpc(ws, method, params, id) {
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    setTimeout(() => reject(new Error(`${method} timed out`)), 20_000);
  });
}

async function shoot(html, out) {
  const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  try {
    await rpc(ws, 'Emulation.setDeviceMetricsOverride',
      { width: 1060, height: 400, deviceScaleFactor: 2, mobile: false }, ++id);
    await rpc(ws, 'Emulation.setDefaultBackgroundColorOverride',
      { color: { r: 0, g: 0, b: 0, a: 0 } }, ++id);
    await rpc(ws, 'Page.navigate',
      { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` }, ++id);
    await new Promise((r) => setTimeout(r, 900));
    const box = await rpc(ws, 'Runtime.evaluate', {
      expression: 'JSON.stringify({w: Math.ceil(document.body.scrollWidth), h: Math.ceil(document.body.scrollHeight)})',
      returnByValue: true,
    }, ++id);
    const { w, h } = JSON.parse(box.result.value);
    const shot = await rpc(ws, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: w, height: h, scale: 2 },
    }, ++id);
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    return { w, h };
  } finally {
    ws.close();
    await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
  }
}

/** GitHub's job-summary panel, close enough to recognise at a glance. */
function summaryPage(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  body { padding: 24px; font-family: -apple-system,'Segoe UI',Helvetica,Arial,sans-serif; }
  .panel { width: 820px; background: ${THEME.bg}; color: ${THEME.text}; border: 1px solid ${THEME.border};
           border-radius: 10px; padding: 8px 26px 22px; box-shadow: 0 12px 34px rgba(0,0,0,.45); }
  h3 { font-size: 18px; margin: 20px 0 12px; color: #e6edf3; }
  table { border-collapse: collapse; margin: 6px 0 14px; }
  th, td { border: 1px solid ${THEME.border}; padding: 6px 14px; font-size: 14px; text-align: left; }
  th { background: ${THEME.chrome}; font-weight: 600; }
  td:not(:first-child), th:not(:first-child) { text-align: right; }
  code { background: rgba(110,118,129,.4); border-radius: 6px; padding: .2em .4em; font-size: 85%;
         font-family: 'JetBrains Mono',Consolas,monospace; }
  hr { border: 0; border-top: 1px solid ${THEME.border}; margin: 22px 0 4px; }
  br { line-height: 0; }
  </style></head><body><div class="panel">${body}</div></body></html>`;
}

const files = readdirSync(sessions).filter((f) => /\.(txt|html)$/.test(f)).sort();
if (files.length === 0) throw new Error(`no session captures in ${sessions}`);

for (const file of files) {
  const raw = readFileSync(join(sessions, file), 'utf8');
  const out = join(root, 'docs', file.replace(/\.(txt|html)$/, '.png'));
  let html;
  if (file.endsWith('.html')) {
    html = summaryPage(raw);
  } else {
    const [titleLine, ...rest] = raw.split('\n');
    html = page(titleLine.replace(/^#\s*/, ''), rest.join('\n').replace(/\n+$/, ''));
  }
  const { w, h } = await shoot(html, out);
  console.log(`${out}  ${w}x${h} css px @2x`);
}
