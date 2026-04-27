#!/usr/bin/env node
/**
 * agent-control iOS Driver — dual backend (Simulator + Real Device)
 *
 * Backend auto-detection:
 *   1. If --real flag or AGENT_CONTROL_IOS_REAL=1 → force real device
 *   2. If --sim flag → force simulator
 *   3. Auto: check booted simulator first, then real device
 *
 * Commands:
 *   snapshot [-i]                  UI element tree (JSON)
 *   tap @ref | x y                Tap element or coordinates
 *   fill @ref "text"              Clear + type text into element
 *   swipe dir [amount]            Swipe up/down/left/right
 *   press key                     Press button (home/lock/siri)
 *   screenshot [path]             Capture screen
 *   screenshot @ref [path]        Element-scoped screenshot (crops full capture)
 *   longpress @ref | x y          Long press
 *   drag x1 y1 x2 y2             Drag gesture
 *   open <url>                    Open URL in simulator
 *   launch <bundleId>             Launch app by bundle ID
 *   terminate <bundleId>          Terminate app
 *   windows                       List app windows/scenes
 *   screenshot --window <id>      Screenshot specific window/display
 *   list-apps                     List installed apps
 *
 * Real-device only:
 *   unlock                        Unlock device
 *   install <ipa>                 Install IPA
 *   uninstall <bundleId>          Uninstall app
 *   info                          Device info
 */
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const wda = require('./wda-backend');

const REAL_DEVICE_SCRIPT = path.join(__dirname, 'real-device.py');

// ── Backend detection ──

function getBootedUDID() {
  try {
    const out = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
    const data = JSON.parse(out);
    for (const [, devices] of Object.entries(data.devices))
      for (const d of devices) if (d.state === 'Booted') return { udid: d.udid, name: d.name };
  } catch {}
  return null;
}

function hasRealDevice() {
  try {
    const r = spawnSync('python3', [REAL_DEVICE_SCRIPT, 'detect'], {
      encoding: 'utf8', timeout: 8000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    if (r.status === 0 && r.stdout) {
      const d = JSON.parse(r.stdout);
      return d.ok && d.devices && d.devices.length > 0;
    }
  } catch {}
  return false;
}

// Parse --real / --sim flags (remove from args before passing to commands)
const rawArgs = process.argv.slice(2);
let forceReal = rawArgs.includes('--real') || process.env.AGENT_CONTROL_IOS_REAL === '1';
let forceSim = rawArgs.includes('--sim');
const filteredArgs = rawArgs.filter(a => a !== '--real' && a !== '--sim');

// Detect backend
let backend = 'simulator'; // default
let UDID = null;
let device = null;

if (forceReal) {
  backend = 'real';
} else if (forceSim) {
  device = getBootedUDID();
  if (!device) { console.log(JSON.stringify({ ok: false, error: 'no booted simulator (--sim forced)' })); process.exit(1); }
  UDID = device.udid;
} else {
  // Auto: try simulator first, then real device
  device = getBootedUDID();
  if (device) {
    UDID = device.udid;
    backend = 'simulator';
  } else if (hasRealDevice()) {
    backend = 'real';
  } else {
    console.log(JSON.stringify({ ok: false, error: 'no iOS device found (no booted simulator, no USB/WiFi real device)' }));
    process.exit(1);
  }
}

// ── Real device bridge ──

function realDevice(cmdArgs) {
  const r = spawnSync('python3', [REAL_DEVICE_SCRIPT, ...cmdArgs], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (r.status === 0 && r.stdout) {
    try { return JSON.parse(r.stdout); } catch {}
  }
  const errMsg = (r.stderr || '').trim();
  if (r.stdout) {
    try { return JSON.parse(r.stdout); } catch {}
  }
  return { ok: false, error: errMsg || 'real-device.py failed' };
}

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

function simctl(...args) {
  return spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: 15000 });
}

// ── Windows/Scenes ──

function listWindows() {
  // Use simctl io enumerate to list displays/windows
  const r = simctl('io', UDID, 'enumerate');
  if (r.status !== 0) return { ok: false, error: r.stderr?.trim() || 'enumerate failed' };
  const out = r.stdout || '';
  // Parse display info from enumerate output
  const displays = [];
  const lines = out.split('\n');
  let current = null;
  for (const line of lines) {
    // Match display/port entries
    const portMatch = line.match(/Port\s+(\S+)\s*(?:\((.+?)\))?/i);
    const displayMatch = line.match(/Display\s+(\d+)\s*(?:\((.+?)\))?/i);
    const idMatch = line.match(/UUID:\s*(\S+)/i);
    const nameMatch = line.match(/Name:\s*(.+)/i);
    if (portMatch || displayMatch) {
      if (current) displays.push(current);
      current = {
        id: (portMatch || displayMatch)[1],
        name: (portMatch || displayMatch)[2] || '',
        type: portMatch ? 'port' : 'display',
      };
    }
    if (current && idMatch) current.uuid = idMatch[1];
    if (current && nameMatch) current.name = nameMatch[1].trim();
  }
  if (current) displays.push(current);

  // Also try to get running app windows via accessibility
  // idb describe-all returns flat list — group by window if nested format available
  const nested = idb('ui', 'describe-all', '--nested');
  let windowCount = 1;
  if (nested.stdout) {
    try {
      const data = JSON.parse(nested.stdout);
      // Nested format has top-level windows
      if (Array.isArray(data)) {
        windowCount = data.filter(n => n.type === 'Window' || n.role === 'AXWindow').length || 1;
      }
    } catch {}
  }

  return {
    ok: true,
    action: 'windows',
    device: { name: device.name, udid: UDID },
    displays,
    windowCount,
  };
}

function listApps() {
  const r = idb('list-apps');
  if (r.status !== 0) return { ok: false, error: r.stderr?.trim() || 'list-apps failed' };
  const apps = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    // idb list-apps format: bundleId | name | install_type | architectures | ...
    const parts = line.split(' | ');
    if (parts.length >= 2) {
      apps.push({ bundleId: parts[0].trim(), name: parts[1].trim(), type: (parts[2] || '').trim() });
    }
  }
  return { ok: true, action: 'list-apps', count: apps.length, apps };
}

// ── Snapshot ──

function snapshot(interactiveOnly) {
  // Try WDA first (more reliable on iOS 26+)
  if (wda.isWdaRunning() || wda.startWda(UDID)) {
    const session = wda.ensureSession();
    if (session) {
      const src = wda.getSource(session.sessionId);
      if (src && src.length > 100) {
        const els = wda.parseSource(src);
        if (els.length > 0) {
          saveCache(els);
          return interactiveOnly ? els.filter(e => e.interactive) : els;
        }
      }
    }
  }

  // Fallback to idb
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
  // Normalize: ensure @eN format to match stored refs
  const normalized = ref.startsWith('@') ? ref : '@' + ref;
  const cached = loadCache();
  const el = (cached || []).find(e => e.ref === normalized);
  if (el) return el;
  const fresh = snapshot(false);
  return fresh.find(e => e.ref === normalized) || null;
}

function center(el) { return { x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 }; }

function tap(x, y) {
  // Try WDA first (works on iOS 26+), fall back to idb
  if (wda.isWdaRunning() || wda.startWda(UDID)) {
    const session = wda.ensureSession();
    if (session) {
      const r = wda.wdaRequestSync || require('./wda-backend').wdaRequestSync;
      // Use clickElement if we have an element, otherwise W3C actions
      const tapResult = require('child_process').spawnSync('curl', [
        '-s', '-X', 'POST', `http://127.0.0.1:8100/session/${session.sessionId}/actions`,
        '-H', 'Content-Type: application/json',
        '--max-time', '10',
        '-d', JSON.stringify({
          actions: [{
            type: 'pointer', id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 50 },
              { type: 'pointerUp', button: 0 },
            ],
          }],
        }),
      ], { encoding: 'utf8', timeout: 12000 });
      if (tapResult.stdout && tapResult.stdout.includes('"value" : null')) return true;
    }
  }
  // Fallback to idb
  return idb('ui', 'tap', String(Math.round(x)), String(Math.round(y))).status === 0;
}

function tapRef(ref) {
  const el = findEl(ref);
  if (!el) return { ok: false, error: `${ref} not found` };
  const p = center(el);
  return tap(p.x, p.y) ? { ok: true, action: 'tap', ref } : { ok: false, error: 'tap failed' };
}

const args = filteredArgs;
const cmd = args[0];

// Helper: detect ref arg (both "@e3" and "e3")
function isRefArg(a) { return a && (/^@e\d+$/.test(a) || /^e\d+$/.test(a)); }
// Helper: extract --flag value
function getFlag(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

if (!cmd || cmd === 'help' || cmd === '--help') {
  const devLabel = backend === 'real' ? 'Real Device' : `Simulator: ${device?.name} (${UDID})`;
  console.log(`agent-control-ios — ${backend} backend
Device: ${devLabel}

Commands:
  snapshot [-i]                  UI element tree
  tap @ref | x y                 Tap
  fill @ref "text"               Focus + type
  type "text"                    Type text (no focus)
  swipe dir [amount]             Swipe
  press home|lock|siri           Hardware button
  screenshot [path] [--window N] Capture screen
  longpress @ref | x y           Long press
  drag x1 y1 x2 y2              Drag
  open <url>                     Open URL
  launch <bundleId>              Launch app
  terminate <bundleId>           Kill app
  windows                        List windows/scenes
  list-apps                      List installed apps
  console <bundleId>             Live app console (stdout/stderr, 3rd-party subsystems)
                                 Options: --duration=N (seconds), --stream (raw passthrough)

Real-device only:
  unlock                         Unlock device
  install <ipa>                  Install IPA
  uninstall <bundleId>           Uninstall app
  info                           Device info`);
  process.exit(0);
}

let result;
try {
  // ── Real device routing ──
  if (backend === 'real') {
    // Route commands to real-device.py
    switch (cmd) {
      case 'snapshot': {
        const iFlag = args.includes('-i') || args.includes('--interactive');
        const rdArgs = ['snapshot'];
        if (iFlag) rdArgs.push('--interactive');
        result = realDevice(rdArgs);
        if (result.ok && result.elements) saveCache(result.elements);
        break;
      }
      case 'tap': case 'click': {
        const a1 = args[1], a2 = args[2];
        if (isRefArg(a1)) {
          // Tap by ref — look up from cache
          const el = findEl(a1);
          if (!el) { result = { ok: false, error: `${a1} not found` }; break; }
          if (el.uid) {
            result = realDevice(['tap-element', el.uid]);
          } else {
            result = { ok: false, error: 'element has no uid for real device tap' };
          }
        } else if (a1 && a2) {
          result = realDevice(['tap', a1, a2]);
        } else {
          result = { ok: false, error: 'tap requires @ref or x y' };
        }
        break;
      }
      case 'fill': {
        const ref = args[1], text = args.slice(2).join(' ');
        if (isRefArg(ref)) {
          const el = findEl(ref);
          if (!el) { result = { ok: false, error: `${ref} not found` }; break; }
          if (el.uid) {
            // Tap element first, then type
            realDevice(['tap-element', el.uid]);
            result = realDevice(['type', text]);
          } else {
            result = { ok: false, error: 'element has no uid' };
          }
        } else {
          result = realDevice(['type', ref + ' ' + text]);
        }
        break;
      }
      case 'type': {
        result = realDevice(['type', ...args.slice(1)]);
        break;
      }
      case 'swipe': case 'scroll': {
        const dir = args[1] || 'up';
        const amt = args[2] || '0.5';
        result = realDevice(['swipe', dir, amt]);
        break;
      }
      case 'press': {
        result = realDevice(['press', args[1] || 'home']);
        break;
      }
      case 'screenshot': {
        const p = args.find(a => !a.startsWith('-') && a !== 'screenshot');
        const rdArgs = ['screenshot'];
        if (p) rdArgs.push(p);
        result = realDevice(rdArgs);
        break;
      }
      case 'launch': {
        result = args[1] ? realDevice(['launch', args[1]]) : { ok: false, error: 'launch requires bundleId' };
        break;
      }
      case 'terminate': {
        result = args[1] ? realDevice(['terminate', args[1]]) : { ok: false, error: 'terminate requires bundleId' };
        break;
      }
      case 'list-apps': {
        result = realDevice(['list-apps']);
        break;
      }
      case 'unlock': {
        result = realDevice(['unlock']);
        break;
      }
      case 'install': {
        result = args[1] ? realDevice(['install', args[1]]) : { ok: false, error: 'install requires ipa path' };
        break;
      }
      case 'uninstall': {
        result = args[1] ? realDevice(['uninstall', args[1]]) : { ok: false, error: 'uninstall requires bundleId' };
        break;
      }
      case 'info': {
        result = realDevice(['info']);
        break;
      }
      case 'longpress': {
        // Real device longpress via tap with duration (WDA doesn't have native longpress, use tap + hold)
        const a1 = args[1], a2 = args[2];
        if (isRefArg(a1)) {
          const el = findEl(a1);
          if (!el || !el.uid) { result = { ok: false, error: `${a1} not found or no uid` }; break; }
          result = realDevice(['tap-element', el.uid]); // TODO: add duration support
        } else if (a1 && a2) {
          result = realDevice(['tap', a1, a2]); // TODO: add duration
        } else {
          result = { ok: false, error: 'longpress requires @ref or x y' };
        }
        break;
      }
      case 'drag': {
        result = { ok: false, error: 'drag not yet supported on real device' };
        break;
      }
      case 'open': {
        // Open URL via WDA
        result = args[1] ? realDevice(['launch', 'com.apple.mobilesafari'])
          : { ok: false, error: 'open requires url' };
        break;
      }
      case 'source': {
        result = realDevice(['source']);
        break;
      }
      case 'windows': case 'scenes': {
        result = { ok: false, error: 'windows/scenes not supported on real device' };
        break;
      }
      case 'console': case 'logs': {
        // Real device console: xcrun devicectl launch --console <bundleId>
        // Captures stdout/stderr (third-party subsystems visible, unlike idevicesyslog).
        // JSON mode: run for N seconds, return captured entries.
        // Stream mode (--stream): passthrough to stdout, exit non-JSON.
        const bundleId = args[1];
        if (!bundleId) { result = { ok: false, error: 'usage: console <bundleId> [--duration=N] [--stream]' }; break; }
        const durArg = args.find(a => a.startsWith('--duration='));
        const duration = durArg ? parseInt(durArg.slice(11), 10) : 5;
        const streamMode = args.includes('--stream');
        // Find CoreDevice identifier (devicectl UDID is different from libimobiledevice UDID).
        const listRaw = execSync('xcrun devicectl list devices 2>/dev/null', { encoding: 'utf8' });
        const coreDeviceMatch = listRaw.split('\n').map(l => l.match(/^[\S ]+?\s+([A-F0-9]{8}-[A-F0-9]{16})\s+(connected|available)/i)).find(Boolean);
        if (!coreDeviceMatch) { result = { ok: false, error: 'no CoreDevice found via devicectl' }; break; }
        const coreId = coreDeviceMatch[1];
        const cmdStr = `xcrun devicectl device process launch --console --terminate-existing --device "${coreId}" "${bundleId}"`;
        if (streamMode) {
          // Passthrough; exec never returns — JSON protocol broken intentionally.
          try { execSync(cmdStr, { stdio: 'inherit' }); } catch {}
          process.exit(0);
        }
        // JSON mode — spawn with timeout, collect output.
        const proc = spawnSync('bash', ['-c', `${cmdStr} 2>&1 & PID=$!; sleep ${duration}; kill $PID 2>/dev/null; wait $PID 2>/dev/null; true`], {
          encoding: 'utf8', timeout: (duration + 5) * 1000, maxBuffer: 10 * 1024 * 1024,
        });
        const raw = proc.stdout || '';
        const lines = raw.split('\n').filter(l => l.trim()
          && !l.startsWith('Failed to load provisioning')
          && !l.includes('devicectl manage create may support')
          && !l.match(/^\d{2}:\d{2}:\d{2}\s+(Acquired|Enabling|Launched|Waiting)/)
        );
        result = { ok: true, action: 'console', bundleId, duration, count: lines.length, entries: lines };
        break;
      }
      default: result = { ok: false, error: `unknown command '${cmd}'` };
    }
  } else {
  // ── Simulator backend (original) ──
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
      const ref = args[1];
      const text = args.slice(2).join(' ');
      // Try WDA first
      if (wda.isWdaRunning() || wda.startWda(UDID)) {
        const session = wda.ensureSession();
        if (session) {
          const el = findEl(ref);
          if (el) {
            // Find element in WDA by class name or label
            const wdaClass = 'XCUIElementType' + el.role;
            let elemId = wda.findElement(session.sessionId, 'class name', wdaClass);
            if (elemId) {
              wda.clickElement(session.sessionId, elemId);
              // Re-activate the app (WDA click can push runner to foreground)
              if (session.bundleId) {
                wda.activateApp(session.sessionId, session.bundleId);
                spawnSync('sleep', ['0.5']);
              }
              // Re-find after click + activate
              elemId = wda.findElement(session.sessionId, 'class name', wdaClass);
              if (elemId) {
                // Type directly — don't clear first (clear can also cause focus loss)
                if (wda.typeIntoElement(session.sessionId, elemId, text)) {
                  result = { ok: true, action: 'fill', ref, via: 'wda' };
                  break;
                }
              }
              // If element-based type failed, try sendKeys as fallback
              if (wda.sendKeys(session.sessionId, text)) {
                result = { ok: true, action: 'fill', ref, via: 'wda-keys' };
                break;
              }
            }
          }
        }
      }
      // Fallback to idb
      const r = tapRef(ref);
      if (!r.ok) { result = r; break; }
      idb('ui', 'text', text);
      result = { ok: true, action: 'fill', ref };
      break;
    }
    case 'type': {
      const text = args.slice(1).join(' ');
      // Try WDA first
      if (wda.isWdaRunning() || wda.startWda(UDID)) {
        const session = wda.ensureSession();
        if (session && wda.sendKeys(session.sessionId, text)) {
          result = { ok: true, action: 'type', via: 'wda' };
          break;
        }
      }
      // Fallback to idb
      idb('ui', 'text', text);
      result = { ok: true, action: 'type' };
      break;
    }
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
      const ref = args.find(isRefArg);
      const windowId = getFlag('--window') || getFlag('--display');
      const p = args.find(a => !a.startsWith('-') && a !== cmd && a !== windowId && !isRefArg(a)) || '/tmp/agent-control-ios.png';

      // Helper: capture full screen into `dest`
      const captureFull = (dest) => {
        let ok = false;
        if (wda.isWdaRunning()) {
          const session = wda.ensureSession();
          if (session) {
            const r = spawnSync('curl', ['-s', '--max-time', '10',
              `http://127.0.0.1:${wda.WDA_PORT}/screenshot`],
              { encoding: 'utf8', timeout: 12000 });
            if (r.stdout) {
              try {
                const data = JSON.parse(r.stdout);
                if (data.value) {
                  fs.writeFileSync(dest, Buffer.from(data.value, 'base64'));
                  ok = true;
                }
              } catch {}
            }
          }
        }
        if (!ok) {
          const sa = ['io', UDID, 'screenshot'];
          if (windowId) sa.push('--display', windowId);
          sa.push(dest);
          ok = simctl(...sa).status === 0;
        }
        return ok;
      };

      if (ref) {
        // Element-scoped screenshot: full capture + sips crop by frame
        const el = findEl(ref);
        if (!el || !el.frame) { result = { ok: false, error: `element ${ref} not found` }; break; }
        const tmp = `/tmp/agent-control-ios-full-${process.pid}.png`;
        if (!captureFull(tmp)) { result = { ok: false, error: 'screenshot failed' }; break; }
        try {
          // Get image pixel size to derive point→pixel scale
          const info = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', tmp], { encoding: 'utf8' }).stdout || '';
          const pw = parseInt((info.match(/pixelWidth:\s*(\d+)/) || [])[1]) || 0;
          const ph = parseInt((info.match(/pixelHeight:\s*(\d+)/) || [])[1]) || 0;
          // Screen points: use the larger between frame extents we've seen and common iOS widths.
          // WDA/AX returns frames in points. Infer scale from frame+image if we know a reference.
          // Simpler: assume scale = round(pixelWidth / 430) for portrait, but safer is to probe device.
          // Use simctl to get device info: `xcrun simctl list devices -j` has nothing useful for scale.
          // Pragmatic fallback: try scales [3, 2, 1] and pick the one that yields a crop inside bounds.
          let scale = 3;
          for (const s of [3, 2, 1]) {
            const rx = el.frame.x * s, ry = el.frame.y * s, rw = el.frame.w * s, rh = el.frame.h * s;
            if (rx >= 0 && ry >= 0 && rx + rw <= pw && ry + rh <= ph && rw >= 1 && rh >= 1) { scale = s; break; }
          }
          const cx = Math.round(el.frame.x * scale);
          const cy = Math.round(el.frame.y * scale);
          const cw = Math.max(1, Math.round(el.frame.w * scale));
          const ch = Math.max(1, Math.round(el.frame.h * scale));
          const r = spawnSync('sips', ['--cropOffset', String(cy), String(cx), '-c', String(ch), String(cw), tmp, '--out', p], { encoding: 'utf8' });
          fs.unlinkSync(tmp);
          result = r.status === 0
            ? { ok: true, path: p, ref, bbox: { x: cx, y: cy, w: cw, h: ch }, scale }
            : { ok: false, error: 'sips crop failed: ' + (r.stderr || '').trim() };
        } catch (e) {
          try { fs.unlinkSync(tmp); } catch {}
          result = { ok: false, error: 'crop failed: ' + e.message };
        }
        break;
      }

      // Full-screen / window capture (default)
      const ok = captureFull(p);
      result = ok ? { ok: true, path: p, ...(windowId ? { window: windowId } : {}) } : { ok: false, error: 'screenshot failed' };
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
      if (!btn) { result = { ok: false, error: `unknown button: ${args[1]}. Use: home, lock, siri` }; break; }
      idb('ui', 'button', btn);
      result = { ok: true, action: 'press', button: args[1] };
      break;
    }
    case 'open': {
      if (!args[1]) { result = { ok: false, error: 'usage: open <url>' }; break; }
      simctl('openurl', UDID, args[1]);
      result = { ok: true, action: 'open', url: args[1] };
      break;
    }
    case 'launch': {
      const bundleId = args[1];
      if (!bundleId) { result = { ok: false, error: 'usage: launch <bundleId>' }; break; }
      const r = simctl('launch', UDID, bundleId);
      result = r.status === 0
        ? { ok: true, action: 'launch', bundleId }
        : { ok: false, error: r.stderr?.trim() || 'launch failed' };
      break;
    }
    case 'terminate': {
      const bundleId = args[1];
      if (!bundleId) { result = { ok: false, error: 'usage: terminate <bundleId>' }; break; }
      const r = simctl('terminate', UDID, bundleId);
      result = r.status === 0
        ? { ok: true, action: 'terminate', bundleId }
        : { ok: false, error: r.stderr?.trim() || 'terminate failed' };
      break;
    }
    case 'windows': case 'scenes': {
      result = listWindows();
      break;
    }
    case 'list-apps': {
      result = listApps();
      break;
    }
    case 'console': case 'logs': {
      const level = args.find(a => ['error','fault','info','debug'].includes(a)) || 'info';
      const countArg = args.find(a => /^\d+$/.test(a));
      const limit = countArg ? parseInt(countArg) : 50;
      const processFilter = args.find(a => a.startsWith('--process='))?.slice(10);
      let logCmd = `timeout 2 xcrun simctl spawn ${UDID} log stream --style compact --level ${level}`;
      if (processFilter) logCmd += ` --predicate 'process == "${processFilter}"'`;
      try {
        const raw = execSync(logCmd, { encoding: 'utf8', timeout: 10000, stdio: ['pipe','pipe','pipe'] });
        let lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('Timestamp') && !l.startsWith('Filtering'));
        lines = lines.slice(-limit);
        result = { ok: true, action: 'console', count: lines.length, entries: lines };
      } catch (e) {
        // timeout exits with code 124, which is normal — just parse stdout
        const stdout = e.stdout || '';
        let lines = stdout.split('\n').filter(l => l.trim() && !l.startsWith('Timestamp') && !l.startsWith('Filtering'));
        lines = lines.slice(-limit);
        if (lines.length > 0) {
          result = { ok: true, action: 'console', count: lines.length, entries: lines };
        } else {
          result = { ok: true, action: 'console', count: 0, entries: [], note: 'no logs in 2s window' };
        }
      }
      break;
    }
    default: result = { ok: false, error: `unknown command '${cmd}'` };
  }
  } // end simulator backend
} catch (err) { result = { ok: false, error: err.message }; }
result.backend = backend;
if (backend === 'simulator' && device) result.device = device.name;
console.log(JSON.stringify(result, null, 2));
