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

// ── Parse --platform and --enhanced ──
let platform = null;
let enhanced = false;
let pidArg = null;
let driverArgs = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--platform' || args[i] === '-p') {
    platform = args[i + 1]; i++;
  } else if (args[i] === '--enhanced' || args[i] === '-e') {
    enhanced = true;
  } else if (args[i] === '--pid') {
    pidArg = args[i + 1]; i++;
  } else {
    driverArgs.push(args[i]);
  }
}
// Append --pid after command for drivers that expect it
if (pidArg) driverArgs.push('--pid', pidArg);

// ── Subcommand shortcuts ──
if (driverArgs[0] === 'doctor') {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'doctor.js'), ...driverArgs.slice(1)], { stdio: 'inherit' });
  process.exit(r.status || 0);
}
if (driverArgs[0] === 'demo') {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'demo.js'), ...driverArgs.slice(1)], { stdio: 'inherit' });
  process.exit(r.status || 0);
}

// ── Auto-detect platform ──
if (!platform) {
  const cmd = driverArgs[0];
  if (cmd === 'open' || cmd === 'navigate' || cmd === 'goto') {
    platform = 'web';
  } else {
    platform = 'macos'; // default
  }
}

// ── Route to driver ──
const { enhance } = require('./snapshot-enhance');

function runDriver(cmd, args, timeout = 15000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] });
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
    process.exit(1);
  }

  if (!enhanced || driverArgs[0] !== 'snapshot') {
    if (out) process.stdout.write(out + '\n');
    if (err) process.stderr.write(err + '\n');
    process.exit(r.status || 0);
  }
  try {
    const els = JSON.parse(out);
    const arr = Array.isArray(els) ? els : Object.values(els);
    if (arr.length === 0) {
      console.log(JSON.stringify({ ok: false, error: 'no elements found', hint: platform === 'macos' ? 'Is --pid correct? Is the app in foreground?' : platform === 'ios' ? 'Is Simulator running? Try: open -a Simulator' : 'Did you open a URL first?' }, null, 2));
      process.exit(1);
    }
    const result = enhance(arr, { platform });
    console.log(JSON.stringify(result, null, 2));
  } catch { process.stdout.write(out + '\n'); }
  process.exit(r.status || 0);
}

const drivers = {
  macos: () => {
    const bin = path.join(ROOT, 'macos-driver', '.build', 'debug', 'agent-control');
    if (!require('fs').existsSync(bin)) {
      console.error('macOS driver not built. Run: cd macos-driver && swift build');
      process.exit(1);
    }
    maybeEnhance(runDriver(bin, driverArgs));
  },
  web: () => {
    const fs = require('fs');
    const STATE = '/tmp/agent-control-web.json';
    function daemonAlive() {
      try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); process.kill(s.pid, 0); return true; } catch { return false; }
    }
    if (!daemonAlive()) {
      // Start daemon in background
      const { spawn } = require('child_process');
      const script = path.join(ROOT, 'web-driver', 'index.js');
      const child = spawn('node', [script, 'open', 'about:blank'], {
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
        if (enhanced && driverArgs[0] === 'snapshot') {
          try {
            const els = JSON.parse(body);
            const arr = Array.isArray(els) ? els : Object.values(els);
            console.log(JSON.stringify(enhance(arr, { platform }), null, 2));
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
};

if (!drivers[platform]) {
  console.error(JSON.stringify({ ok: false, error: `unknown platform '${platform}'. Use: macos, web, ios, android` }));
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
if (subcommands[driverArgs[0]]) {
  const { spawnSync: ss } = require('child_process');
  const r = ss('node', [path.join(ROOT, subcommands[driverArgs[0]]), ...args.slice(args.indexOf(driverArgs[0]) + 1)], { stdio: 'inherit', encoding: 'utf8' });
  process.exit(r.status || 0);
}

if (driverArgs.length === 0 || driverArgs[0] === 'help' || driverArgs[0] === '--help') {
  console.log(`agent-control — Give AI hands.

Usage:
  agent-control -p <platform> [-e] [--pid <pid>] <command> [args...]
  agent-control <subcommand> [args...]

Platforms:
  web       Playwright (auto-starts daemon)
  macos     Accessibility API (--pid to target app)
  ios       Simulator via idb
  android   Emulator via uiautomator (experimental)

Driver commands:
  snapshot [-i] [-e]        See UI elements
  click @ref | x y          Click/tap
  drag @r1 @r2              Drag between refs or coordinates
  fill @ref "text"          Clear + type
  select @ref "value"       Select dropdown (web)
  press <key>               Keyboard key
  screenshot [path]         Save PNG
  open <url>                Navigate (web)
  swipe <dir>               Swipe (iOS/Android)
  close                     Close browser (web)

Subcommands:
  auto    -p <plat> --goal "..." [--url <url>]   LLM-driven goal loop
  doctor  [-p <plat>]                            Environment check
  run-all [--json]                               Run all flows
  goal    -p <plat> observe|act|act-observe ...  Step-by-step goal runner
  viewer                                         Open HTML report viewer

Options:
  -e, --enhanced    Filter interactive elements + semantic summary
  --pid <pid>       Target specific app (macOS)

Examples:
  agent-control doctor
  agent-control -p web open https://example.com
  agent-control -p web -e snapshot
  agent-control -p web click @e3
  agent-control auto -p web --goal "Sign up" --url https://example.com`);
  process.exit(0);
}

drivers[platform]();
