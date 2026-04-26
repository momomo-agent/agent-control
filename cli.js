#!/usr/bin/env node
/**
 * agent-control — 统一 CLI 入口
 *
 * Usage:
 *   agent-control --platform macos snapshot -i
 *   agent-control --platform web open example.com ; snapshot -i
 *   agent-control --platform ios tap @e1
 *
 * 不指定 platform 时自动检测
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');

const ROOT = __dirname;
const args = process.argv.slice(2);

// Ensure stdout is fully flushed before exit (pipe mode truncation fix)
const _origExit = process.exit.bind(process);
function flushAndExit(code = 0) {
  if (process.stdout.writableFinished || process.stdout.writableEnded) {
    _origExit(code);
    return;
  }
  process.stdout.write('', () => _origExit(code));
  setTimeout(() => _origExit(code), 500).unref();
}

// ── Parse --platform and --enhanced ──
let platform = null;
let enhanced = false;
let compact = false;
let jsonMode = false;
let allMode = false;
let pidArg = null;
let driverArgs = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--platform' || args[i] === '-p') {
    platform = args[i + 1]; i++;
  } else if (args[i] === '--enhanced' || args[i] === '-e') {
    enhanced = true;
  } else if (args[i] === '--compact' || args[i] === '-c') {
    compact = true; enhanced = true;
  } else if (args[i] === '--json') {
    jsonMode = true; enhanced = true;
  } else if (args[i] === '--all') {
    allMode = true; enhanced = true;
  } else if (args[i] === '--pid') {
    pidArg = args[i + 1]; i++;
  } else if (args[i] === '--app') {
    driverArgs.push('--app', args[i + 1]); i++;
  } else {
    driverArgs.push(args[i]);
  }
}
// Append --pid after command for drivers that expect it
if (pidArg) driverArgs.push('--pid', pidArg);

// ── Normalize refs: ensure @ prefix ──
// Drivers expect @e3 format (aligned with agent-browser convention)
driverArgs = driverArgs.map(a => /^e\d+$/.test(a) ? '@' + a : a);

// ── Extract actual command from driverArgs (skip flags like --app, --pid) ──
const flagsWithVal = new Set(['--app', '--pid']);
const flagsNoVal = new Set(['-i']);
function getCommand() {
  for (let i = 0; i < driverArgs.length; i++) {
    if (flagsWithVal.has(driverArgs[i])) { i++; continue; }
    if (flagsNoVal.has(driverArgs[i])) continue;
    return driverArgs[i];
  }
  return null;
}

// ── Subcommand shortcuts ──
const cmd0 = getCommand();
if (cmd0 === 'doctor') {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'doctor.js'), ...driverArgs.slice(1)], { stdio: 'inherit' });
  process.exit(r.status || 0);
}
if (cmd0 === 'demo') {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'demo.js'), ...driverArgs.slice(1)], { stdio: 'inherit' });
  process.exit(r.status || 0);
}
if (cmd0 === 'find' && platform !== 'web') {
  // CLI-level find: snapshot + filter for non-web platforms
  const query = driverArgs.slice(1).join(' ').toLowerCase();
  if (!query) { console.error('usage: agent-control -p <platform> find <text>'); process.exit(1); }
  // Replace driverArgs to run snapshot -i, then filter
  driverArgs = ['snapshot', '-i'];
  enhanced = true;
  // Store query for post-processing
  global.__findQuery = query;
}

// ── Auto-detect platform ──
if (!platform) {
  if (cmd0 === 'open' || cmd0 === 'navigate' || cmd0 === 'goto') {
    platform = 'web';
  } else {
    platform = 'macos'; // default
  }
}

// ── Route to driver ──
const { enhance } = require('./snapshot-enhance');

function runDriver(cmd, args, timeout = 15000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  return r;
}

function maybeEnhance(r) {
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();

  // Check for empty/error results and provide helpful messages
  if (r.status !== 0 && !out) {
    const hints = {
      macos: 'Check: is the app running? Is --pid correct? Grant Accessibility permission in System Settings > Privacy.',
      ios: 'Check: is Simulator running with a booted device? Run: xcrun simctl list devices booted',
      web: 'Check: is the URL correct? Run: agent-control -p web open <url> first.',
    };
    console.error(JSON.stringify({ ok: false, error: err || 'command failed', hint: hints[platform] || '' }, null, 2));
    flushAndExit(1);
    return;
  }

  if (!enhanced || !driverArgs.includes('snapshot')) {
    if (out) process.stdout.write(out + '\n');
    if (err) process.stderr.write(err + '\n');
    flushAndExit(r.status || 0);
    return;
  }
  try {
    const els = JSON.parse(out);
    const arr = Array.isArray(els) ? els : Object.values(els);
    if (arr.length === 0) {
      console.log(JSON.stringify({ ok: false, error: 'no elements found', hint: platform === 'macos' ? 'Is --pid correct? Is the app in foreground?' : platform === 'ios' ? 'Is Simulator running? Try: open -a Simulator' : 'Did you open a URL first?' }, null, 2));
      flushAndExit(1);
    }
    const result = enhance(arr, { platform, all: allMode });
    if (global.__findQuery) {
      const q = global.__findQuery;
      const matches = result.elements.filter(el => {
        const t = [el.label, el.value, el.name, el.text, el.role, el.tag].filter(Boolean).join(' ').toLowerCase();
        return t.includes(q);
      });
      console.log(JSON.stringify({ ok: true, action: 'find', query: q, count: matches.length, elements: matches }));
    } else if (compact) {
      console.log(result.summary);
      console.log(result.text);
    } else if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.summary);
      console.log(result.text);
    }
  } catch(e) { console.error('enhance error:', e.message); process.stdout.write(out + '\n'); }
  flushAndExit(r.status || 0);
}

const drivers = {
  macos: () => {
    const bin = path.join(ROOT, 'macos-driver', '.build', 'debug', 'agent-control');
    if (!require('fs').existsSync(bin)) {
      console.error('macOS driver not built. Run: cd macos-driver && swift build');
      process.exit(1);
    }
    const timeout = (driverArgs[0] === 'console' || driverArgs[0] === 'logs') ? 30000 : 15000;
    maybeEnhance(runDriver(bin, driverArgs, timeout));
  },
  web: () => {
    const fs = require('fs');
    const STATE = '/tmp/agent-control-web.json';
    // Extract --cdp from driverArgs
    let cdpUrl = null;
    const cdpIdx = driverArgs.indexOf('--cdp');
    if (cdpIdx !== -1) {
      cdpUrl = driverArgs[cdpIdx + 1];
      driverArgs.splice(cdpIdx, 2);
    }
    function daemonAlive() {
      try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); process.kill(s.pid, 0); return true; } catch { return false; }
    }
    // If --cdp, kill existing daemon (it's connected to a different target)
    if (cdpUrl && daemonAlive()) {
      try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); process.kill(s.pid); } catch {}
      spawnSync('sleep', ['0.5']);
    }
    if (!daemonAlive()) {
      // Start daemon in background
      const { spawn } = require('child_process');
      const script = path.join(ROOT, 'web-driver', 'index.js');
      const startArgs = cdpUrl
        ? ['--cdp', cdpUrl, 'open', 'about:blank']
        : ['open', 'about:blank'];
      const child = spawn('node', [script, ...startArgs], {
        detached: true, stdio: 'ignore',
      });
      child.unref();
      // Wait for daemon to be ready
      for (let i = 0; i < 20; i++) {
        spawnSync('sleep', ['0.3']);
        if (daemonAlive()) break;
      }
      if (!daemonAlive()) { console.error('Failed to start web daemon'); process.exit(1); }
    }
    // Send command via HTTP
    const http = require('http');
    const data = JSON.stringify({ args: driverArgs });
    const req = http.request({
      hostname: '127.0.0.1', port: 3901, path: '/cmd', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (enhanced && driverArgs.includes('snapshot')) {
          try {
            const els = JSON.parse(body);
            const arr = Array.isArray(els) ? els : Object.values(els);
            const r = enhance(arr, { platform, all: allMode });
            if (compact) {
              console.log(r.summary);
              console.log(r.text);
            } else if (jsonMode) {
              console.log(JSON.stringify(r, null, 2));
            } else {
              console.log(r.summary);
              console.log(r.text);
            }
          } catch { process.stdout.write(body); }
        } else {
          process.stdout.write(body + '\n');
        }
        process.exit(0);
      });
    });
    req.on('error', e => { console.error('Web daemon error:', e.message); process.exit(1); });
    req.write(data);
    req.end();
  },
  ios: () => {
    const script = path.join(ROOT, 'ios-driver', 'index.js');
    maybeEnhance(runDriver('node', [script, ...driverArgs]));
  },
  android: () => {
    const script = path.join(ROOT, 'android-driver', 'index.js');
    maybeEnhance(runDriver('node', [script, ...driverArgs], 60000));
  },
  electron: () => {
    const script = path.join(ROOT, 'electron-driver', 'index.js');
    maybeEnhance(runDriver('node', [script, ...driverArgs], 30000));
  },
  flutter: () => {
    const script = path.join(ROOT, 'flutter-driver', 'index.js');
    maybeEnhance(runDriver('node', [script, ...driverArgs], 30000));
  },
};

if (!drivers[platform]) {
  console.error(JSON.stringify({ ok: false, error: `unknown platform '${platform}'. Use: macos, web, ios, android, electron` }));
  process.exit(1);
}

// Top-level subcommands → delegate
const subcommands = {
  auto: 'auto.js',
  doctor: 'doctor.js',
  'run-all': 'run-all.js',
  goal: 'goal-runner.js',
  viewer: 'viewer.js',
};
if (cmd0 && subcommands[cmd0]) {
  const { spawnSync: ss } = require('child_process');
  const r = ss('node', [path.join(ROOT, subcommands[cmd0]), ...args.slice(args.indexOf(cmd0) + 1)], { stdio: 'inherit', encoding: 'utf8' });
  process.exit(r.status || 0);
}

if (driverArgs.length === 0 || cmd0 === 'help' || cmd0 === '--help') {
  console.log(`agent-control — Give AI hands.

Usage:
  agent-control -p <platform> [-e] [--pid <pid>] <command> [args...]
  agent-control <subcommand> [args...]

Platforms:
  web       Playwright (auto-starts daemon)
  macos     Accessibility API (--pid to target app)
  ios       Simulator (idb) + Real Device (pymobiledevice3)
  android   Emulator via uiautomator (experimental)
  electron  Electron via CDP
  flutter   Flutter via Dart VM Service Protocol

Driver commands:
  snapshot [-i] [-e]        See UI elements
  click @ref | x y          Click/tap
  drag @r1 @r2              Drag between refs or coordinates
  fill @ref "text"          Clear + type
  select @ref "value"       Select dropdown (web)
  press <key>               Keyboard key
  screenshot [path]         Save PNG (macOS: requires --app, or --full for full-screen)
  open <url>                Navigate (web)
  swipe <dir>               Swipe (iOS/Android)
  close                     Close browser (web)
  console [level] [N]       Show console/system logs

Subcommands:
  auto    -p <plat> --goal "..." [--url <url>]   LLM-driven goal loop
  doctor  [-p <plat>]                            Environment check
  run-all [--json]                               Run all flows
  goal    -p <plat> observe|act|act-observe ...  Step-by-step goal runner
  viewer                                         Open HTML report viewer

Options:
  -e, --enhanced    Filter interactive elements + semantic summary
  --pid <pid>       Target specific app by PID (macOS)
  --app <name>      Target app by name or bundleId (macOS)
  --real            Force real device backend (iOS)
  --sim             Force simulator backend (iOS)

Examples:
  agent-control doctor
  agent-control -p web open https://example.com
  agent-control -p web -e snapshot
  agent-control -p web click @e3
  agent-control -p macos --app Finder snapshot -i
  agent-control -p macos screenshot --app com.apple.controlcenter /tmp/menubar.png
  agent-control -p ios snapshot -i
  agent-control -p ios --real screenshot /tmp/real.png
  agent-control -p ios --real list-apps
  agent-control auto -p web --goal "Sign up" --url https://example.com`);
  process.exit(0);
}

drivers[platform]();
