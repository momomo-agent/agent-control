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
async function startDaemon() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  let page = await context.newPage();

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
        if (result._newPage) { page = result._newPage; delete result._newPage; }
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
    const interactiveSelectors = [
      'button', 'input', 'select', 'textarea', 'a[href]',
      '[role="button"]', '[role="link"]', '[role="checkbox"]',
      '[role="radio"]', '[role="tab"]', '[role="menuitem"]',
      '[role="slider"]', '[role="switch"]', '[role="combobox"]',
      '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
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
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || el.type || tag;
      const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 80) || '';
      const value = el.value || '';
      const name = el.getAttribute('name') || '';
      results.push({ ref, role, tag, label, value, name, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
    }
    return results;
  }, interactiveOnly);
}

async function resolveRef(page, ref) {
  const idx = parseInt(ref.replace('@e', '')) - 1;
  const els = await snapshot(page, true);
  if (idx < 0 || idx >= els.length) return null;
  const el = els[idx];
  const selectors = [
    el.name ? `[name="${el.name}"]` : null,
    el.tag === 'input' && el.role ? `input[type="${el.role}"]` : null,
    `${el.tag}`,
  ].filter(Boolean);
  // Use coordinates for precise targeting
  return { selector: selectors[0], x: el.x + el.w / 2, y: el.y + el.h / 2, el };
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
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        result = { ok: true, action: 'open', url };
        break;
      }
      case 'snapshot': {
        const interactive = args.includes('-i') || args.includes('--interactive');
        const els = await snapshot(page, interactive);
        result = els;
        break;
      }
      case 'click': {
        const ref = args.find(a => a.startsWith('@'));
        if (!ref) { result = { ok: false, error: 'no ref' }; break; }
        const resolved = await resolveRef(page, ref);
        if (!resolved) { result = { ok: false, error: 'not found' }; break; }
        await page.mouse.click(resolved.x, resolved.y);
        result = { ok: true, action: 'click', ref };
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
        await page.mouse.click(resolved.x, resolved.y);
        await page.keyboard.selectAll?.() || await page.keyboard.press('Meta+a');
        await page.keyboard.type(text);
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
  const { browser, page, context, server } = await startDaemon();

  for (const args of commands) {
    const result = await executeCommand(args, page, browser, context);
    console.log(JSON.stringify(result, null, 2));
  }

  // Don't exit — daemon stays alive for subsequent CLI calls
  // Process will be kept alive by the HTTP server
}

main();
