#!/usr/bin/env node
/**
 * agent-control Web Driver — Playwright 持久浏览器
 *
 * 架构：第一次调用启动 daemon（浏览器 + HTTP server），
 * 后续调用通过 HTTP 发命令给 daemon 执行。
 *
 * Usage:
 *   agent-control-web open <url>
 *   agent-control-web snapshot -i
 *   agent-control-web click @e3
 *   agent-control-web screenshot /tmp/out.png
 *   agent-control-web close
 */

const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const STATE_FILE = '/tmp/agent-control-web.json';
const DAEMON_PORT = 3901;
const MAX_CONSOLE_ENTRIES = 500;
const consoleLogs = [];

function attachConsoleListener(pg) {
  pg.on('console', msg => {
    consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      url: msg.location()?.url || '',
      line: msg.location()?.lineNumber ?? 0,
      ts: Date.now(),
    });
    if (consoleLogs.length > MAX_CONSOLE_ENTRIES) consoleLogs.splice(0, consoleLogs.length - MAX_CONSOLE_ENTRIES);
  });
  pg.on('pageerror', err => {
    consoleLogs.push({ type: 'error', text: err.message, url: '', line: 0, ts: Date.now() });
    if (consoleLogs.length > MAX_CONSOLE_ENTRIES) consoleLogs.splice(0, consoleLogs.length - MAX_CONSOLE_ENTRIES);
  });
}

// ══════════════════════════════════════════
// CLIENT — send command to daemon via HTTP
// ══════════════════════════════════════════
async function sendToDaemon(args) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ args });
    const req = http.request({
      hostname: '127.0.0.1', port: DAEMON_PORT, path: '/cmd',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function isDaemonRunning() {
  if (!fs.existsSync(STATE_FILE)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Check if process is alive
    process.kill(state.pid, 0);
    return true;
  } catch { return false; }
}

// ══════════════════════════════════════════
// DAEMON — persistent browser + HTTP server
// ══════════════════════════════════════════
async function startDaemon(opts = {}) {
  let browser, context, page;
  if (opts.cdp) {
    // Connect to existing browser/Electron via CDP
    browser = await chromium.connectOverCDP(opts.cdp);
    context = browser.contexts()[0] || await browser.newContext();
    page = context.pages()[0] || await context.newPage();
    attachConsoleListener(page);
  } else {
    browser = await chromium.launch({
      headless: !opts.headed,
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      permissions: ['camera', 'microphone'],
    });
    page = await context.newPage();
  }
  attachConsoleListener(page);

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/cmd') {
      res.writeHead(404); res.end('not found'); return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { args } = JSON.parse(body);
        const result = await executeCommand(args, page, browser, context);
        // page might have changed (e.g. open creates new page)
        if (result._newPage) { page = result._newPage; delete result._newPage; attachConsoleListener(page); consoleLogs.length = 0; }
        if (result._newContext) { context = result._newContext; delete result._newContext; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
  });

  server.listen(DAEMON_PORT, '127.0.0.1', () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ port: DAEMON_PORT, pid: process.pid }));
  });

  const cleanup = () => {
    try { server.close(); } catch {}
    try { browser.close(); } catch {}
    try { fs.unlinkSync(STATE_FILE); } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(); });
  process.on('SIGTERM', () => { cleanup(); process.exit(); });

  return { browser, page, context, server };
}

// ══════════════════════════════════════════
// SNAPSHOT
// ══════════════════════════════════════════
async function snapshot(page, interactiveOnly) {
  return page.evaluate((interactiveOnly) => {
    // Clear old refs first
    document.querySelectorAll('[data-ac-ref]').forEach(el => el.removeAttribute('data-ac-ref'));

    const interactiveSelectors = [
      'button', 'input', 'select', 'textarea', 'a[href]',
      '[role="button"]', '[role="link"]', '[role="checkbox"]',
      '[role="radio"]', '[role="tab"]', '[role="menuitem"]',
      '[role="slider"]', '[role="switch"]', '[role="combobox"]',
      '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
      '[aria-label]', 'canvas',
    ];
    const selector = interactiveOnly ? interactiveSelectors.join(',') : 'body *';
    const els = document.querySelectorAll(selector);
    const results = [];
    let counter = 0;
    for (const el of els) {
      if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      counter++;
      const ref = `@e${counter}`;
      // Stamp ref onto DOM element for stable lookup
      el.setAttribute('data-ac-ref', ref);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || el.type || tag;
      const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 80) || '';
      const value = el.value || '';
      const name = el.getAttribute('name') || '';
      // Extra attributes useful for agent decision-making
      const placeholder = el.placeholder || '';
      const href = el.href || '';
      const type = el.type || '';
      const accept = el.accept || '';
      const disabled = el.disabled || false;
      const checked = el.checked ?? null;
      const selected = el.selected ?? null;
      const required = el.required || false;
      const readOnly = el.readOnly || false;
      const title = el.title || '';

      const entry = { ref, role, tag, label, value, name, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
      // Only include non-empty extras to keep output compact
      if (placeholder) entry.placeholder = placeholder;
      if (href) entry.href = href;
      if (type && type !== tag) entry.type = type;
      if (accept) entry.accept = accept;
      if (disabled) entry.disabled = true;
      if (checked === true) entry.checked = true;
      if (selected === true) entry.selected = true;
      if (required) entry.required = true;
      if (readOnly) entry.readOnly = true;
      if (title && title !== label) entry.title = title;
      results.push(entry);
    }
    return results;
  }, interactiveOnly);
}

async function resolveRef(page, ref) {
  // Primary: find by data-ac-ref attribute (stable, survives DOM changes)
  const found = await page.evaluate((ref) => {
    const el = document.querySelector(`[data-ac-ref="${ref}"]`);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || el.type || el.tagName.toLowerCase(),
      name: el.getAttribute('name') || '',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
    };
  }, ref);

  if (found) {
    return {
      selector: `[data-ac-ref="${ref}"]`,
      x: found.x + found.w / 2,
      y: found.y + found.h / 2,
      el: found,
    };
  }

  // Fallback: re-snapshot and find by index (for cases where DOM was rebuilt)
  const idx = parseInt(ref.replace('@e', '')) - 1;
  const els = await snapshot(page, true);
  if (idx < 0 || idx >= els.length) return null;
  const el = els[idx];
  return { selector: `[data-ac-ref="${el.ref}"]`, x: el.x + el.w / 2, y: el.y + el.h / 2, el };
}

// ══════════════════════════════════════════
// COMMAND EXECUTION
// ══════════════════════════════════════════
function parseCommands(rawArgs) {
  const groups = [[]];
  for (const a of rawArgs) {
    if (a === ';' || a === '&&') groups.push([]);
    else groups[groups.length - 1].push(a);
  }
  return groups.filter(g => g.length > 0);
}

async function executeCommand(args, page, browser, context) {
  const cmd = args[0];
  if (!cmd) return { ok: false, error: 'no command' };

  let result;
  try {
    switch (cmd) {
      case 'open': case 'goto': case 'navigate': {
        const url = args[1];
        if (!url) { result = { ok: false, error: 'no url' }; break; }
        await page.goto(url, { waitUntil: 'load', timeout: 20000 });
        result = { ok: true, action: 'open', url };
        break;
      }
      case 'snapshot': {
        const interactive = args.includes('-i') || args.includes('--interactive');
        const els = await snapshot(page, interactive);
        result = els;
        break;
      }
      case 'find': {
        const query = args.slice(1).join(' ').toLowerCase();
        if (!query) { result = { ok: false, error: 'no search query' }; break; }
        const allEls = await snapshot(page, true);
        const matches = allEls.filter(el => {
          const text = [el.label, el.value, el.name, el.placeholder, el.role, el.tag].filter(Boolean).join(' ').toLowerCase();
          return text.includes(query);
        });
        result = { ok: true, action: 'find', query, count: matches.length, elements: matches };
        break;
      }
      case 'click': {
        const ref = args.find(a => a.startsWith('@'));
        const nums = args.filter(a => /^\d+$/.test(a));
        let x, y;
        if (ref) {
          const resolved = await resolveRef(page, ref);
          if (!resolved) { result = { ok: false, error: 'not found' }; break; }
          x = resolved.x; y = resolved.y;
        } else if (nums.length >= 2) {
          x = parseInt(nums[0]); y = parseInt(nums[1]);
        } else { result = { ok: false, error: 'usage: click @ref | click x y' }; break; }
        const btn = args.includes('--right') ? 'right' : 'left';
        await page.mouse.click(x, y, { button: btn });
        result = { ok: true, action: 'click', x, y, button: btn };
        break;
      }
      case 'drag': {
        const nums = args.filter(a => /^\d+$/.test(a));
        if (nums.length < 4) { result = { ok: false, error: 'usage: drag x1 y1 x2 y2 [steps]' }; break; }
        const [x1, y1, x2, y2] = nums.slice(0, 4).map(Number);
        const steps = nums[5] ? parseInt(nums[4]) : 10;
        await page.mouse.move(x1, y1);
        await page.mouse.down();
        await page.mouse.move(x2, y2, { steps });
        await page.mouse.up();
        result = { ok: true, action: 'drag', from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
        break;
      }
      case 'dblclick': {
        const ref = args.find(a => a.startsWith('@'));
        if (!ref) { result = { ok: false, error: 'no ref' }; break; }
        const resolved = await resolveRef(page, ref);
        if (!resolved) { result = { ok: false, error: 'not found' }; break; }
        await page.mouse.dblclick(resolved.x, resolved.y);
        result = { ok: true, action: 'dblclick', ref };
        break;
      }
      case 'fill': case 'type': {
        const ref = args.find(a => a.startsWith('@'));
        const text = args.slice(args.indexOf(ref) + 1).join(' ');
        if (!ref || !text) { result = { ok: false, error: 'usage: fill @ref text' }; break; }
        const resolved = await resolveRef(page, ref);
        if (!resolved) { result = { ok: false, error: 'not found' }; break; }
        // Use Playwright's fill() for framework-compatible value setting
        // It handles React/Vue/Angular synthetic events automatically
        try {
          const locator = page.locator(resolved.selector);
          await locator.fill(text);
        } catch {
          // Fallback: click + clear + type for non-standard inputs
          await page.mouse.click(resolved.x, resolved.y);
          await page.keyboard.press('Meta+a');
          await page.keyboard.type(text);
        }
        result = { ok: true, action: 'fill', ref, value: text };
        break;
      }
      case 'press': {
        const key = args[1];
        if (!key) { result = { ok: false, error: 'no key' }; break; }
        await page.keyboard.press(key);
        result = { ok: true, action: 'press', key };
        break;
      }
      case 'longpress': {
        const ref = args.find(a => a.startsWith('@'));
        const nums = args.filter(a => /^\d+$/.test(a));
        const duration = parseInt(args.find(a => a.startsWith('--duration='))?.split('=')[1]) || 1000;
        let x, y;
        if (ref) {
          const resolved = await resolveRef(page, ref);
          if (!resolved) { result = { ok: false, error: 'not found' }; break; }
          x = resolved.x; y = resolved.y;
        } else if (nums.length >= 2) {
          x = parseInt(nums[0]); y = parseInt(nums[1]);
        } else { result = { ok: false, error: 'usage: longpress @ref | longpress x y [--duration=ms]' }; break; }
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.waitForTimeout(duration);
        await page.mouse.up();
        result = { ok: true, action: 'longpress', x, y, duration };
        break;
      }
      case 'select': {
        const ref = args.find(a => a.startsWith('@'));
        const val = args.slice(args.indexOf(ref) + 1).join(' ');
        if (!ref || !val) { result = { ok: false, error: 'usage: select @ref value' }; break; }
        const resolved = await resolveRef(page, ref);
        if (!resolved) { result = { ok: false, error: 'not found' }; break; }
        const sel = `${resolved.el.tag}:nth-of-type(1)`;
        try {
          await page.selectOption(resolved.el.name ? `[name="${resolved.el.name}"]` : `select`, val);
          result = { ok: true, action: 'select', ref, value: val };
        } catch (e) {
          result = { ok: false, error: e.message };
        }
        break;
      }
      case 'scroll': {
        const dy = (args[1] === 'up' ? -1 : 1) * (parseInt(args[2]) || 300);
        await page.mouse.wheel(0, dy);
        result = { ok: true, action: 'scroll', ref: `${args[1]} ${args[2] || 300}` };
        break;
      }
      case 'screenshot': {
        const ref = args.find(a => a.startsWith('@'));
        const outPath = args.find(a => a !== cmd && !a.startsWith('@')) || '/tmp/agent-control-web.png';
        if (ref) {
          const resolved = await resolveRef(page, ref);
          if (!resolved) { result = { ok: false, error: 'not found' }; break; }
          const el = await page.$(`${resolved.el.tag}:nth-of-type(1)`);
          if (el) await el.screenshot({ path: outPath });
          else await page.screenshot({ path: outPath });
        } else {
          await page.screenshot({ path: outPath, fullPage: true });
        }
        result = { ok: true, path: outPath };
        break;
      }
      case 'close': case 'quit': case 'exit':
        await browser.close();
        try { fs.unlinkSync(STATE_FILE); } catch {}
        result = { ok: true, action: 'close' };
        process.exit(0);
        break;
      case 'start-video': {
        const dir = args[1] || '/tmp/agent-control-web-video';
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        const newCtx = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          recordVideo: { dir, size: { width: 1280, height: 800 } }
        });
        const newPage = await newCtx.newPage();
        // Copy current URL
        try { await newPage.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 10000 }); } catch {}
        result = { ok: true, action: 'start-video', dir, _newPage: newPage, _newContext: newCtx };
        break;
      }
      case 'stop-video': {
        let videoPath = null;
        try {
          const video = page.video();
          if (video) { videoPath = await video.path(); }
        } catch {}
        try { await page.context().close(); } catch {}
        result = { ok: true, action: 'stop-video', path: videoPath };
        break;
      }
      case 'wait': {
        // wait @ref [timeout_ms]  — 等元素可见
        // wait --url <pattern> [timeout_ms]  — 等 URL 变化
        // wait --idle [timeout_ms]  — 等网络空闲
        // wait --text "some text" [timeout_ms]  — 等文本出现在页面
        // wait --gone "some text" [timeout_ms]  — 等文本从页面消失
        const wArgs = args.slice(1);
        const wTimeoutIdx = wArgs.findIndex(a => /^\d+$/.test(a));
        const wTimeout = wTimeoutIdx >= 0 ? parseInt(wArgs[wTimeoutIdx]) : 5000;
        if (wArgs[0] === '--text') {
          const text = wArgs.slice(1).filter(a => !/^\d+$/.test(a)).join(' ');
          if (!text) { result = { ok: false, error: 'usage: wait --text "some text" [timeout_ms]' }; break; }
          await page.waitForFunction(
            (t) => document.body.innerText.includes(t),
            text, { timeout: wTimeout }
          );
          result = { ok: true, action: 'wait-text', text };
        } else if (wArgs[0] === '--gone') {
          const text = wArgs.slice(1).filter(a => !/^\d+$/.test(a)).join(' ');
          if (!text) { result = { ok: false, error: 'usage: wait --gone "some text" [timeout_ms]' }; break; }
          await page.waitForFunction(
            (t) => !document.body.innerText.includes(t),
            text, { timeout: wTimeout }
          );
          result = { ok: true, action: 'wait-gone', text };
        } else if (wArgs[0] === '--url') {
          const pattern = wArgs[1] || '**';
          await page.waitForURL(pattern, { timeout: wTimeout });
          result = { ok: true, action: 'wait-url', url: page.url() };
        } else if (wArgs[0] === '--idle' || wArgs.length === 0) {
          await page.waitForLoadState('networkidle', { timeout: wTimeout });
          result = { ok: true, action: 'wait-idle' };
        } else if (wArgs[0] && wArgs[0].startsWith('@')) {
          const resolved = await resolveRef(page, wArgs[0]);
          if (!resolved) { result = { ok: false, error: `ref ${wArgs[0]} not found` }; break; }
          await page.waitForSelector(resolved.selector, { state: 'visible', timeout: wTimeout });
          result = { ok: true, action: 'wait-ref', ref: wArgs[0] };
        } else if (wArgs[0]) {
          await page.waitForSelector(wArgs[0], { state: 'visible', timeout: wTimeout });
          result = { ok: true, action: 'wait-selector', selector: wArgs[0] };
        } else {
          await page.waitForLoadState('networkidle', { timeout: wTimeout });
          result = { ok: true, action: 'wait-idle' };
        }
        break;
      }
      case 'console': case 'logs': {
        const level = args.find(a => ['error','warn','warning','info','log','debug'].includes(a));
        const countArg = args.find(a => /^\d+$/.test(a));
        const limit = countArg ? parseInt(countArg) : 50;
        const doClear = args.includes('--clear') || args.includes('-c');
        let entries = [...consoleLogs];
        if (level) {
          const match = level === 'warning' ? 'warn' : level;
          entries = entries.filter(e => e.type === match);
        }
        entries = entries.slice(-limit);
        if (doClear) consoleLogs.length = 0;
        result = { ok: true, action: 'console', count: entries.length, total: consoleLogs.length, entries };
        break;
      }
      case 'eval': {
        let expr = args.slice(1).join(' ');
        // Support reading expression from file: eval --file /path/to/script.js
        const fileIdx = args.indexOf('--file');
        if (fileIdx !== -1 && args[fileIdx + 1]) {
          try { expr = fs.readFileSync(args[fileIdx + 1], 'utf-8'); } catch (e) {
            result = { ok: false, error: `cannot read file: ${e.message}` }; break;
          }
        }
        if (!expr) { result = { ok: false, error: 'no expression. usage: eval <js> | eval --file <path>' }; break; }
        const val = await page.evaluate(expr);
        result = { ok: true, action: 'eval', value: val };
        break;
      }
      case 'url': {
        result = { ok: true, action: 'url', url: page.url() };
        break;
      }
      case 'back': {
        await page.goBack({ timeout: 10000 });
        result = { ok: true, action: 'back', url: page.url() };
        break;
      }
      case 'forward': {
        await page.goForward({ timeout: 10000 });
        result = { ok: true, action: 'forward', url: page.url() };
        break;
      }
      case 'reload': {
        await page.reload({ timeout: 15000 });
        result = { ok: true, action: 'reload', url: page.url() };
        break;
      }
      default:
        result = { ok: false, error: `unknown command '${cmd}'` };
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  return result;
}

// ══════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════
async function main() {
  const rawArgs = process.argv.slice(2);

  // Special: start-daemon — fork daemon to background and exit immediately
  if (rawArgs[0] === 'start-daemon') {
    if (isDaemonRunning()) {
      console.log(JSON.stringify({ ok: true, action: 'start-daemon', status: 'already running' }));
      process.exit(0);
    }
    const { spawn } = require('child_process');
    const child = spawn('node', [__filename, '--daemon-mode'], {
      detached: true, stdio: 'ignore', env: { ...process.env }
    });
    child.unref();
    // Wait for daemon to be ready
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (isDaemonRunning()) {
        console.log(JSON.stringify({ ok: true, action: 'start-daemon', pid: child.pid }));
        process.exit(0);
      }
    }
    console.log(JSON.stringify({ ok: false, error: 'daemon start timeout' }));
    process.exit(1);
  }

  // Special: --daemon-mode — run as background daemon (don't exit)
  // Extract --cdp flag
  let cdpEndpoint = null;
  const cdpIdx = rawArgs.indexOf('--cdp');
  if (cdpIdx !== -1) {
    cdpEndpoint = rawArgs[cdpIdx + 1];
    rawArgs.splice(cdpIdx, 2);
  }

  // Extract --headed flag
  let headed = false;
  const headedIdx = rawArgs.indexOf('--headed');
  if (headedIdx !== -1) {
    headed = true;
    rawArgs.splice(headedIdx, 1);
  }

  if (rawArgs[0] === '--daemon-mode') {
    await startDaemon(cdpEndpoint ? { cdp: cdpEndpoint, headed } : { headed });
    // Keep alive — HTTP server prevents exit
    return;
  }

  const commands = parseCommands(rawArgs);

  if (commands.length === 0) {
    console.log('Usage: agent-control-web <command> [; command2 ...]');
    process.exit(0);
  }

  // If daemon is running, send commands via HTTP
  if (isDaemonRunning()) {
    for (const args of commands) {
      const result = await sendToDaemon(args);
      console.log(JSON.stringify(result, null, 2));
    }
    process.exit(0);
  }

  // No daemon — start one, execute first batch, keep alive
  const { browser, page, context, server } = await startDaemon(cdpEndpoint ? { cdp: cdpEndpoint, headed } : { headed });

  for (const args of commands) {
    const result = await executeCommand(args, page, browser, context);
    console.log(JSON.stringify(result, null, 2));
  }

  // Don't exit — daemon stays alive for subsequent CLI calls
  // Process will be kept alive by the HTTP server
}

main();
