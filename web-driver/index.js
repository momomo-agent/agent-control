#!/usr/bin/env node
/**
 * agent-control Web Driver — Playwright + CDP 持久浏览器
 *
 * 两步使用：
 *   1. agent-control-web start          # 启动浏览器（后台常驻）
 *   2. agent-control-web snapshot -i    # 操作
 *
 * 或一步：
 *   agent-control-web open <url>        # 自动启动 + 导航
 */

const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');

const STATE_FILE = '/tmp/agent-control-web.json';
const PORT = 3901;

// ── Connect to running browser ──
async function connect() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.port}`);
    const contexts = browser.contexts();
    const pages = contexts[0]?.pages();
    return { browser, page: pages?.[0] || null };
  } catch {
    fs.unlinkSync(STATE_FILE);
    return null;
  }
}

// ── Launch browser ──
async function launch() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  return { browser, page };
}

async function getPage() {
  let conn = await connect();
  if (conn?.page) return conn;
  return await launch();
}

// ── Snapshot ──
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
      const rect = el.getBoundingClientRect();
      if (rect.width < 3 || rect.height < 3) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (rect.right < 0 || rect.left > window.innerWidth) continue;

      counter++;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || tag;
      const label = el.getAttribute('aria-label')
        || el.getAttribute('title')
        || el.getAttribute('placeholder')
        || el.textContent?.trim().slice(0, 40) || '';
      const value = el.value ?? el.getAttribute('value') ?? null;

      // Build stable selector
      let sel;
      const testId = el.getAttribute('data-testid');
      if (testId) sel = `[data-testid="${testId}"]`;
      else if (el.id) sel = `#${CSS.escape(el.id)}`;
      else {
        const aria = el.getAttribute('aria-label');
        if (aria) sel = `${tag}[aria-label="${aria}"]`;
        else {
          const parent = el.parentElement;
          const siblings = parent ? Array.from(parent.children).filter(c => c.tagName === el.tagName) : [];
          const idx = siblings.indexOf(el) + 1;
          sel = siblings.length > 1 ? `${tag}:nth-of-type(${idx})` : tag;
        }
      }

      results.push({
        ref: `@e${counter}`, role, label, value,
        frame: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        interactive: true, _sel: sel,
      });
    }
    return results;
  }, interactiveOnly);
}

// ── Resolve ref → selector ──
let refCache = {};
async function resolveRef(page, ref) {
  if (!refCache[ref]) {
    const elements = await snapshot(page, true);
    refCache = {};
    for (const el of elements) refCache[el.ref] = el._sel;
  }
  return refCache[ref];
}

function clearCache() { refCache = {}; }

// ── Parse multi-command: "open url ; snapshot -i" ──
function parseCommands(argv) {
  const cmds = [];
  let current = [];
  for (const a of argv) {
    if (a === ';' || a === '&&') {
      if (current.length) cmds.push(current);
      current = [];
    } else {
      current.push(a);
    }
  }
  if (current.length) cmds.push(current);
  return cmds;
}

// ── CLI ──
async function main() {
  const rawArgs = process.argv.slice(2);
  const commands = parseCommands(rawArgs);

  if (commands.length === 0) {
    console.log('Usage: agent-control-web <command> [; command2 ...]');
    process.exit(0);
  }

  const { browser, page } = await getPage();
  if (!page) { console.error('error: no page'); process.exit(1); }

  for (const args of commands) {
    const result = await runCommand(args, page, browser);
    console.log(JSON.stringify(result, null, 2));
  }

  try { await browser.close(); } catch {}
  process.exit(0);
}

async function runCommand(args, page, browser) {
  const cmd = args[0];

  if (!cmd || cmd === 'help' || cmd === '--help') {
    return { help: true };
  }

  let result;
  try {
    switch (cmd) {
      case 'open': case 'navigate': case 'goto': {
        let url = args[1];
        if (!url.startsWith('http')) url = 'https://' + url;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        clearCache();
        result = { ok: true, action: 'open', url };
        break;
      }
      case 'snapshot': {
        const elements = await snapshot(page, args.includes('-i'));
        result = elements.map(({ _sel, ...rest }) => rest);
        break;
      }
      case 'click': {
        const sel = await resolveRef(page, args[1]);
        if (!sel) { result = { ok: false, error: 'not found' }; break; }
        await page.click(sel);
        clearCache();
        result = { ok: true, action: 'click', ref: args[1] };
        break;
      }
      case 'dblclick': {
        const sel = await resolveRef(page, args[1]);
        if (!sel) { result = { ok: false, error: 'not found' }; break; }
        await page.dblclick(sel);
        clearCache();
        result = { ok: true, action: 'dblclick', ref: args[1] };
        break;
      }
      case 'rightclick': {
        const sel = await resolveRef(page, args[1]);
        if (!sel) { result = { ok: false, error: 'not found' }; break; }
        await page.click(sel, { button: 'right' });
        clearCache();
        result = { ok: true, action: 'rightclick', ref: args[1] };
        break;
      }
      case 'fill': {
        const sel = await resolveRef(page, args[1]);
        if (!sel) { result = { ok: false, error: 'not found' }; break; }
        await page.fill(sel, args.slice(2).join(' '));
        clearCache();
        result = { ok: true, action: 'fill', ref: args[1] };
        break;
      }
      case 'press': case 'key': {
        await page.keyboard.press(args[1]);
        result = { ok: true, action: 'press', ref: args[1] };
        break;
      }
      case 'hover': {
        const sel = await resolveRef(page, args[1]);
        if (!sel) { result = { ok: false, error: 'not found' }; break; }
        await page.hover(sel);
        result = { ok: true, action: 'hover', ref: args[1] };
        break;
      }
      case 'drag': {
        const elements = await snapshot(page, true);
        const fromEl = elements.find(e => e.ref === args[1]);
        const toEl = elements.find(e => e.ref === args[2]);
        if (!fromEl || !toEl) { result = { ok: false, error: 'not found' }; break; }
        const fx = fromEl.frame.x + fromEl.frame.w / 2;
        const fy = fromEl.frame.y + fromEl.frame.h / 2;
        const tx = toEl.frame.x + toEl.frame.w / 2;
        const ty = toEl.frame.y + toEl.frame.h / 2;
        await page.mouse.move(fx, fy);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) {
          await page.mouse.move(fx + (tx - fx) * i / 10, fy + (ty - fy) * i / 10);
        }
        await page.mouse.up();
        clearCache();
        result = { ok: true, action: 'drag', ref: `${args[1]} → ${args[2]}` };
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
          const sel = await resolveRef(page, ref);
          if (!sel) { result = { ok: false, error: 'not found' }; break; }
          const el = await page.$(sel);
          await el.screenshot({ path: outPath });
        } else {
          await page.screenshot({ path: outPath });
        }
        result = { ok: true, path: outPath };
        break;
      }
      case 'close': case 'quit': case 'exit':
        await browser.close();
        try { fs.unlinkSync(STATE_FILE); } catch {}
        result = { ok: true, action: 'close' };
        break;
      default:
        result = { ok: false, error: `unknown command '${cmd}'` };
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  return result;
}

main();
