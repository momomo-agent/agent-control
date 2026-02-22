#!/usr/bin/env node
/**
 * doctor.js — 环境自检，fail-fast + 修复指令
 *
 * Usage:
 *   node doctor.js [--platform web|macos|ios|all]
 */

const { execSync, spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const platform = args.includes('-p') ? args[args.indexOf('-p') + 1]
  : args.includes('--platform') ? args[args.indexOf('--platform') + 1] : 'all';

const checks = [];

function check(name, platform, fn) {
  checks.push({ name, platform, fn });
}

function run(cmd, timeout = 5000) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return null; }
}

// ── Common ──
check('Node.js >= 18', 'all', () => {
  const v = process.version.match(/v(\d+)/);
  if (!v || parseInt(v[1]) < 18) return { ok: false, fix: 'Install Node.js >= 18: https://nodejs.org' };
  return { ok: true, detail: process.version };
});

check('OS', 'all', () => {
  return { ok: true, detail: `${os.platform()} ${os.arch()} ${os.release()}` };
});

check('Screen resolution', 'all', () => {
  if (os.platform() !== 'darwin') return { ok: true, detail: 'skip (non-macOS)' };
  const out = run("system_profiler SPDisplaysDataType 2>/dev/null | grep Resolution | head -1");
  return { ok: true, detail: out || 'unknown' };
});

// ── Web ──
check('Playwright installed', 'web', () => {
  try {
    require.resolve('playwright');
    return { ok: true };
  } catch {
    return { ok: false, fix: 'npm install playwright' };
  }
});

check('Chromium binary', 'web', () => {
  try {
    const pw = require('playwright');
    if (pw.chromium?.executablePath()) return { ok: true };
  } catch {}
  return { ok: false, fix: 'npx playwright install chromium' };
});

// ── macOS ──
check('Accessibility permission', 'macos', () => {
  if (os.platform() !== 'darwin') return { ok: true, detail: 'skip' };
  const bin = path.join(__dirname, 'macos-driver', '.build', 'debug', 'agent-control');
  if (!fs.existsSync(bin)) return { ok: false, fix: 'cd macos-driver && swift build' };
  const r = spawnSync(bin, ['snapshot', '-i'], { encoding: 'utf8', timeout: 5000 });
  if (r.stderr && r.stderr.includes('not trusted')) {
    return { ok: false, fix: 'System Settings → Privacy & Security → Accessibility → add Terminal/iTerm' };
  }
  return { ok: true };
});

check('macOS driver binary', 'macos', () => {
  const bin = path.join(__dirname, 'macos-driver', '.build', 'debug', 'agent-control');
  if (fs.existsSync(bin)) return { ok: true, detail: bin };
  return { ok: false, fix: 'cd macos-driver && swift build' };
});

check('Screen Recording permission', 'macos', () => {
  if (os.platform() !== 'darwin') return { ok: true, detail: 'skip' };
  const out = run("screencapture -x /tmp/doctor-test.png 2>&1");
  if (fs.existsSync('/tmp/doctor-test.png')) {
    try { fs.unlinkSync('/tmp/doctor-test.png'); } catch {}
    return { ok: true };
  }
  return { ok: false, fix: 'System Settings → Privacy & Security → Screen Recording → add Terminal/iTerm' };
});

// ── iOS ──
check('idb installed', 'ios', () => {
  const out = run('which idb');
  if (out) return { ok: true, detail: out };
  return { ok: false, fix: 'brew install idb-companion && pip install fb-idb' };
});

check('Booted simulator', 'ios', () => {
  const out = run('xcrun simctl list devices booted -j');
  if (!out) return { ok: false, fix: 'Open Xcode → Window → Devices and Simulators → boot a simulator' };
  try {
    const data = JSON.parse(out);
    for (const [, devs] of Object.entries(data.devices)) {
      for (const d of devs) {
        if (d.state === 'Booted') return { ok: true, detail: `${d.name} (${d.udid.slice(0, 8)})` };
      }
    }
  } catch {}
  return { ok: false, fix: 'xcrun simctl boot "iPhone 16 Pro"' };
});

check('Xcode CLI tools', 'ios', () => {
  const out = run('xcode-select -p');
  if (out) return { ok: true, detail: out };
  return { ok: false, fix: 'xcode-select --install' };
});

// ── Run ──
const targets = platform === 'all' ? ['all', 'web', 'macos', 'ios'] : ['all', platform];
const relevant = checks.filter(c => targets.includes(c.platform));

console.log(`agent-control doctor (${platform})\n`);
let allOk = true;

for (const c of relevant) {
  const r = c.fn();
  const icon = r.ok ? '✅' : '❌';
  const detail = r.detail ? ` (${r.detail})` : '';
  console.log(`${icon} ${c.name}${detail}`);
  if (!r.ok) {
    console.log(`   Fix: ${r.fix}`);
    allOk = false;
  }
}

console.log(allOk ? '\nAll checks passed.' : '\nSome checks failed. Fix the issues above before running.');
process.exit(allOk ? 0 : 1);
