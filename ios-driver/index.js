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
      ref: `e${c}`, role: (item.type || role).replace(/^AX/, ''),
      label: item.AXLabel || '', value: item.AXValue || null,
      frame: { x: Math.round(f.x || 0), y: Math.round(f.y || 0), w: Math.round(f.width || 0), h: Math.round(f.height || 0) },
      interactive: isInteractive,
    });
  }
  saveCache(els);
  return interactiveOnly ? els.filter(e => e.interactive) : els;
}

function findEl(ref) {
  // Normalize: accept both "@e3" and "e3"
  const normalized = ref.startsWith('@') ? ref.slice(1) : ref;
  const cached = loadCache();
  const el = (cached || []).find(e => e.ref === normalized);
  if (el) return el;
  const fresh = snapshot(false);
  return fresh.find(e => e.ref === normalized) || null;
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

// Helper: detect ref arg (both "@e3" and "e3")
function isRefArg(a) { return a && (/^@e\d+$/.test(a) || /^e\d+$/.test(a)); }

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(`agent-control-ios — idb driver\nDevice: ${device.name} (${UDID})`);
  process.exit(0);
}

let result;
try {
  switch (cmd) {
    case 'snapshot': result = snapshot(args.includes('-i')); break;
    case 'tap': case 'click': {
      const ref = args.find(isRefArg);
      const nums = args.slice(1).filter(a => /^\d+$/.test(a));
      if (ref) { result = tapRef(ref); }
      else if (nums.length >= 2) {
        const ok = tap(parseInt(nums[0]), parseInt(nums[1]));
        result = ok ? { ok: true, action: 'tap', x: +nums[0], y: +nums[1] } : { ok: false, error: 'tap failed' };
      } else { result = { ok: false, error: 'usage: click @ref | click x y' }; }
      break;
    }
    case 'drag': {
      const nums = args.slice(1).filter(a => /^\d+$/.test(a));
      if (nums.length < 4) { result = { ok: false, error: 'usage: drag x1 y1 x2 y2' }; break; }
      const [x1, y1, x2, y2] = nums.slice(0, 4).map(Number);
      const ok = idb('ui', 'swipe', String(x1), String(y1), String(x2), String(y2), '--duration', '0.5').status === 0;
      result = ok ? { ok: true, action: 'drag', from: { x: x1, y: y1 }, to: { x: x2, y: y2 } } : { ok: false, error: 'drag failed' };
      break;
    }
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
      const amount = parseInt(args.find(a => a.startsWith('--amount='))?.split('=')[1]) || parseInt(args[2]) || 300;
      const cx = 220, cy = 478, d = amount;
      const map = { up: [cx, cy+d/2, cx, cy-d/2], down: [cx, cy-d/2, cx, cy+d/2], left: [cx+d/2, cy, cx-d/2, cy], right: [cx-d/2, cy, cx+d/2, cy] };
      const [sx, sy, ex, ey] = map[dir] || map.down;
      idb('ui', 'swipe', String(sx), String(sy), String(ex), String(ey), '--duration', '0.5');
      result = { ok: true, action: 'swipe', direction: dir, amount };
      break;
    }
    case 'screenshot': {
      const p = args[1] || '/tmp/agent-control-ios.png';
      const ok = spawnSync('xcrun', ['simctl', 'io', UDID, 'screenshot', p], { timeout: 10000 }).status === 0;
      result = ok ? { ok: true, path: p } : { ok: false, error: 'screenshot failed' };
      break;
    }
    case 'longpress': {
      const ref = args.find(isRefArg);
      const nums = args.slice(1).filter(a => /^\d+$/.test(a));
      const durationMs = parseFloat(args.find(a => a.startsWith('--duration='))?.split('=')[1]) || 1000;
      const duration = durationMs / 1000;
      let x, y;
      if (ref) {
        const el = findEl(ref);
        if (!el) { result = { ok: false, error: `${ref} not found` }; break; }
        const p = center(el);
        x = p.x; y = p.y;
      } else if (nums.length >= 2) {
        x = parseInt(nums[0]); y = parseInt(nums[1]);
      } else { result = { ok: false, error: 'usage: longpress @ref | longpress x y [--duration=1000]' }; break; }
      const ok = idb('ui', 'tap', String(Math.round(x)), String(Math.round(y)), '--duration', String(duration)).status === 0;
      result = ok ? { ok: true, action: 'longpress', x, y, duration } : { ok: false, error: 'longpress failed' };
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
