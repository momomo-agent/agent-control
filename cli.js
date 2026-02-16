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

// ── Parse --platform ──
let platform = null;
let driverArgs = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--platform' || args[i] === '-p') {
    platform = args[i + 1];
    i++;
  } else {
    driverArgs.push(args[i]);
  }
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
const drivers = {
  macos: () => {
    const bin = path.join(ROOT, 'macos-driver', '.build', 'debug', 'agent-control');
    const r = spawnSync(bin, driverArgs, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status || 0);
  },
  web: () => {
    const script = path.join(ROOT, 'web-driver', 'index.js');
    const r = spawnSync('node', [script, ...driverArgs], { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status || 0);
  },
  ios: () => {
    const script = path.join(ROOT, 'ios-driver', 'index.js');
    const r = spawnSync('node', [script, ...driverArgs], { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status || 0);
  },
  android: () => {
    const script = path.join(ROOT, 'android-driver', 'index.js');
    const r = spawnSync('node', [script, ...driverArgs], { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status || 0);
  },
};

if (!drivers[platform]) {
  console.error(JSON.stringify({ ok: false, error: `unknown platform '${platform}'. Use: macos, web, ios, android` }));
  process.exit(1);
}

if (driverArgs.length === 0 || driverArgs[0] === 'help' || driverArgs[0] === '--help') {
  console.log(`agent-control — AI 跨平台操作层

Usage:
  agent-control --platform <macos|web|ios|android> <command> [args...]
  agent-control -p macos snapshot -i
  agent-control -p web open example.com ';' snapshot -i
  agent-control -p ios tap @e1
  agent-control -p android screenshot out.png

Platforms:
  macos     macOS apps (Accessibility API)
  web       Web apps (Playwright)
  ios       iOS simulator (idb + simctl)
  android   Android device/emulator (adb + uiautomator2)

Commands (all platforms):
  snapshot [-i]           Get interactive elements
  click/tap @ref          Click/tap element
  fill @ref "text"        Input text
  screenshot [path]       Take screenshot
  press <key>             Press key/button
  scroll/swipe <dir>      Scroll or swipe
  drag @ref1 @ref2        Drag between elements

Web-only:
  open <url>              Navigate to URL
  close                   Close browser`);
  process.exit(0);
}

drivers[platform]();
