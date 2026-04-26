#!/usr/bin/env node
/**
 * agent-control Flutter Driver — Dart VM Service Protocol
 *
 * Connects to a running Flutter debug app via WebSocket.
 * Uses Flutter's semantics tree for element discovery and interaction.
 *
 * Connection:
 *   Set FLUTTER_VM_SERVICE_URL or pass --vm-service ws://127.0.0.1:<port>/ws
 *   Flutter debug apps print: "A Dart VM Service on ... is available at: http://127.0.0.1:<port>/<auth>/"
 *
 * Commands:
 *   snapshot [-i]           Semantics tree (JSON array)
 *   click @ref | x y        Tap element or coordinates
 *   fill @ref "text"        Enter text into focused field
 *   scroll dir [amount]     Scroll up/down/left/right
 *   press key               Send key event (enter/tab/escape/back/...)
 *   screenshot [path]       Capture screenshot
 *   find <text>             Find elements matching text
 *   longpress @ref | x y    Long press
 *   drag x1 y1 x2 y2       Drag gesture
 *   swipe dir               Swipe gesture
 *   back                    Pop navigation (Android back)
 */

const WebSocket = require('ws');
const fs = require('fs');
const http = require('http');
const https = require('https');

const SNAP_CACHE = '/tmp/agent-control-flutter-snap.json';
let _ws = null;
let _reqId = 1;
let _isolateId = null;

// ── Connection ──

function getVmServiceUrl() {
  // Priority: env > --vm-service arg > auto-detect
  if (process.env.FLUTTER_VM_SERVICE_URL) return process.env.FLUTTER_VM_SERVICE_URL;
  const args = process.argv;
  const idx = args.indexOf('--vm-service');
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  // Try to read from Flutter's default observatory info file
  const infoFiles = ['/tmp/flutter_tools.observatory_uri', '/tmp/flutter_tools_vm_service_uri'];
  for (const f of infoFiles) {
    try { const url = fs.readFileSync(f, 'utf8').trim(); if (url) return url; } catch {}
  }
  return null;
}

function httpToWs(url) {
  return url.replace(/^http/, 'ws').replace(/\/?$/, '/ws');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const wsUrl = url.startsWith('ws') ? url : httpToWs(url);
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connection timeout')), 5000);
  });
}

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _reqId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const handler = (data) => {
      try {
        const resp = JSON.parse(data.toString());
        if (resp.id === id) {
          ws.removeListener('message', handler);
          if (resp.error) reject(new Error(resp.error.message || JSON.stringify(resp.error)));
          else resolve(resp.result);
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(msg);
    setTimeout(() => { ws.removeListener('message', handler); reject(new Error('request timeout')); }, 10000);
  });
}

async function getMainIsolate(ws) {
  const vm = await send(ws, 'getVM');
  const isolate = vm.isolates?.find(i => i.name === 'main') || vm.isolates?.[0];
  if (!isolate) throw new Error('no isolate found');
  return isolate.id;
}

// ── Flutter Extensions ──

async function callExtension(ws, isolateId, method, args = {}) {
  return send(ws, method, { isolateId, ...args });
}

async function getSemanticsTree(ws, isolateId) {
  // Try Flutter's semantics tree via ext.flutter.inspector
  try {
    const result = await callExtension(ws, isolateId, 'ext.flutter.inspector.getRootWidgetSummaryTree', {
      groupName: 'agent-control',
    });
    return result;
  } catch {
    // Fallback: try renderTree
    try {
      return await callExtension(ws, isolateId, 'ext.flutter.inspector.getRootRenderObject', {
        groupName: 'agent-control',
      });
    } catch { return null; }
  }
}

// ── Semantics Node Flattening ──

function flattenSemanticsTree(node, elements = [], counter = { n: 1 }) {
  if (!node) return elements;

  const el = {
    ref: `@e${counter.n}`,
    type: node.widgetRuntimeType || node.description || 'unknown',
    label: node.label || node.tooltip || '',
    value: node.value || '',
    interactive: false,
    frame: null,
  };

  // Determine interactivity from widget type and actions
  const interactiveTypes = ['ElevatedButton', 'TextButton', 'IconButton', 'FloatingActionButton',
    'InkWell', 'GestureDetector', 'TextField', 'TextFormField', 'Checkbox', 'Radio',
    'Switch', 'Slider', 'DropdownButton', 'PopupMenuButton', 'ListTile', 'Tab',
    'BottomNavigationBarItem', 'NavigationRailDestination'];
  const type = el.type;
  if (interactiveTypes.some(t => type.includes(t)) || node.hasAction || node.isFocusable) {
    el.interactive = true;
  }

  // Extract bounds if available
  if (node.creationLocation || node.renderObject) {
    // Bounds come from render object
  }
  if (node.textPreview) el.label = node.textPreview;

  elements.push(el);
  counter.n++;

  // Recurse children
  const children = node.children || [];
  for (const child of children) {
    flattenSemanticsTree(child, elements, counter);
  }
  return elements;
}

// ── Alternative: Use Flutter Driver protocol for semantics ──

async function getSemanticsViaEval(ws, isolateId) {
  // Evaluate Dart code to get semantics tree
  const dartCode = `
    import 'dart:convert';
    import 'package:flutter/rendering.dart';
    import 'package:flutter/widgets.dart';
    
    final binding = WidgetsBinding.instance;
    final renderView = binding.renderView;
    // Get semantics
    final owner = binding.pipelineOwner.semanticsOwner;
    if (owner == null) return '[]';
    final root = owner.rootSemanticsNode;
    if (root == null) return '[]';
    
    List<Map<String, dynamic>> flatten(SemanticsNode node, int counter) {
      final list = <Map<String, dynamic>>[];
      final rect = node.rect;
      final transform = node.transform;
      list.add({
        'id': node.id,
        'ref': '@e\${counter}',
        'label': node.label,
        'value': node.value,
        'hint': node.hint,
        'actions': node.getSemanticsData().actions,
        'flags': node.getSemanticsData().flags,
        'rect': {'x': rect.left, 'y': rect.top, 'w': rect.width, 'h': rect.height},
        'interactive': node.getSemanticsData().actions > 0,
      });
      int c = counter + 1;
      for (final child in node.debugListChildrenInOrder(DebugSemanticsDumpOrder.inverseHitTest)) {
        final sub = flatten(child, c);
        list.addAll(sub);
        c += sub.length;
      }
      return list;
    }
    return jsonEncode(flatten(root, 1));
  `;
  // This won't work directly — need to use service protocol evaluate
  // Instead, use the inspector extensions
  return null;
}

// ── Snapshot via accessibility/semantics ──

async function snapshot(ws, isolateId, interactiveOnly = false) {
  // Method 1: Try inspector widget tree
  const tree = await getSemanticsTree(ws, isolateId);
  if (tree) {
    const elements = flattenSemanticsTree(tree);
    const filtered = interactiveOnly ? elements.filter(e => e.interactive) : elements;
    saveSnapCache(filtered);
    return filtered;
  }

  // Method 2: Try getting semantics via flutter driver extension
  try {
    const result = await callExtension(ws, isolateId, 'ext.flutter.driver', {
      command: 'get_semantics_id',
      finderType: 'ByType',
      type: 'Widget',
    });
    if (result) {
      // Parse and return
      return [{ ref: '@e1', type: 'root', label: 'Flutter app', interactive: false }];
    }
  } catch {}

  return { ok: false, error: 'could not get widget tree — ensure Flutter app has semantics enabled' };
}

function loadSnapCache() { try { return JSON.parse(fs.readFileSync(SNAP_CACHE, 'utf8')); } catch { return null; } }
function saveSnapCache(els) { try { fs.writeFileSync(SNAP_CACHE, JSON.stringify(els)); } catch {} }

function findElement(ref, elements) {
  if (!elements) elements = loadSnapCache();
  if (!elements) return null;
  const normalized = ref.startsWith('@') ? ref : '@' + ref;
  return elements.find(e => e.ref === normalized);
}

// ── Actions ──

async function tap(ws, isolateId, x, y) {
  // Use Flutter's pointer event injection
  try {
    await callExtension(ws, isolateId, 'ext.flutter.driver', {
      command: 'tap',
      dx: x.toString(),
      dy: y.toString(),
      timeout: '5000',
    });
    return true;
  } catch {
    // Fallback: try platform dispatch
    try {
      await send(ws, 'ext.dwds.sendEvent', {
        isolateId,
        event: JSON.stringify({ type: 'pointer', x, y, kind: 'tap' }),
      });
      return true;
    } catch { return false; }
  }
}

async function enterText(ws, isolateId, text) {
  try {
    await callExtension(ws, isolateId, 'ext.flutter.driver', {
      command: 'enter_text',
      text,
      timeout: '5000',
    });
    return true;
  } catch { return false; }
}

async function pressKey(ws, isolateId, key) {
  // Map common key names to Flutter logical key IDs
  const keyMap = {
    'enter': '0x10000000d', 'return': '0x10000000d',
    'tab': '0x100000009',
    'escape': '0x10000001b', 'esc': '0x10000001b',
    'backspace': '0x100000008', 'delete': '0x100000008',
    'space': '0x100000020',
    'up': '0x100000304', 'down': '0x100000301', 'left': '0x100000302', 'right': '0x100000303',
    'home': '0x100000306', 'end': '0x100000305',
    'back': 'back', // Android back button
  };

  if (key === 'back' || key === 'home') {
    // System navigation
    try {
      await callExtension(ws, isolateId, 'ext.flutter.driver', {
        command: 'request_data',
        message: `system_nav_${key}`,
      });
      return true;
    } catch { return false; }
  }

  try {
    await callExtension(ws, isolateId, 'ext.flutter.driver', {
      command: 'enter_text',
      text: key === 'enter' ? '\n' : key === 'tab' ? '\t' : '',
      timeout: '5000',
    });
    return true;
  } catch { return false; }
}

async function scrollAction(ws, isolateId, dx, dy) {
  try {
    await callExtension(ws, isolateId, 'ext.flutter.driver', {
      command: 'scroll',
      dx: dx.toString(),
      dy: dy.toString(),
      duration: '300',
      frequency: '60',
      timeout: '5000',
    });
    return true;
  } catch { return false; }
}

async function captureScreenshot(ws, isolateId, outPath) {
  try {
    const result = await callExtension(ws, isolateId, 'ext.flutter.driver', {
      command: 'screenshot',
      timeout: '10000',
    });
    if (result && result.screenshot) {
      fs.writeFileSync(outPath, Buffer.from(result.screenshot, 'base64'));
      return true;
    }
  } catch {}

  // Fallback: try _flutter.screenshot
  try {
    const result = await send(ws, '_flutter.screenshot');
    if (result && result.screenshot) {
      fs.writeFileSync(outPath, Buffer.from(result.screenshot, 'base64'));
      return true;
    }
  } catch {}

  return false;
}

// ── Main ──

async function run(args) {
  // Strip --vm-service <url> from args before finding command
  const cleanArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--vm-service') { i++; continue; } // skip flag + value
    cleanArgs.push(args[i]);
  }
  const cmd = cleanArgs.find(a => !a.startsWith('-'));
  const cmdArgs = cleanArgs.filter(a => a !== cmd && a !== '-i');
  const interactiveOnly = cleanArgs.includes('-i');

  const vmUrl = getVmServiceUrl();
  if (!vmUrl) {
    console.log(JSON.stringify({ ok: false, error: 'no Flutter VM service URL. Set FLUTTER_VM_SERVICE_URL or pass --vm-service <url>' }, null, 2));
    return;
  }

  let ws;
  try {
    ws = await connect(vmUrl);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `cannot connect to Flutter VM service at ${vmUrl}: ${e.message}` }, null, 2));
    return;
  }

  try {
    _isolateId = await getMainIsolate(ws);
  } catch (e) {
    ws.close();
    console.log(JSON.stringify({ ok: false, error: `cannot find main isolate: ${e.message}` }, null, 2));
    return;
  }

  let result;
  try {
    switch (cmd) {
      case 'snapshot': {
        const elements = await snapshot(ws, _isolateId, interactiveOnly);
        if (Array.isArray(elements)) {
          // Raw output for snapshot (consistent with other drivers)
          ws.close();
          console.log(JSON.stringify(elements, null, 2));
          process.exit(0);
          return;
        }
        result = elements; // error object
        break;
      }

      case 'click': case 'tap': {
        const ref = cmdArgs.find(a => a.startsWith('@'));
        const nums = cmdArgs.filter(a => /^\d+$/.test(a));
        if (ref) {
          const el = findElement(ref);
          if (!el) { result = { ok: false, error: `ref ${ref} not found` }; break; }
          if (el.frame) {
            const ok = await tap(ws, _isolateId, el.frame.x + el.frame.w / 2, el.frame.y + el.frame.h / 2);
            result = ok ? { ok: true, action: 'click', ref } : { ok: false, error: 'tap failed' };
          } else {
            // Try by semantics ID
            try {
              await callExtension(ws, _isolateId, 'ext.flutter.driver', {
                command: 'tap', finderType: 'BySemanticsLabel', label: el.label || '',
                timeout: '5000',
              });
              result = { ok: true, action: 'click', ref };
            } catch (e) {
              result = { ok: false, error: e.message };
            }
          }
        } else if (nums.length >= 2) {
          const ok = await tap(ws, _isolateId, parseFloat(nums[0]), parseFloat(nums[1]));
          result = ok ? { ok: true, action: 'click', x: nums[0], y: nums[1] } : { ok: false, error: 'tap failed' };
        } else {
          result = { ok: false, error: 'usage: click @ref | click x y' };
        }
        break;
      }

      case 'fill': case 'type': {
        const ref = cmdArgs.find(a => a.startsWith('@'));
        const text = cmdArgs.filter(a => !a.startsWith('@')).join(' ');
        if (!ref) { result = { ok: false, error: 'usage: fill @ref text' }; break; }
        // First tap to focus
        const el = findElement(ref);
        if (el?.frame) {
          await tap(ws, _isolateId, el.frame.x + el.frame.w / 2, el.frame.y + el.frame.h / 2);
          await new Promise(r => setTimeout(r, 200));
        }
        const ok = await enterText(ws, _isolateId, text);
        result = ok ? { ok: true, action: 'fill', ref, value: text } : { ok: false, error: 'enter_text failed' };
        break;
      }

      case 'press': {
        const key = cmdArgs[0];
        if (!key) { result = { ok: false, error: 'usage: press <key>' }; break; }
        const ok = await pressKey(ws, _isolateId, key.toLowerCase());
        result = ok ? { ok: true, action: 'press', key } : { ok: false, error: `press ${key} failed` };
        break;
      }

      case 'scroll': {
        const dir = cmdArgs[0] || 'down';
        const amount = parseInt(cmdArgs[1]) || 300;
        const scrollMap = {
          up: [0, amount], down: [0, -amount],
          left: [amount, 0], right: [-amount, 0],
        };
        const [dx, dy] = scrollMap[dir] || [0, -amount];
        const ok = await scrollAction(ws, _isolateId, dx, dy);
        result = ok ? { ok: true, action: 'scroll', direction: dir, amount } : { ok: false, error: 'scroll failed' };
        break;
      }

      case 'swipe': {
        const dir = cmdArgs[0] || 'up';
        const swipeAmount = 500;
        const swipeMap = {
          up: [0, -swipeAmount], down: [0, swipeAmount],
          left: [-swipeAmount, 0], right: [swipeAmount, 0],
        };
        const [dx, dy] = swipeMap[dir] || [0, -swipeAmount];
        const ok = await scrollAction(ws, _isolateId, dx, dy);
        result = ok ? { ok: true, action: 'swipe', direction: dir } : { ok: false, error: 'swipe failed' };
        break;
      }

      case 'screenshot': {
        const outPath = cmdArgs.find(a => !a.startsWith('@') && !a.startsWith('--')) || '/tmp/agent-control-flutter.png';
        const ok = await captureScreenshot(ws, _isolateId, outPath);
        result = ok ? { ok: true, path: outPath } : { ok: false, error: 'screenshot failed' };
        break;
      }

      case 'longpress': {
        const ref = cmdArgs.find(a => a.startsWith('@'));
        const nums = cmdArgs.filter(a => /^\d+$/.test(a));
        const durationArg = cmdArgs.find(a => a.startsWith('--duration='));
        const duration = durationArg ? parseInt(durationArg.split('=')[1]) : 1000;

        let x, y;
        if (ref) {
          const el = findElement(ref);
          if (!el?.frame) { result = { ok: false, error: `ref ${ref} not found or no frame` }; break; }
          x = el.frame.x + el.frame.w / 2;
          y = el.frame.y + el.frame.h / 2;
        } else if (nums.length >= 2) {
          x = parseFloat(nums[0]); y = parseFloat(nums[1]);
        } else {
          result = { ok: false, error: 'usage: longpress @ref | longpress x y [--duration=ms]' }; break;
        }

        // Long press = pointer down, wait, pointer up
        try {
          await callExtension(ws, _isolateId, 'ext.flutter.driver', {
            command: 'scroll',
            dx: '0', dy: '0',
            duration: duration.toString(),
            frequency: '1',
            startLocation_dx: x.toString(),
            startLocation_dy: y.toString(),
            timeout: (duration + 5000).toString(),
          });
          result = { ok: true, action: 'longpress', x, y, duration };
        } catch (e) {
          result = { ok: false, error: e.message };
        }
        break;
      }

      case 'drag': {
        const refs = cmdArgs.filter(a => a.startsWith('@'));
        const nums = cmdArgs.filter(a => /^\d+$/.test(a));
        let x1, y1, x2, y2;

        if (refs.length >= 2) {
          const el1 = findElement(refs[0]);
          const el2 = findElement(refs[1]);
          if (!el1?.frame || !el2?.frame) { result = { ok: false, error: 'ref not found' }; break; }
          x1 = el1.frame.x + el1.frame.w / 2; y1 = el1.frame.y + el1.frame.h / 2;
          x2 = el2.frame.x + el2.frame.w / 2; y2 = el2.frame.y + el2.frame.h / 2;
        } else if (nums.length >= 4) {
          [x1, y1, x2, y2] = nums.slice(0, 4).map(Number);
        } else {
          result = { ok: false, error: 'usage: drag @from @to | drag x1 y1 x2 y2' }; break;
        }

        try {
          await callExtension(ws, _isolateId, 'ext.flutter.driver', {
            command: 'scroll',
            startLocation_dx: x1.toString(),
            startLocation_dy: y1.toString(),
            dx: (x2 - x1).toString(),
            dy: (y2 - y1).toString(),
            duration: '500',
            frequency: '60',
            timeout: '10000',
          });
          result = { ok: true, action: 'drag', from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
        } catch (e) {
          result = { ok: false, error: e.message };
        }
        break;
      }

      case 'find': {
        const query = cmdArgs.join(' ').toLowerCase();
        if (!query) { result = { ok: false, error: 'usage: find <text>' }; break; }
        const elements = await snapshot(ws, _isolateId, false);
        if (!Array.isArray(elements)) { result = elements; break; }
        const matches = elements.filter(e => {
          const text = [e.label, e.value, e.type].filter(Boolean).join(' ').toLowerCase();
          return text.includes(query);
        });
        result = { ok: true, action: 'find', query, count: matches.length, elements: matches };
        break;
      }

      case 'back': {
        const ok = await pressKey(ws, _isolateId, 'back');
        result = ok ? { ok: true, action: 'back' } : { ok: false, error: 'back navigation failed' };
        break;
      }

      case 'console': case 'logs': {
        // Listen to Stdout/Stderr streams from the Dart VM for ~2 seconds
        const countArg = cmdArgs.find(a => /^\d+$/.test(a));
        const limit = countArg ? parseInt(countArg) : 50;
        const levelFilter = cmdArgs.find(a => ['error','warning','info','debug','log'].includes(a));
        const entries = [];

        // Enable logging stream
        try { await send(ws, 'streamListen', { streamId: 'Stdout' }); } catch {}
        try { await send(ws, 'streamListen', { streamId: 'Stderr' }); } catch {}
        try { await send(ws, 'streamListen', { streamId: 'Logging' }); } catch {}

        // Collect events for 2 seconds
        const origOnMsg = ws.listeners('message');
        const logHandler = (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.method === 'streamNotify') {
              const p = msg.params;
              if (p.streamId === 'Stdout' || p.streamId === 'Stderr') {
                const text = p.event?.bytes ? Buffer.from(p.event.bytes, 'base64').toString() : '';
                const type = p.streamId === 'Stderr' ? 'error' : 'log';
                if (text.trim()) entries.push({ type, text: text.trim(), ts: Date.now() });
              } else if (p.streamId === 'Logging') {
                const logRecord = p.event?.logRecord;
                const text = logRecord?.message?.valueAsString || '';
                const lvl = logRecord?.level >= 900 ? 'error' : logRecord?.level >= 800 ? 'warning' : 'info';
                if (text.trim()) entries.push({ type: lvl, text: text.trim(), ts: Date.now() });
              }
            }
          } catch {}
        };
        ws.on('message', logHandler);

        await new Promise(r => setTimeout(r, 2000));
        ws.removeListener('message', logHandler);

        let filtered = entries;
        if (levelFilter) {
          filtered = entries.filter(e => e.type === levelFilter);
        }
        filtered = filtered.slice(-limit);
        result = { ok: true, action: 'console', count: filtered.length, total: entries.length, entries: filtered };
        break;
      }

      default:
        result = { ok: false, error: `unknown command '${cmd}'` };
    }
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  ws.close();
  console.log(JSON.stringify(result, null, 2));
}

// ── Entry ──
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    console.log(`agent-control Flutter driver

Usage: node index.js [--vm-service ws://...] <command> [args...]

Commands:
  snapshot [-i]           Widget/semantics tree
  click @ref | x y        Tap element or coordinates
  fill @ref "text"        Enter text
  scroll dir [amount]     Scroll (up/down/left/right)
  swipe dir               Swipe gesture
  press key               Key event (enter/tab/escape/back/...)
  screenshot [path]       Capture screenshot
  longpress @ref | x y    Long press [--duration=ms]
  drag @from @to          Drag between elements
  drag x1 y1 x2 y2       Drag between coordinates
  find <text>             Find elements by text
  back                    Pop navigation

Environment:
  FLUTTER_VM_SERVICE_URL  WebSocket URL of Flutter VM service

The Flutter app must be running in debug/profile mode with semantics enabled.
Add \`SemanticsBinding.ensureInitialized()\` or wrap with \`Semantics\` widgets.`);
    process.exit(0);
  }
  run(args).catch(e => {
    console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
    process.exit(1);
  });
}

module.exports = { run, snapshot: (ws, id, i) => snapshot(ws, id, i), findElement };
