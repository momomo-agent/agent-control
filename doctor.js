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

// ── iOS (simulator) ──
check('idb installed', 'ios-sim', () => {
  const out = run('which idb');
  if (out) return { ok: true, detail: out };
  return { ok: false, fix: 'brew install idb-companion && pip install fb-idb' };
});

check('Booted simulator', 'ios-sim', () => {
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
  return { ok: false, soft: true, fix: 'xcrun simctl boot "iPhone 16 Pro"  (optional if only using real device)' };
});

check('Xcode CLI tools', 'ios-sim', () => {
  const out = run('xcode-select -p');
  if (out) return { ok: true, detail: out };
  return { ok: false, fix: 'xcode-select --install' };
});

// ── iOS (real device) ──
// Resolve python3 + pymobiledevice3. pip --user installs into ~/Library/Python/X.Y/,
// which often isn't on PATH but `python3 -m pymobiledevice3` still works.
function findPython() {
  const candidates = ['python3', '/opt/homebrew/bin/python3', '/usr/bin/python3'];
  const probe = [
    'import sys, importlib, importlib.metadata as m',
    'importlib.import_module("pymobiledevice3")',
    // importlib.metadata.version returns the dist version even when the pkg has no __version__.
    'v = ""',
    'try:\n    v = m.version("pymobiledevice3")\nexcept Exception:\n    v = "?"',
    'print(sys.executable + "|" + v)',
  ].join('\n');
  for (const py of candidates) {
    const r = spawnSync(py, ['-c', probe],
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe','pipe','pipe'] });
    if (r.status === 0 && r.stdout) return { py, info: r.stdout.trim() };
  }
  return null;
}

check('pymobiledevice3 (real device bridge)', 'ios-real', () => {
  const found = findPython();
  if (found) {
    const [execPath, version] = found.info.split('|');
    return { ok: true, detail: `v${version} via ${path.basename(execPath)}` };
  }
  return {
    ok: false,
    fix: 'python3 -m pip install --user pymobiledevice3  (real device support; skip if only using simulator)',
    soft: true,
  };
});

check('Connected real device', 'ios-real', () => {
  const found = findPython();
  if (!found) return { ok: false, soft: true, detail: 'skip (pymobiledevice3 missing)', fix: 'install pymobiledevice3 first' };
  const r = spawnSync(found.py, ['-m', 'pymobiledevice3', 'usbmux', 'list', '--no-color'],
    { encoding: 'utf8', timeout: 6000, stdio: ['pipe','pipe','pipe'] });
  const text = (r.stdout || '') + (r.stderr || '');
  // pymobiledevice3 prints a JSON-ish list; empty = "[]" or no Identifier lines.
  const hasDevice = /"Identifier"|"ConnectionType"|UniqueDeviceID/i.test(text);
  if (hasDevice) {
    // Try to extract device name / iOS version for detail.
    const infoR = spawnSync(found.py, ['-m', 'pymobiledevice3', 'lockdown', 'info', '--no-color'],
      { encoding: 'utf8', timeout: 8000, stdio: ['pipe','pipe','pipe'] });
    const info = infoR.stdout || '';
    const name = (info.match(/"DeviceName":\s*"([^"]+)"/) || [])[1] || '';
    const ver = (info.match(/"ProductVersion":\s*"([^"]+)"/) || [])[1] || '';
    const trust = /MobileDeviceDeveloperDisk|HasSiDP|Trusted|com\.apple\.mobile\.lockdown\.trust_agent/i.test(info);
    const detailBits = [name, ver && 'iOS ' + ver, trust ? 'trusted' : 'untrusted'].filter(Boolean);
    return { ok: true, detail: detailBits.join(' · ') };
  }
  // Device absent. Distinguish "daemon not talking" from "nothing plugged in".
  // usbmuxd on macOS is launchd-managed; presence of the socket is the real signal.
  const sockExists = run('test -S /var/run/usbmuxd && echo yes');
  if (!sockExists) {
    return {
      ok: false,
      soft: true,
      fix: 'macOS usbmuxd socket missing. Try: `sudo launchctl kickstart -k system/com.apple.usbmuxd` (usually needs a reboot)',
    };
  }
  return {
    ok: false,
    soft: true,
    fix: 'No iOS device detected. 1) Plug via USB-C/Lightning  2) Unlock phone + tap "Trust"  3) Re-run `agent-control doctor -p ios`',
  };
});

check('devicectl (Xcode real-device tooling)', 'ios-real', () => {
  const r = spawnSync('xcrun', ['devicectl', 'list', 'devices'], { encoding: 'utf8', timeout: 6000, stdio: ['pipe','pipe','pipe'] });
  if (r.status !== 0) {
    return { ok: false, soft: true, fix: 'Install Xcode (full, not just CLT) to enable `agent-control -p ios --real console` for real-device logs' };
  }
  const lines = (r.stdout || '').split('\n').filter(l => /connected|available/i.test(l));
  if (lines.length === 0) return { ok: true, detail: 'no device (ok if only using simulator)', soft: true };
  return { ok: true, detail: `${lines.length} device(s) known to devicectl` };
});

// ── Android ──
check('adb on PATH', 'android', () => {
  const out = run('which adb');
  if (out) return { ok: true, detail: out };
  return { ok: false, soft: true, fix: 'brew install --cask android-platform-tools  (or download from https://developer.android.com/tools/releases/platform-tools)' };
});

check('Connected Android device', 'android', () => {
  const out = run('adb devices 2>&1');
  if (!out) return { ok: false, soft: true, fix: 'No `adb`. Install platform-tools first.' };
  const lines = out.split('\n').slice(1)
    .filter(l => l.trim())
    .filter(l => /\bdevice\b/.test(l) && !l.includes('offline') && !l.includes('unauthorized'));
  const unauth = out.split('\n').some(l => l.includes('unauthorized'));
  if (unauth) return { ok: false, soft: true, fix: 'Unlock the phone and tap "Allow" on the USB debugging dialog.' };
  if (lines.length === 0) return {
    ok: false, soft: true,
    fix: 'Start an emulator (`emulator -avd <name>`) or plug in a device with USB debugging enabled.',
  };
  return { ok: true, detail: lines.map(l => l.split('\t')[0]).join(', ') };
});

// ── Electron ──
check('Electron CDP driver deps', 'electron', () => {
  try {
    require.resolve('ws');
    return { ok: true, detail: 'ws installed' };
  } catch {
    return { ok: false, fix: 'cd ' + __dirname + ' && npm install ws' };
  }
});

// ── Flutter ──
check('Dart VM Service hint', 'flutter', () => {
  const url = process.env.FLUTTER_VM_SERVICE_URL;
  if (url) return { ok: true, detail: url };
  return {
    ok: true,
    soft: true,
    detail: 'not set',
    fix: 'Export FLUTTER_VM_SERVICE_URL=ws://127.0.0.1:<port>/ws before running, or pass --vm-service ws://...',
  };
});

// ── Run ──
// Expand platform selection to include related sub-groups:
//   --platform ios  → check common + ios-sim + ios-real
//   --platform all  → everything
const ALL_GROUPS = ['all', 'web', 'macos', 'ios-sim', 'ios-real', 'android', 'electron', 'flutter'];
const PLATFORM_GROUPS = {
  all: ALL_GROUPS,
  web: ['all', 'web'],
  macos: ['all', 'macos'],
  ios: ['all', 'ios-sim', 'ios-real'],
  'ios-sim': ['all', 'ios-sim'],
  'ios-real': ['all', 'ios-real'],
  android: ['all', 'android'],
  electron: ['all', 'electron'],
  flutter: ['all', 'flutter'],
};
const targets = PLATFORM_GROUPS[platform] || ['all', platform];
const relevant = checks.filter(c => targets.includes(c.platform));

console.log(`agent-control doctor (${platform})\n`);
let hardFail = false;
let softFail = false;

let lastGroup = null;
for (const c of relevant) {
  // Print a small group header when the platform group changes
  if (c.platform !== lastGroup) {
    const groupLabel = {
      all: '— common',
      web: '— web',
      macos: '— macos',
      'ios-sim': '— iOS simulator',
      'ios-real': '— iOS real device',
      android: '— android',
      electron: '— electron',
      flutter: '— flutter',
    }[c.platform] || `— ${c.platform}`;
    console.log(`\n${groupLabel}`);
    lastGroup = c.platform;
  }

  const r = c.fn();
  const isSoft = r.soft === true;
  const icon = r.ok ? '✅' : (isSoft ? '⚠️ ' : '❌');
  const detail = r.detail ? ` (${r.detail})` : '';
  console.log(`${icon} ${c.name}${detail}`);
  if (!r.ok) {
    console.log(`   → ${r.fix}`);
    if (isSoft) softFail = true; else hardFail = true;
  }
}

if (!hardFail && !softFail) console.log('\nAll checks passed.');
else if (!hardFail && softFail) console.log('\nCore checks passed. Optional (⚠️ ) can be enabled later.');
else console.log('\nSome checks failed. Fix the issues above before running.');

// Soft failures don't break the exit code.
process.exit(hardFail ? 1 : 0);
