#!/usr/bin/env node
/**
 * agent-control Android Driver — adb + uiautomator2
 *
 * Commands:
 *   snapshot [-i]           UI element tree (JSON)
 *   tap @ref | x y          Tap element or coordinates
 *   fill @ref "text"        Clear + type text into element
 *   swipe dir [amount]      Swipe up/down/left/right
 *   press key               Press key (home/back/enter/...)
 *   screenshot [path]       Capture screen
 *   open <package>          Launch app by package name
 *   shell <cmd>             Run adb shell command
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERIAL = process.env.ANDROID_SERIAL || null;
const SNAP_CACHE = '/tmp/agent-control-android-snap.json';

// Cache last snapshot so tap/fill don't re-dump
let _cachedElements = null;
function loadSnapCache() { try { return JSON.parse(fs.readFileSync(SNAP_CACHE, 'utf8')); } catch { return null; } }
function saveSnapCache(els) { try { fs.writeFileSync(SNAP_CACHE, JSON.stringify(els)); } catch {} }

function adb(args, opts = {}) {
  const cmd = SERIAL ? `adb -s ${SERIAL} ${args}` : `adb ${args}`;
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: opts.timeout || 30000, stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
  } catch (e) {
    return e.stdout?.trim() || e.message;
  }
}

function getSerial() {
  if (SERIAL) return SERIAL;
  const out = adb('devices');
  const lines = out.split('\n').slice(1).filter(l => l.includes('device') && !l.includes('offline'));
  if (lines.length === 0) return null;
  return lines[0].split('\t')[0];
}

// ── Snapshot: parse uiautomator dump ──
function snapshot(interactiveOnly) {
  const serial = getSerial();
  if (!serial) return { ok: false, error: 'no device connected' };

  // Dump UI hierarchy — exec-out to stdout (faster than dump+pull)
  const DUMP_PATH = '/proc/self/fd/1';
  let xml = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      xml = execSync(`adb ${SERIAL ? `-s ${SERIAL} ` : ''}exec-out "uiautomator dump ${DUMP_PATH} 2>/dev/null"`,
        { encoding: 'utf8', timeout: 15000 }).trim();
    } catch {}
    if (xml.includes('<node')) break;
    spawnSync('sleep', ['2']);
  }
  if (!xml.includes('<node')) {
    return { ok: false, error: 'uiautomator dump failed after 3 attempts' };
  }

  // Parse XML — extract all node tags (both self-closing and opening)
  const elements = [];
  const nodeRegex = /<node\s+([^>]+?)(?:\/>|>)/g;
  let match;
  let counter = 0;

  while ((match = nodeRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const get = (name) => {
      const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
      return m ? m[1] : '';
    };

    const cls = get('class');
    const text = get('text');
    const desc = get('content-desc');
    const resId = get('resource-id');
    const clickable = get('clickable') === 'true';
    const focusable = get('focusable') === 'true';
    const enabled = get('enabled') === 'true';
    const bounds = get('bounds');

    // Parse bounds "[x1,y1][x2,y2]"
    const bm = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!bm) continue;
    const [, x1, y1, x2, y2] = bm.map(Number);
    const w = x2 - x1, h = y2 - y1;
    if (w === 0 && h === 0) continue;

    const isInteractive = clickable || (focusable && enabled);
    if (interactiveOnly && !isInteractive && !text && !desc) continue;

    counter++;
    const role = cls.split('.').pop() || cls;
    const x = x1, y = y1;
    const cx = Math.round(x1 + w / 2);
    const cy = Math.round(y1 + h / 2);
    elements.push({
      ref: `e${counter}`,
      role,
      class: cls,
      label: text || desc || '',
      text: text || desc || '',  // alias for backward compat
      resourceId: resId,
      interactive: isInteractive,
      clickable, focusable, enabled,
      frame: { x, y, w, h },
      // Keep flat coords for internal tap use
      cx, cy,
    });
  }

  _cachedElements = elements;
  saveSnapCache(elements);
  return elements;
}

function findElement(ref, elements) {
  // Normalize: accept both "@e3" and "e3"
  const normalized = ref.startsWith('@') ? ref.slice(1) : ref;
  if (!elements) elements = _cachedElements || loadSnapCache() || snapshot(false);
  if (Array.isArray(elements)) {
    return elements.find(e => e.ref === normalized) || null;
  }
  return null;
}

// ── Commands ──
// Helper: detect ref arg (both "@e3" and "e3")
function isRefArg(a) { return a && (/^@e\d+$/.test(a) || /^e\d+$/.test(a)); }

function run(args) {
  const cmd = args[0];
  if (!cmd) return { ok: false, error: 'no command' };

  const serial = getSerial();
  if (!serial && cmd !== 'devices') return { ok: false, error: 'no Android device connected. Start emulator or connect device.' };

  switch (cmd) {
    case 'snapshot': {
      const interactive = args.includes('-i') || args.includes('--interactive');
      return snapshot(interactive);
    }

    case 'tap': case 'click': {
      const ref = args.find(isRefArg);
      if (ref) {
        const el = findElement(ref);
        if (!el) return { ok: false, error: `element ${ref} not found` };
        adb(`shell input tap ${el.cx} ${el.cy}`);
        return { ok: true, action: 'tap', ref, x: el.cx, y: el.cy };
      }
      const x = parseInt(args[1]), y = parseInt(args[2]);
      if (isNaN(x) || isNaN(y)) return { ok: false, error: 'usage: tap @ref | tap x y' };
      adb(`shell input tap ${x} ${y}`);
      return { ok: true, action: 'tap', x, y };
    }

    case 'longtap': case 'longpress': {
      const ref = args.find(isRefArg);
      if (ref) {
        const el = findElement(ref);
        if (!el) return { ok: false, error: `element ${ref} not found` };
        adb(`shell input swipe ${el.cx} ${el.cy} ${el.cx} ${el.cy} 1000`);
        return { ok: true, action: 'longtap', ref };
      }
      return { ok: false, error: 'usage: longtap @ref' };
    }

    case 'fill': case 'type': {
      const ref = args.find(isRefArg);
      const text = args.slice(args.indexOf(ref) + 1).join(' ');
      if (!ref || !text) return { ok: false, error: 'usage: fill @ref text' };
      const el = findElement(ref);
      if (!el) return { ok: false, error: `element ${ref} not found` };
      // Tap to focus
      adb(`shell input tap ${el.cx} ${el.cy}`);
      // Clear existing text — select all then delete
      adb('shell input keyevent KEYCODE_MOVE_END');
      adb('shell input keyevent --longpress KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL');
      // Type new text (escape spaces)
      const escaped = text.replace(/ /g, '%s').replace(/'/g, "\\'");
      adb(`shell input text "${escaped}"`);
      return { ok: true, action: 'fill', ref, value: text };
    }

    case 'drag': {
      const nums = args.slice(1).filter(a => /^\d+$/.test(a));
      if (nums.length < 4) return { ok: false, error: 'usage: drag x1 y1 x2 y2 [durationMs]' };
      const [x1, y1, x2, y2] = nums.slice(0, 4).map(Number);
      const dur = nums[4] ? parseInt(nums[4]) : 500;
      adb(`shell input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`);
      return { ok: true, action: 'drag', from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
    }

    case 'swipe': {
      const dir = args[1] || 'up';
      const amount = parseInt(args[2]) || 900;
      const cx = 540, cy = 1110; // center of typical screen
      const map = {
        up: [cx, cy + amount / 2, cx, cy - amount / 2],
        down: [cx, cy - amount / 2, cx, cy + amount / 2],
        left: [cx + amount / 2, cy, cx - amount / 2, cy],
        right: [cx - amount / 2, cy, cx + amount / 2, cy],
      };
      const [x1, y1, x2, y2] = map[dir] || map.up;
      adb(`shell input swipe ${x1} ${y1} ${x2} ${y2} 300`);
      return { ok: true, action: 'swipe', direction: dir, amount };
    }

    case 'press': case 'key': {
      const key = args[1];
      if (!key) return { ok: false, error: 'usage: press <key>' };
      const keyMap = {
        home: 'KEYCODE_HOME', back: 'KEYCODE_BACK', enter: 'KEYCODE_ENTER',
        tab: 'KEYCODE_TAB', escape: 'KEYCODE_ESCAPE', delete: 'KEYCODE_DEL',
        menu: 'KEYCODE_MENU', search: 'KEYCODE_SEARCH',
        volumeup: 'KEYCODE_VOLUME_UP', volumedown: 'KEYCODE_VOLUME_DOWN',
        power: 'KEYCODE_POWER', camera: 'KEYCODE_CAMERA',
        recent: 'KEYCODE_APP_SWITCH',
      };
      const keycode = keyMap[key.toLowerCase()] || `KEYCODE_${key.toUpperCase()}`;
      adb(`shell input keyevent ${keycode}`);
      return { ok: true, action: 'press', key: keycode };
    }

    case 'screenshot': {
      const outPath = args[1] || '/tmp/agent-control-android.png';
      adb('shell screencap -p /sdcard/screenshot.png');
      // adb pull writes to stderr, use spawnSync to capture properly
      spawnSync('adb', [...(SERIAL ? ['-s', SERIAL] : []), 'pull', '/sdcard/screenshot.png', outPath], { stdio: 'pipe', timeout: 15000 });
      try { fs.statSync(outPath); return { ok: true, path: outPath }; } catch { return { ok: false, error: 'screenshot failed' }; }
    }

    case 'open': case 'launch': {
      const pkg = args[1];
      if (!pkg) return { ok: false, error: 'usage: open <package.name>' };
      adb(`shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
      return { ok: true, action: 'open', package: pkg };
    }

    case 'shell': {
      const shellCmd = args.slice(1).join(' ');
      const out = adb(`shell ${shellCmd}`);
      return { ok: true, output: out };
    }

    case 'devices': {
      const out = adb('devices');
      return { ok: true, output: out };
    }

    default:
      return { ok: false, error: `unknown command '${cmd}'` };
  }
}

// ── Main ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const result = run(args);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { run, snapshot, findElement };
