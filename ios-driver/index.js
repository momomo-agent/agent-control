#!/usr/bin/env node
/**
 * agent-control iOS Driver — idb + simctl 包装，统一协议接口
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');

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

// ── Snapshot ──
function snapshot(interactiveOnly) {
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
  return elements;
}

// ── Resolve ref ──
function refToPoint(ref, elements) {
  const el = elements.find(e => e.ref === ref);
  if (!el) return null;
  return { x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 };
}

// ── Actions ──
function tap(x, y) {
  return spawnSync('idb', ['ui', 'tap', String(Math.round(x)), String(Math.round(y)), '--udid', UDID],
    { encoding: 'utf8', timeout: 5000 }).status === 0;
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
      result = snapshot(args.includes('-i'));
      break;
    }
    case 'tap': case 'click': {
      const els = snapshot(false);
      const pt = refToPoint(args[1], els);
      if (!pt) { result = { ok: false, error: `${args[1]} not found` }; break; }
      result = { ok: tap(pt.x, pt.y), action: 'tap', ref: args[1] };
      break;
    }
    case 'fill': {
      const els = snapshot(false);
      const pt = refToPoint(args[1], els);
      if (!pt) { result = { ok: false, error: `${args[1]} not found` }; break; }
      tap(pt.x, pt.y);
      typeText(args.slice(2).join(' '));
      result = { ok: true, action: 'fill', ref: args[1] };
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
      const r = spawnSync('xcrun', ['simctl', 'io', UDID, 'enumerate'], { encoding: 'utf8' });
      result = { ok: false, error: 'press not yet implemented for simctl' };
      break;
    }
    default:
      result = { ok: false, error: `unknown command '${cmd}'` };
  }
} catch (err) {
  result = { ok: false, error: err.message };
}

console.log(JSON.stringify(result, null, 2));
