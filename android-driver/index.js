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
 *   screenshot @ref [path]  Element-scoped screenshot (crops full capture)
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
      ref: `@e${counter}`,
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
  // Normalize: ensure @eN format to match stored refs
  const normalized = ref.startsWith('@') ? ref : '@' + ref;
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
      const ref = args.find(a => /^@?e\d+$/.test(a));
      const outPath = args.find(a => a !== cmd && !/^@?e\d+$/.test(a) && !a.startsWith('-')) || '/tmp/agent-control-android.png';

      // Capture full screen into a temp location first
      const tmpHost = ref ? `/tmp/agent-control-android-full-${process.pid}.png` : outPath;
      adb('shell screencap -p /sdcard/screenshot.png');
      spawnSync('adb', [...(SERIAL ? ['-s', SERIAL] : []), 'pull', '/sdcard/screenshot.png', tmpHost], { stdio: 'pipe', timeout: 15000 });
      try { fs.statSync(tmpHost); } catch { return { ok: false, error: 'screenshot failed' }; }

      if (!ref) return { ok: true, path: tmpHost };

      // Element-scoped: crop the full capture using bounds (already in pixels)
      const el = findElement(ref, elements);
      if (!el || !el.frame) { try { fs.unlinkSync(tmpHost); } catch {}; return { ok: false, error: `element ${ref} not found` }; }
      const { x, y, w, h } = el.frame;
      if (w < 1 || h < 1) { try { fs.unlinkSync(tmpHost); } catch {}; return { ok: false, error: 'element has zero size' }; }
      // sips --cropOffset <Y> <X> -c <H> <W>
      const r = spawnSync('sips', ['--cropOffset', String(y), String(x), '-c', String(h), String(w), tmpHost, '--out', outPath], { stdio: 'pipe', timeout: 10000 });
      try { fs.unlinkSync(tmpHost); } catch {}
      if (r.status !== 0) return { ok: false, error: 'sips crop failed: ' + (r.stderr?.toString() || '').trim() };
      return { ok: true, path: outPath, ref, bbox: { x, y, w, h } };
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

    case 'activities': {
      // List running activities via dumpsys
      const out = adb('shell dumpsys activity activities');
      const activities = [];
      const lines = out.split('\n');
      for (const line of lines) {
        // Match "* TaskRecord{...}" and "Activities=[...]" patterns
        const actMatch = line.match(/\*\s+Hist\s+#\d+:\s+ActivityRecord\{[^}]+\s+(\S+\/\S+)\s/);
        if (actMatch) {
          const [pkg, activity] = actMatch[1].split('/');
          activities.push({ package: pkg, activity: activity.startsWith('.') ? pkg + activity : activity, raw: actMatch[1] });
        }
        // Also match "realActivity=com.example/.MainActivity"
        const realMatch = line.match(/realActivity=(\S+)/);
        if (realMatch && !activities.find(a => a.raw === realMatch[1])) {
          const [pkg, act] = realMatch[1].split('/');
          activities.push({ package: pkg, activity: act?.startsWith('.') ? pkg + act : (act || pkg), raw: realMatch[1] });
        }
      }
      // Get focused activity
      const focusOut = adb('shell dumpsys activity activities | grep mResumedActivity');
      let focused = null;
      const focusMatch = focusOut.match(/(\S+\/\S+)\s/);
      if (focusMatch) focused = focusMatch[1];
      return { ok: true, action: 'activities', focused, count: activities.length, activities };
    }

    case 'surfaces': {
      // List surfaces via dumpsys SurfaceFlinger
      const out = adb('shell dumpsys SurfaceFlinger --list');
      const surfaces = (out || '').split('\n').filter(l => l.trim()).map(l => l.trim());
      return { ok: true, action: 'surfaces', count: surfaces.length, surfaces };
    }

    case 'windows': {
      // List all visible windows (multi-window/split-screen/PiP/overlay)
      const out = adb('shell dumpsys window windows');
      const windows = [];
      const winRegex = /Window #(\d+) Window\{([0-9a-f]+) ([^\}]+)\}/g;
      let wm;
      while ((wm = winRegex.exec(out)) !== null) {
        const [, idx, hash, desc] = wm;
        // Extract package/activity from desc
        const parts = desc.trim().split(/\s+/);
        const name = parts[parts.length - 1] || desc;
        // Check visibility — look for mShownFrame or isVisible
        // Limit to current window block (up to next Window #)
        const nextWin = out.indexOf('Window #', wm.index + 10);
        const afterWin = out.slice(wm.index, nextWin > 0 ? nextWin : wm.index + 5000);
        // Android <15: mShownFrame=[x,y][w,h]  Android 15+: Frames: ... frame=[x,y][w,h]
        const shown = /mShownFrame=\[(\d+,\d+)\]\[(\d+,\d+)\]/.exec(afterWin)
          || /Frames:.*?frame=\[(\d+,\d+)\]\[(\d+,\d+)\]/.exec(afterWin);
        const visible = !afterWin.includes('isOnScreen=false');
        const frame = shown ? `[${shown[1]}][${shown[2]}]` : null;
        windows.push({ index: parseInt(idx), hash, name, frame, visible });
      }
      // Get focused window — mCurrentFocus is in `dumpsys window` (not `dumpsys window windows`)
      const focusOut = adb('shell dumpsys window | grep mCurrentFocus');
      const focusMatch = focusOut.match(/mCurrentFocus=Window\{([0-9a-f]+) ([^\}]+)\}/);
      const focused = focusMatch ? focusMatch[2].trim() : null;
      return { ok: true, action: 'windows', count: windows.length, focused, windows };
    }

    case 'tasks': {
      // List recent tasks/activity stacks
      const out = adb('shell dumpsys activity recents');
      const tasks = [];
      const taskRegex = /Task\{([0-9a-f]+) #(\d+).*?A=([^\s\}]+)/g;
      let tm;
      while ((tm = taskRegex.exec(out)) !== null) {
        tasks.push({ id: parseInt(tm[2]), affinity: tm[3], hash: tm[1] });
      }
      return { ok: true, action: 'tasks', count: tasks.length, tasks };
    }

    case 'start': {
      // Start specific activity: start com.example/.MainActivity
      const component = args[1];
      if (!component) return { ok: false, error: 'usage: start <package/activity>' };
      const out = adb(`shell am start -n ${component}`);
      const ok = !out.includes('Error');
      return ok ? { ok: true, action: 'start', component } : { ok: false, error: out };
    }

    case 'stop': case 'force-stop': {
      const pkg = args[1];
      if (!pkg) return { ok: false, error: 'usage: stop <package>' };
      adb(`shell am force-stop ${pkg}`);
      return { ok: true, action: 'stop', package: pkg };
    }

    case 'console': case 'logs': case 'logcat': {
      // adb logcat -d dumps buffered logs then exits
      const level = args.find(a => ['V','D','I','W','E','F','S','verbose','debug','info','warn','error','fatal','silent'].includes(a));
      const countArg = args.find(a => /^\d+$/.test(a));
      const limit = countArg ? parseInt(countArg) : 50;
      const doClear = args.includes('--clear') || args.includes('-c');
      const tag = args.find(a => a.startsWith('--tag='))?.slice(6);
      const pkg = args.find(a => a.startsWith('--package='))?.slice(10) || args.find(a => a.startsWith('--app='))?.slice(6);
      let logArgs = 'shell logcat -d -v time';
      if (tag) logArgs += ` -s ${tag}`;
      const raw = adb(logArgs, { timeout: 10000 });
      let lines = raw.split('\n').filter(l => l.trim());
      // Filter by level
      if (level) {
        const lvl = level[0].toUpperCase();
        lines = lines.filter(l => {
          const m = l.match(/^\d{2}-\d{2}\s+\S+\s+([VDIWEFS])\//);
          return m && m[1] === lvl;
        });
      }
      // Filter by package
      if (pkg) {
        lines = lines.filter(l => l.includes(pkg));
      }
      lines = lines.slice(-limit);
      if (doClear) adb('logcat -c');
      return { ok: true, action: 'console', count: lines.length, entries: lines };
    }

    case 'current': {
      // Get current foreground activity
      const out = adb('shell dumpsys activity activities | grep mResumedActivity');
      const match = out.match(/(\S+\/\S+)\s/);
      return match
        ? { ok: true, action: 'current', activity: match[1] }
        : { ok: false, error: 'no resumed activity found' };
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
