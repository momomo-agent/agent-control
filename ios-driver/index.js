#!/usr/bin/env node
/**
 * agent-control iOS Driver — idb + simctl 包装，统一协议接口
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Find booted simulator ──
function getBootedUDID() {
  try {
    const out = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
    const data = JSON.parse(out);
    for (const [, devices] of Object.entries(data.devices)) {
      for (const d of devices) {
        if (d.state === 'Booted') return { udid: d.udid, name: d.name };
      }
    }
  } catch {}
  return null;
}

const device = getBootedUDID();
if (!device) {
  console.error(JSON.stringify({ ok: false, error: 'no booted simulator found' }));
  process.exit(1);
}
const UDID = device.udid;

// ── Snapshot cache (avoid 5s re-dump on tap/fill) ──
let _cachedElements = null;
let _cacheTime = 0;
const CACHE_TTL = 10000; // 10s

function snapshot(interactiveOnly) {
  if (_cachedElements && (Date.now() - _cacheTime < CACHE_TTL)) {
    return interactiveOnly ? _cachedElements.filter(e => e.interactive) : _cachedElements;
  }
  const r = spawnSync('idb', ['ui', 'describe-all', '--udid', UDID], {
    encoding: 'utf8', timeout: 15000,
  });
  if (!r.stdout) return [];

  let raw;
  try { raw = JSON.parse(r.stdout); } catch { return []; }

  const interactiveRoles = new Set([
    'AXButton', 'AXTextField', 'AXTextView', 'AXSwitch',
    'AXSlider', 'AXLink', 'AXTab', 'AXSegmentedControl',
    'AXSearchField', 'AXPopUpButton', 'AXComboBox', 'AXCheckBox',
  ]);

  const elements = [];
  let counter = 0;

  for (const item of raw) {
    const role = item.role || item.type || 'unknown';
    const isInteractive = interactiveRoles.has(role) || interactiveRoles.has('AX' + item.type);
    if (interactiveOnly && !isInteractive) continue;

    const f = item.frame || {};
    if ((f.width || 0) < 3 && (f.height || 0) < 3) continue;

    counter++;
    elements.push({
      ref: `@e${counter}`,
      role: (item.type || role).replace(/^AX/, ''),
      label: item.AXLabel || '',
      value: item.AXValue || null,
      frame: {
        x: Math.round(f.x || 0),
        y: Math.round(f.y || 0),
        w: Math.round(f.width || 0),
        h: Math.round(f.height || 0),
      },
      interactive: isInteractive,
    });
  }
  _cachedElements = elements;
  _cacheTime = Date.now();
  return interactiveOnly ? elements.filter(e => e.interactive) : elements;
}

// ── Resolve ref ──
function refToPoint(ref, elements) {
  const el = elements.find(e => e.ref === ref);
  if (!el) return null;
  return { x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 };
}

// ── Simulator window tap via macOS AX (most reliable on iOS 26+) ──
function getSimPID() {
  try {
    return execSync('pgrep -x Simulator', { encoding: 'utf8', timeout: 2000 }).trim().split('\n')[0];
  } catch { return null; }
}

function tapViaMacOSDriver(ref) {
  const simPID = getSimPID();
  if (!simPID) return false;
  const macBin = path.join(__dirname, '..', 'macos-driver', '.build', 'debug', 'agent-control');
  if (!fs.existsSync(macBin)) return false;
  const r = spawnSync(macBin, ['click', ref, '--pid', simPID], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0;
}

function snapshotViaMacOS(interactiveOnly) {
  const simPID = getSimPID();
  if (!simPID) return null;
  // Activate Simulator to ensure AX tree has app content
  try { execSync('osascript -e \'tell application "Simulator" to activate\'', { timeout: 3000 }); } catch {}
  const macBin = path.join(__dirname, '..', 'macos-driver', '.build', 'debug', 'agent-control');
  if (!fs.existsSync(macBin)) return null;

  function doSnap() {
    const a = interactiveOnly ? ['snapshot', '-i', '--pid', simPID] : ['snapshot', '--pid', simPID];
    const r = spawnSync(macBin, a, { encoding: 'utf8', timeout: 15000 });
    try {
      const els = JSON.parse(r.stdout);
      const chromeLabels = ['Action', 'Volume Up', 'Volume Down', 'Sleep/Wake', 'Ring/Silent', 'Home', 'Save Screen', 'Rotate'];
      const filtered = els.filter(e => !chromeLabels.includes(e.label));
      return filtered.map((e, i) => ({ ...e, _macRef: e.ref, ref: `@e${i + 1}` }));
    } catch { return []; }
  }

  let result = doSnap();
  // Retry once if too few elements (focus may not have switched)
  if (result.length < 3) {
    spawnSync('sleep', ['0.5']);
    try { execSync('osascript -e \'tell application "Simulator" to activate\'', { timeout: 3000 }); } catch {}
    result = doSnap();
  }
  return result.length > 0 ? result : null;
}

// Map iOS @ref back to macOS @ref for tap (persisted across CLI calls)
const MAC_SNAP_FILE = '/tmp/agent-control-ios-macsnap.json';
function loadMacSnap() { try { return JSON.parse(fs.readFileSync(MAC_SNAP_FILE, 'utf8')); } catch { return null; } }
function saveMacSnap(snap) { try { fs.writeFileSync(MAC_SNAP_FILE, JSON.stringify(snap)); } catch {} }
let _lastMacSnap = loadMacSnap();

// ── Actions ──
function tap(x, y) {
  // idb tap (may not work on iOS 26+)
  return spawnSync('idb', ['ui', 'tap', String(Math.round(x)), String(Math.round(y)), '--udid', UDID],
    { encoding: 'utf8', timeout: 5000 }).status === 0;
}

function tapByRef(ref) {
  // Look up macOS ref from last snapshot
  if (_lastMacSnap) {
    const el = _lastMacSnap.find(e => e.ref === ref);
    if (el && el._macRef && tapViaMacOSDriver(el._macRef)) return true;
  }
  // Fallback: idb coordinate tap
  const els = snapshot(false);
  const pt = refToPoint(ref, els);
  if (!pt) return false;
  return tap(pt.x, pt.y);
}

function typeText(text) {
  return spawnSync('idb', ['ui', 'text', text, '--udid', UDID],
    { encoding: 'utf8', timeout: 5000 }).status === 0;
}

function swipe(direction) {
  const w = 393, h = 852, cx = w / 2, cy = h / 2, d = 300;
  const dirs = {
    up:    [cx, cy + d/2, cx, cy - d/2],
    down:  [cx, cy - d/2, cx, cy + d/2],
    left:  [cx + d/2, cy, cx - d/2, cy],
    right: [cx - d/2, cy, cx + d/2, cy],
  };
  const [sx, sy, ex, ey] = dirs[direction] || dirs.down;
  return spawnSync('idb', ['ui', 'swipe', String(sx), String(sy), String(ex), String(ey),
    '--duration', '0.5', '--udid', UDID], { encoding: 'utf8', timeout: 10000 }).status === 0;
}

function screenshotFn(outputPath) {
  return spawnSync('xcrun', ['simctl', 'io', UDID, 'screenshot', outputPath],
    { encoding: 'utf8', timeout: 10000 }).status === 0;
}

// ── CLI ──
const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(`agent-control-ios — iOS Driver (idb + simctl)

Usage:
  snapshot [-i]              Get elements
  tap @ref                   Tap element
  fill @ref "text"           Tap + type text
  press <home|lock>          Hardware button
  swipe <up|down|left|right> Swipe gesture
  screenshot [path]          Screenshot

Device: ${device.name} (${UDID})`);
  process.exit(0);
}

let result;
try {
  switch (cmd) {
    case 'snapshot': {
      const macSnap = snapshotViaMacOS(args.includes('-i'));
      if (macSnap && macSnap.length > 0) {
        _lastMacSnap = macSnap;
        saveMacSnap(macSnap);
        result = macSnap;
      } else {
        result = snapshot(args.includes('-i'));
      }
      break;
    }
    case 'tap': case 'click': {
      if (tapByRef(args[1])) {
        result = { ok: true, action: 'tap', ref: args[1] };
        _cachedElements = null;
        _lastMacSnap = null;
        break;
      }
      const els = snapshot(false);
      const pt = refToPoint(args[1], els);
      if (!pt) { result = { ok: false, error: `${args[1]} not found` }; break; }
      result = { ok: tap(pt.x, pt.y), action: 'tap', ref: args[1] };
      _cachedElements = null; // invalidate after interaction
      break;
    }
    case 'fill': {
      const els = snapshot(false);
      const pt = refToPoint(args[1], els);
      if (!pt) { result = { ok: false, error: `${args[1]} not found` }; break; }
      tap(pt.x, pt.y);
      typeText(args.slice(2).join(' '));
      result = { ok: true, action: 'fill', ref: args[1] };
      _cachedElements = null;
      break;
    }
    case 'type': {
      typeText(args.slice(1).join(' '));
      result = { ok: true, action: 'type' };
      break;
    }
    case 'swipe': case 'scroll': {
      result = { ok: swipe(args[1] || 'down'), action: 'swipe', ref: args[1] };
      break;
    }
    case 'screenshot': {
      const p = args[1] || '/tmp/agent-control-ios.png';
      result = screenshotFn(p) ? { ok: true, path: p } : { ok: false, error: 'failed' };
      break;
    }
    case 'press': {
      const btn = (args[1] || '').toUpperCase();
      const map = { HOME: 'HOME', LOCK: 'LOCK', SIRI: 'SIRI', 'APPLE_PAY': 'APPLE_PAY' };
      const idbBtn = map[btn];
      if (!idbBtn) { result = { ok: false, error: `unknown button: ${args[1]}` }; break; }
      const r = spawnSync('idb', ['ui', 'button', idbBtn, '--udid', UDID], { encoding: 'utf8', timeout: 10000 });
      result = { ok: r.status === 0, action: 'press', button: btn };
      _cachedElements = null;
      break;
    }
    default:
      result = { ok: false, error: `unknown command '${cmd}'` };
  }
} catch (err) {
  result = { ok: false, error: err.message };
}

console.log(JSON.stringify(result, null, 2));
