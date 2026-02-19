#!/usr/bin/env node
/**
 * agent-control iOS Driver — idb (pure), no macOS AX hack
 */
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');

function getBootedUDID() {
  try {
    const out = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
    const data = JSON.parse(out);
    for (const [, devices] of Object.entries(data.devices))
      for (const d of devices) if (d.state === 'Booted') return { udid: d.udid, name: d.name };
  } catch {}
  return null;
}

const device = getBootedUDID();
if (!device) { console.log(JSON.stringify({ ok: false, error: 'no booted simulator found' })); process.exit(1); }
const UDID = device.udid;

const INTERACTIVE_ROLES = new Set([
  'AXButton', 'AXTextField', 'AXTextView', 'AXSwitch', 'AXSlider',
  'AXLink', 'AXTab', 'AXSegmentedControl', 'AXSearchField',
  'AXPopUpButton', 'AXComboBox', 'AXCheckBox',
]);

const SNAP_CACHE = '/tmp/agent-control-ios-snap.json';
function loadCache() { try { return JSON.parse(fs.readFileSync(SNAP_CACHE, 'utf8')); } catch { return null; } }
function saveCache(els) { try { fs.writeFileSync(SNAP_CACHE, JSON.stringify(els)); } catch {} }

function idb(...args) {
  return spawnSync('idb', [...args, '--udid', UDID], { encoding: 'utf8', timeout: 15000 });
}

function snapshot(interactiveOnly) {
  const r = idb('ui', 'describe-all');
  if (!r.stdout) return [];
  let raw; try { raw = JSON.parse(r.stdout); } catch { return []; }

  const els = []; let c = 0;
  for (const item of raw) {
    const role = item.role || item.type || 'unknown';
    const isInteractive = INTERACTIVE_ROLES.has(role) || INTERACTIVE_ROLES.has('AX' + item.type);
    if (interactiveOnly && !isInteractive) continue;
    const f = item.frame || {};
    if ((f.width || 0) < 3 && (f.height || 0) < 3) continue;
    c++;
    els.push({
      ref: `@e${c}`, role: (item.type || role).replace(/^AX/, ''),
      label: item.AXLabel || '', value: item.AXValue || null,
      frame: { x: Math.round(f.x || 0), y: Math.round(f.y || 0), w: Math.round(f.width || 0), h: Math.round(f.height || 0) },
      interactive: isInteractive,
    });
  }
  saveCache(els);
  return interactiveOnly ? els.filter(e => e.interactive) : els;
}

function findEl(ref) {
  const cached = loadCache();
  const el = (cached || []).find(e => e.ref === ref);
  if (el) return el;
  const fresh = snapshot(false);
  return fresh.find(e => e.ref === ref) || null;
}

function center(el) { return { x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 }; }

function tap(x, y) { return idb('ui', 'tap', String(Math.round(x)), String(Math.round(y))).status === 0; }

function tapRef(ref) {
  const el = findEl(ref);
  if (!el) return { ok: false, error: `${ref} not found` };
  const p = center(el);
  return tap(p.x, p.y) ? { ok: true, action: 'tap', ref } : { ok: false, error: 'tap failed' };
}

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(`agent-control-ios — idb driver\nDevice: ${device.name} (${UDID})`);
  process.exit(0);
}

let result;
try {
  switch (cmd) {
    case 'snapshot': result = snapshot(args.includes('-i')); break;
    case 'tap': case 'click': result = tapRef(args[1]); break;
    case 'fill': {
      const r = tapRef(args[1]);
      if (!r.ok) { result = r; break; }
      idb('ui', 'text', args.slice(2).join(' '));
      result = { ok: true, action: 'fill', ref: args[1] };
      break;
    }
    case 'type': { idb('ui', 'text', args.slice(1).join(' ')); result = { ok: true, action: 'type' }; break; }
    case 'swipe': case 'scroll': {
      const dir = args[1] || 'down';
      const cx = 220, cy = 478, d = 300;
      const map = { up: [cx, cy+d/2, cx, cy-d/2], down: [cx, cy-d/2, cx, cy+d/2], left: [cx+d/2, cy, cx-d/2, cy], right: [cx-d/2, cy, cx+d/2, cy] };
      const [sx, sy, ex, ey] = map[dir] || map.down;
      idb('ui', 'swipe', String(sx), String(sy), String(ex), String(ey), '--duration', '0.5');
      result = { ok: true, action: 'swipe', direction: dir };
      break;
    }
    case 'screenshot': {
      const p = args[1] || '/tmp/agent-control-ios.png';
      const ok = spawnSync('xcrun', ['simctl', 'io', UDID, 'screenshot', p], { timeout: 10000 }).status === 0;
      result = ok ? { ok: true, path: p } : { ok: false, error: 'screenshot failed' };
      break;
    }
    case 'press': {
      const map = { home: 'HOME', lock: 'LOCK', siri: 'SIRI' };
      const btn = map[(args[1] || '').toLowerCase()];
      if (!btn) { result = { ok: false, error: `unknown button: ${args[1]}` }; break; }
      idb('ui', 'button', btn);
      result = { ok: true, action: 'press', button: args[1] };
      break;
    }
    case 'open': {
      spawnSync('xcrun', ['simctl', 'openurl', 'booted', args[1]], { timeout: 10000 });
      result = { ok: true, action: 'open', url: args[1] };
      break;
    }
    default: result = { ok: false, error: `unknown command '${cmd}'` };
  }
} catch (err) { result = { ok: false, error: err.message }; }
console.log(JSON.stringify(result, null, 2));
