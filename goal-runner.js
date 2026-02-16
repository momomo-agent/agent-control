#!/usr/bin/env node
/**
 * agent-control Goal Runner — agent 的眼睛和手
 *
 * observe 默认截图 + 树，可选只截图或只树
 *
 * Usage:
 *   node goal-runner.js -p macos observe                    # 截图 + 树
 *   node goal-runner.js -p macos observe --screenshot-only  # 只截图
 *   node goal-runner.js -p macos observe --tree-only        # 只树
 *   node goal-runner.js -p macos act click @e3
 *   node goal-runner.js -p macos act-observe dblclick @e5
 *   node goal-runner.js -p web act-observe open example.com
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CLI = path.join(__dirname, 'cli.js');
const SCREENSHOT_DIR = '/tmp/agent-control';
try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}

// ── Parse args ──
const args = process.argv.slice(2);
function flag(names, def) {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return def;
}
function hasFlag(names) {
  return names.some(n => args.includes(n));
}

const platform = flag(['--platform', '-p'], 'macos');
const pid = flag(['--pid'], null);
const screenshotOnly = hasFlag(['--screenshot-only', '--ss']);
const treeOnly = hasFlag(['--tree-only', '--tree']);

// ── AC wrapper ──
function ac(tokens) {
  const argv = [CLI, '-p', platform, ...tokens, ...(pid ? ['--pid', pid] : [])];
  const r = spawnSync('node', argv, { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}

// ── Observe: screenshot + tree ──
function observe(mode) {
  const result = { ok: true, action: 'observe' };
  const ts = Date.now();

  // Screenshot (default or screenshot-only)
  if (mode !== 'tree') {
    const ssPath = `${SCREENSHOT_DIR}/observe-${ts}.png`;
    const ssResult = ac(['screenshot', ssPath]);
    try {
      const parsed = JSON.parse(ssResult);
      if (parsed.ok) {
        result.screenshot = parsed.path || ssPath;
      }
    } catch {
      // Try direct screenshot for web (needs page)
      result.screenshot = null;
      result.screenshotError = 'no page open';
    }
  }

  // Tree (default or tree-only)
  if (mode !== 'screenshot') {
    const raw = ac(['snapshot', '-i']);
    try {
      const elements = JSON.parse(raw);
      result.elementCount = elements.length;
      result.elements = elements.map(e => {
        const v = e.value || e.label || '';
        return `${e.ref} ${e.role}${v ? ` "${v}"` : ''}`;
      }).join('\n');
    } catch {
      result.elements = '';
      result.elementCount = 0;
    }
  }

  return result;
}

// ── Find command position ──
let cmdIdx = -1;
const skipNext = new Set(['-p', '--platform', '--pid']);
for (let i = 0; i < args.length; i++) {
  if (skipNext.has(args[i])) { i++; continue; }
  if (args[i].startsWith('-')) continue;
  cmdIdx = i;
  break;
}

const command = cmdIdx >= 0 ? args[cmdIdx] : 'observe';

// Collect action tokens (everything after command, excluding flags)
const actionTokens = [];
if (cmdIdx >= 0) {
  for (let i = cmdIdx + 1; i < args.length; i++) {
    if (skipNext.has(args[i])) { i++; continue; }
    if (args[i].startsWith('--')) continue;
    actionTokens.push(args[i]);
  }
}

switch (command) {
  case 'observe': case 'look': case 'see': {
    const mode = screenshotOnly ? 'screenshot' : treeOnly ? 'tree' : 'both';
    const state = observe(mode);
    console.log(JSON.stringify(state, null, 2));
    break;
  }

  case 'act': case 'do': {
    const result = ac(actionTokens);
    console.log(result);
    break;
  }

  case 'act-observe': case 'do-look': {
    const actResult = ac(actionTokens);
    spawnSync('sleep', ['0.5']);
    const mode = screenshotOnly ? 'screenshot' : treeOnly ? 'tree' : 'both';
    const state = observe(mode);
    let parsed;
    try { parsed = JSON.parse(actResult); } catch { parsed = actResult; }
    console.log(JSON.stringify({
      ok: true,
      actionResult: parsed,
      observe: state,
    }, null, 2));
    break;
  }

  default:
    const result = ac([command, ...actionTokens]);
    console.log(result);
}
