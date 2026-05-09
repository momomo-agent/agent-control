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
  const subArgs = driverArgs.slice(1);
  if (platform) subArgs.push('-p', platform);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'doctor.js'), ...subArgs], { stdio: 'inherit' });
  process.exit(r.status || 0);
}

// ── `agent-control shot` — open-the-box screenshot ──
// Auto-picks the best available backend and uses a sane default output path.
//   1. Force order: --real > --sim > --macos > auto
//   2. Auto: iOS simulator (fast) > iOS real device > macOS (only with --app or --full)
//   3. Default output: ./shot-YYYYMMDD-HHMMSS.png
if (cmd0 === 'shot') {
  const shotArgs = driverArgs.slice(1);

  // Per-subcommand help
  if (shotArgs.includes('--help') || shotArgs.includes('-h') || shotArgs[0] === 'help') {
    console.log(`agent-control shot — quick screenshot, auto-picks backend.

Usage:
  agent-control shot [path.png] [options]

Backend (auto by default: iOS simulator > iOS real device > err):
  --sim                Force iOS simulator (must be booted)
  --real               Force iOS real device (must be plugged in + trusted)
  --macos              macOS screen (default --full if no --app)
  --app <name>         macOS: screenshot a single app window (implies --macos)
  --full               macOS: full screen (implies --macos)

Options:
  --open               After saving, open the PNG with default app (macOS: \`open\`)
  -h, --help           Show this help

Output path:
  If no path is given, saves to ./shot-YYYYMMDD-HHMMSS.png in the current dir.

Examples:
  agent-control shot                                # auto
  agent-control shot /tmp/x.png --open              # auto, then open
  agent-control shot --real /tmp/real.png
  agent-control shot --macos --app Finder
  agent-control shot --full
`);
    process.exit(0);
  }

  const forceReal = shotArgs.includes('--real');
  const forceSim = shotArgs.includes('--sim');
  const fullFlag = shotArgs.includes('--full');
  const appIdx = shotArgs.indexOf('--app');
  const appName = appIdx !== -1 ? shotArgs[appIdx + 1] : null;
  const forceMacos = shotArgs.includes('--macos') || platform === 'macos' || fullFlag || !!appName;
  const openFlag = shotArgs.includes('--open');
  const explicitPath = shotArgs.find(a => !a.startsWith('-') && a !== appName);

  function ts() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  const outPath = explicitPath || path.resolve(process.cwd(), `shot-${ts()}.png`);

  function detectIosBackend() {
    if (forceSim) return 'sim';
    if (forceReal) return 'real';
    const simR = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'],
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe','pipe','pipe'] });
    if (simR.status === 0 && simR.stdout) {
      try {
        const data = JSON.parse(simR.stdout);
        for (const [, devs] of Object.entries(data.devices)) {
          for (const d of devs) if (d.state === 'Booted') return 'sim';
        }
      } catch {}
    }
    const py = spawnSync('python3', [path.join(ROOT, 'ios-driver', 'real-device.py'), 'detect'],
      { encoding: 'utf8', timeout: 6000, stdio: ['pipe','pipe','pipe'] });
    if (py.stdout) {
      try {
        const d = JSON.parse(py.stdout);
        if (d.ok && d.devices && d.devices.length > 0) return 'real';
      } catch {}
    }
    return null;
  }

  let backendChoice = null;
  if (forceMacos) {
    backendChoice = 'macos';
  } else {
    backendChoice = detectIosBackend();
    if (!backendChoice) {
      console.log(JSON.stringify({
        ok: false,
        error: 'no iOS device available',
        hint: 'Options: (a) boot a simulator (`open -a Simulator`); (b) plug in an iPhone + trust this Mac; (c) use `shot --macos --app <name>` or `shot --full` for a Mac screenshot. Diagnose: `agent-control doctor -p ios`.',
      }, null, 2));
      process.exit(1);
    }
  }

  let result;
  if (backendChoice === 'macos') {
    const fs_ = require('fs');
    const rel = path.join(ROOT, 'macos-driver', '.build', 'release', 'agent-control');
    const dbg = path.join(ROOT, 'macos-driver', '.build', 'debug', 'agent-control');
    const bin = fs_.existsSync(rel) ? rel : dbg;
    if (!fs_.existsSync(bin)) {
      console.log(JSON.stringify({ ok: false, error: 'macOS driver not built', hint: 'cd macos-driver && swift build -c release' }, null, 2));
      process.exit(1);
    }
    const macArgs = ['screenshot'];
    if (appName) macArgs.push('--app', appName);
    // If neither --app nor --full specified for macOS, default to full screen.
    else if (!fullFlag) macArgs.push('--full');
    if (fullFlag) macArgs.push('--full');
    macArgs.push(outPath);
    const r = spawnSync(bin, macArgs, { encoding: 'utf8', timeout: 20000, stdio: ['pipe','pipe','pipe'] });
    if (r.status === 0 && fs_.existsSync(outPath)) {
      result = { ok: true, backend: 'macos', path: outPath };
    } else {
      result = { ok: false, backend: 'macos', error: (r.stderr || r.stdout || 'screenshot failed').trim() };
    }
  } else {
    const script = path.join(ROOT, 'ios-driver', 'index.js');
    const flag = backendChoice === 'real' ? '--real' : '--sim';
    const r = spawnSync('node', [script, flag, 'screenshot', outPath],
      { encoding: 'utf8', timeout: 25000, stdio: ['pipe','pipe','pipe'] });
    try { result = JSON.parse(r.stdout || '{}'); }
    catch { result = { ok: false, error: (r.stderr || r.stdout || 'screenshot failed').trim() }; }
    if (!result.backend) result.backend = backendChoice === 'real' ? 'ios-real' : 'ios-sim';
    if (result.ok && !result.path) result.path = outPath;
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.ok && openFlag && process.platform === 'darwin') {
    spawnSync('open', [result.path], { stdio: 'ignore' });
  }
  process.exit(result.ok ? 0 : 1);
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

// ── virtual-cursor alias: maps to macos `cursor <sub>` ──
// Top-level shortcut so `agent-control virtual-cursor start` works without -p macos.
if (cmd0 === 'virtual-cursor' || cmd0 === 'vcursor') {
  platform = 'macos';
  const cmdIdx = driverArgs.indexOf(cmd0);
  if (cmdIdx >= 0) driverArgs[cmdIdx] = 'cursor';
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
    const fs_ = require('fs');
    // Prefer release build when available (optimized), fall back to debug.
    const rel = path.join(ROOT, 'macos-driver', '.build', 'release', 'agent-control');
    const dbg = path.join(ROOT, 'macos-driver', '.build', 'debug', 'agent-control');
    const bin = fs_.existsSync(rel) ? rel : dbg;
    if (!fs_.existsSync(bin)) {
      console.error('macOS driver not built. Run: cd macos-driver && swift build -c release');
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
        : ['--headed', 'open', 'about:blank'];
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
  click @ref | x y          Click/tap  (macOS: --focus-guard 后台不抢焦点)
  drag @r1 @r2              Drag between refs or coordinates
  fill @ref "text"          Clear + type  (macOS: --focus-guard)
  select @ref "value"       Select dropdown (web)
  press <key>               Keyboard key
  screenshot [path]         Save PNG (macOS: requires --app, or --full for full-screen)
  open <url>                Navigate (web)
  swipe <dir>               Swipe (iOS/Android)
  close                     Close browser (web)
  console [level] [N]       Show console/system logs

macOS shortcuts (top-level):
  virtual-cursor start|move|hide|stop|status    Lavender 虚拟光标 (别名 vcursor)

Subcommands:
  doctor  [-p <plat>]                            Environment check (now covers iOS real-device)
  shot    [path.png] [--real|--sim|--macos]      Quick screenshot (auto-picks best backend)
  auto    -p <plat> --goal "..." [--url <url>]   LLM-driven goal loop
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
  agent-control doctor -p ios
  agent-control shot                                     # auto: sim > real > err
  agent-control shot --real /tmp/x.png                   # force real device
  agent-control shot --macos --app Finder                # macOS app window
  agent-control shot --full /tmp/desktop.png             # macOS full screen
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
