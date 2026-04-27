#!/usr/bin/env node
const WebSocket = require('ws');
const http = require('http');

// Port may also be overridden via --port <n>. Parsed in main().
let CDP_PORT = process.env.ELECTRON_DEBUG_PORT || 9229;

// ── Ref Resolution ───────────────────────────────────────────────────────────

// Convert @eN or eN ref to a JS expression that finds the Nth interactive element
function resolveRefExpr(ref) {
  // Normalize: strip @ prefix if present
  const normalized = ref && ref.startsWith('@') ? ref.slice(1) : ref;
  if (normalized && normalized.startsWith('e')) {
    const n = parseInt(normalized.slice(1));
    if (!isNaN(n)) {
      return `(() => {
      const sel = ['button','input','select','textarea','a[href]',
        '[role="button"],[role="link"],[role="checkbox"],[role="radio"]',
        '[role="tab"],[role="menuitem"],[role="combobox"],[role="switch"]',
        '[tabindex]:not([tabindex="-1"])','[contenteditable="true"]','[aria-label]'
      ].join(',');
      const els = document.querySelectorAll(sel);
      const seen = new Set(); let i = 0;
      for (const el of els) {
        if (seen.has(el)) continue; seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (!el.offsetParent && el.tagName !== 'BODY') continue;
        i++;
        if (i === ${n}) return el;
      }
      throw new Error('ref e${n} not found');
    })()`;
    }
  }
  // CSS selector fallback
  return `document.querySelector(${JSON.stringify(ref)})`;
}

function resolveRef(ref) {
  return `(${resolveRefExpr(ref)})`;
}

// ── Keyboard combo parsing ────────────────────────────────────────────────
// Parse strings like 'Enter', 'cmd+shift+p', 'ctrl+alt+t', 'ArrowDown',
// 'F5', 'a' into CDP Input.dispatchKeyEvent fields. CDP modifier bitmask:
//   Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
function parseKeyCombo(spec) {
  if (!spec) return null;
  const parts = String(spec).split('+').map(s => s.trim()).filter(Boolean);
  let modifiers = 0;
  let keyPart = null;
  const modMap = {
    cmd: 4, command: 4, meta: 4, win: 4,
    ctrl: 2, control: 2,
    alt: 1, option: 1, opt: 1,
    shift: 8,
  };
  for (const p of parts) {
    const low = p.toLowerCase();
    if (modMap[low] != null) { modifiers |= modMap[low]; continue; }
    keyPart = p;
  }
  if (!keyPart) return null;
  const specialKeys = {
    Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    Return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
    Escape: { key: 'Escape', code: 'Escape', vk: 27 },
    Esc: { key: 'Escape', code: 'Escape', vk: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    Delete: { key: 'Delete', code: 'Delete', vk: 46 },
    Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    Home: { key: 'Home', code: 'Home', vk: 36 },
    End: { key: 'End', code: 'End', vk: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  };
  // Accept canonical case and common lowercase aliases.
  const canonical = Object.keys(specialKeys).find(k => k.toLowerCase() === keyPart.toLowerCase());
  if (canonical) {
    return Object.assign({ modifiers }, specialKeys[canonical]);
  }
  // Function keys F1..F24
  const fMatch = /^[fF](\d{1,2})$/.exec(keyPart);
  if (fMatch) {
    const n = parseInt(fMatch[1], 10);
    return { modifiers, key: 'F' + n, code: 'F' + n, vk: 111 + n };
  }
  // Single char — letters/numbers/symbols.
  if (keyPart.length === 1) {
    const ch = keyPart;
    const up = ch.toUpperCase();
    const isLetter = up >= 'A' && up <= 'Z';
    const isDigit = ch >= '0' && ch <= '9';
    // VK codes: letters A-Z = ASCII; digits 0-9 = ASCII.
    const vk = isLetter ? up.charCodeAt(0) : isDigit ? ch.charCodeAt(0) : ch.charCodeAt(0);
    // When there's a modifier (cmd/ctrl/meta/alt) we omit `text` so the app
    // receives this as a shortcut, not as inserted text.
    const hasShortcutMod = (modifiers & 0b111) !== 0; // cmd/ctrl/alt
    const entry = {
      modifiers,
      key: hasShortcutMod ? ch.toLowerCase() : ch,
      code: isLetter ? 'Key' + up : isDigit ? 'Digit' + ch : ch,
      vk,
    };
    if (!hasShortcutMod) entry.text = ch;
    return entry;
  }
  // Fallback — pass through as-is.
  return { modifiers, key: keyPart, code: keyPart, vk: 0 };
}

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json`, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

// Resolve the Electron host app's display name (as known to the AX driver)
// from the CDP port. lsof → PID → ps → executable name. Returns null on any
// failure so the caller can fall back or surface a warning.
function findElectronAppNameFromPort(port) {
  try {
    const { execSync } = require('child_process');
    const lsofOut = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2; exit}'`, { encoding: 'utf8' }).trim();
    const pid = parseInt(lsofOut, 10);
    if (!pid) return null;
    // ps -o comm= gives the absolute executable path, last path component is
    // usually something like 'RemoteClaw' or 'Visual Studio Code'.
    const comm = execSync(`ps -o comm= -p ${pid}`, { encoding: 'utf8' }).trim();
    if (!comm) return null;
    // Example: /Applications/RemoteClaw.app/Contents/MacOS/RemoteClaw → RemoteClaw
    const m = comm.match(/\/([^\/]+)\.app\//);
    if (m) return m[1];
    // Fallback: last path segment.
    return comm.split('/').pop() || null;
  } catch (_) {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const ui = args.includes('--ui');
  // --port <n>
  const portIdx = args.findIndex(a => a === '--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    const p = parseInt(args[portIdx + 1], 10);
    if (!Number.isNaN(p) && p > 0) CDP_PORT = p;
  }
  // --target <index|substr>
  //   index: 0-based position in `windows` listing (all target types)
  //   substr: title or URL substring match; picks first target that contains it
  const targetIdx = args.findIndex(a => a === '--target');
  const rawTarget = targetIdx !== -1 ? args[targetIdx + 1] : '0';
  // Everything that isn't a flag value or the action itself
  const consumedIdx = new Set();
  if (portIdx !== -1) { consumedIdx.add(portIdx); consumedIdx.add(portIdx + 1); }
  if (targetIdx !== -1) { consumedIdx.add(targetIdx); consumedIdx.add(targetIdx + 1); }
  const nonFlagArgs = args.filter((a, i) => !consumedIdx.has(i) && a !== '--ui');
  const action = nonFlagArgs[0];
  const otherArgs = nonFlagArgs.slice(1);

  try {
    const targetInfo = await resolveTarget(rawTarget);
    const cdp = await cdpConnect(targetInfo.webSocketDebuggerUrl);
    let output;

    switch (action) {
      case 'snapshot': {
        const js = ui ? UI_SNAPSHOT_JS : SNAPSHOT_JS;
        const result = await cdp.evaluate(js);
        // snapshot returns raw array (not wrapped in Result)
        console.log(JSON.stringify(result.result.value, null, 2));
        cdp.close();
        process.exit(0);
        return;
      }
      case 'screenshot': {
        const spath = otherArgs[0] || '/tmp/screenshot.png';
        const warnings = [];
        // Embedded webviews don't own a top-level window and CDP
        // captureScreenshot against them routinely returns the host compositor
        // (observed: Finder). Hand these off to the macOS AX driver, which
        // can screenshot the Electron host window by PID.
        if (targetInfo.type === 'webview') {
          try {
            const all = await getTargets();
            const hosts = all.filter(t => t.type === 'page');
            for (const h of hosts) {
              if (!h.webSocketDebuggerUrl) continue;
              try {
                const hostCdp = await cdpConnect(h.webSocketDebuggerUrl);
                await hostCdp.send('Page.bringToFront').catch(() => {});
                hostCdp.close();
              } catch (_) {}
            }
          } catch (_) {}
          const { spawnSync } = require('child_process');
          const path = require('path');
          const agentControlBin = path.resolve(__dirname, '..', 'cli.js');
          const port = String(CDP_PORT);
          const appName = findElectronAppNameFromPort(port);
          if (appName) {
            try { require('child_process').execSync(`open -a ${JSON.stringify(appName)}`); } catch (_) {}
            await new Promise(r => setTimeout(r, 200));
            const res = spawnSync('node', [agentControlBin, '-p', 'macos', '--app', appName, 'screenshot', spath], { encoding: 'utf8' });
            if (res.status === 0) {
              output = { ok: true, action: 'screenshot', path: spath, strategy: 'macos-ax', app: appName };
              break;
            }
            warnings.push(`macOS fallback failed for webview screenshot: ${(res.stderr || '').trim().substring(0, 200)}`);
          } else {
            warnings.push(`could not resolve Electron host app name for port ${port}; webview capture via CDP may return the frontmost window`);
          }
        }
        // Regular page target: surface the tab then captureScreenshot.
        const wantForeground = !otherArgs.includes('--background');
        let brought = false;
        let hostBrought = false;
        if (wantForeground) {
          try { await cdp.send('Page.bringToFront'); brought = true; } catch (_) {}
          try {
            const all = await getTargets();
            const hosts = all.filter(t => t.type === 'page');
            for (const h of hosts) {
              if (!h.webSocketDebuggerUrl) continue;
              try {
                const hostCdp = await cdpConnect(h.webSocketDebuggerUrl);
                await hostCdp.send('Page.bringToFront').catch(() => {});
                hostCdp.close();
              } catch (_) {}
            }
            hostBrought = true;
          } catch (_) {}
        }
        async function grab() {
          const { data } = await cdp.send('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: false,
          });
          return data;
        }
        let data = await grab();
        if (!data) {
          await new Promise(r => setTimeout(r, 150));
          data = await grab();
        }
        if (!data) {
          output = { ok: false, error: 'Page.captureScreenshot returned empty — target may be detached' };
          if (warnings.length) output.warnings = warnings;
          break;
        }
        try {
          const vp = await cdp.evaluate('({w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio})');
          const v = vp.result?.value;
          const buf = Buffer.from(data, 'base64');
          if (v && buf.length > 24) {
            const pngW = buf.readUInt32BE(16);
            const pngH = buf.readUInt32BE(20);
            const expW = Math.round(v.w * v.dpr);
            const expH = Math.round(v.h * v.dpr);
            if (Math.abs(pngW - expW) > Math.max(32, expW * 0.1) || Math.abs(pngH - expH) > Math.max(32, expH * 0.1)) {
              warnings.push(`capture ${pngW}x${pngH} does not match viewport ${expW}x${expH} — check that the host Electron window is frontmost`);
            }
          }
        } catch (_) {}
        require('fs').writeFileSync(spath, Buffer.from(data, 'base64'));
        output = { ok: true, action: 'screenshot', path: spath, broughtToFront: brought, hostBrought, strategy: 'cdp-captureScreenshot' };
        if (warnings.length) output.warnings = warnings;
        break;
      }
      case 'click':
      case 'dblclick':
      case 'rightclick': {
        const clickTarget = otherArgs[0];
        if (!clickTarget) {
          output = { ok: false, error: `usage: ${action} @ref | ${action} x y` };
          break;
        }
        const clickJs = resolveRef(clickTarget) + (action === 'dblclick'
          ? `.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`
          : action === 'rightclick'
          ? `.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}))`
          : `.click()`);
        try {
          const clickResult = await cdp.evaluate(clickJs);
          if (clickResult.exceptionDetails) {
            output = { ok: false, error: clickResult.exceptionDetails.text || 'element not found' };
          } else {
            output = { ok: true, action, ref: clickTarget };
          }
        } catch (e) {
          output = { ok: false, error: e.message };
        }
        break;
      }
      case 'fill':
      case 'type': {
        const fillTarget = otherArgs[0];
        if (!fillTarget) {
          output = { ok: false, error: 'usage: fill @ref text' };
          break;
        }
        const fillText = otherArgs.slice(1).join(' ');
        // Probe the target to pick the right typing strategy. contenteditable
        // and shadow editors (Monaco/Slate/ProseMirror/VS Code NativeEdit)
        // ignore `el.value=` — we have to route through CDP Input.insertText
        // after focusing + optional select-all.
        const probeJs = `(() => {
          const el = ${resolveRefExpr(fillTarget)};
          if (!el) return { kind: 'missing' };
          const tag = el.tagName;
          const editable = el.isContentEditable || el.getAttribute('role') === 'textbox';
          if (tag === 'INPUT' || tag === 'TEXTAREA') {
            return { kind: 'value', tag };
          }
          if (editable) {
            const r = el.getBoundingClientRect();
            el.focus();
            if (typeof el.scrollIntoView === 'function') el.scrollIntoView({block:'center', inline:'center'});
            return { kind: 'edit', tag, cx: r.x + r.width/2, cy: r.y + r.height/2 };
          }
          return { kind: 'other', tag };
        })()`;
        const probe = await cdp.evaluate(probeJs);
        const info = probe.result?.value;
        if (!info || info.kind === 'missing') {
          output = { ok: false, error: `element not found for ${fillTarget}` };
          break;
        }
        if (info.kind === 'value') {
          // The React/Vue workaround: use the native descriptor setter so
          // framework change-tracking fires. Pick the right prototype per
          // tag — textarea's setter throws if invoked on an input and v.v.
          const fillJs = `(() => {
            const el = ${resolveRefExpr(fillTarget)};
            el.focus();
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, ${JSON.stringify(fillText)});
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
            return el.value;
          })()`;
          const res = await cdp.evaluate(fillJs);
          output = { ok: true, action: 'fill', ref: fillTarget, value: fillText, strategy: 'value-setter', observed: res.result?.value };
          break;
        }
        // contenteditable / role=textbox path: focus → clear via DOM API
        // (Range + Selection.deleteFromDocument is scoped to the target, so
        // it won't wipe out whatever had focus before) → Input.insertText.
        try { await cdp.send('Page.bringToFront'); } catch (_) {}
        // A real click places the caret, but CDP Input.dispatchMouseEvent on
        // a webview often hits the host compositor. DOM focus + selection is
        // more reliable for programmatic fills.
        const clearJs = `(() => {
          const el = ${resolveRefExpr(fillTarget)};
          el.focus();
          try {
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            sel.deleteFromDocument();
          } catch (_) {}
        })()`;
        await cdp.evaluate(clearJs);
        // Input.insertText is the canonical CDP path for contenteditable and
        // satisfies VS Code's NativeEditContext / Monaco / Slate / ProseMirror.
        // el.value = doesn't work here — the framework ignores it.
        await cdp.send('Input.insertText', { text: fillText });
        output = { ok: true, action: 'fill', ref: fillTarget, value: fillText, strategy: 'insertText' };
        break;
      }
      case 'press': {
        const spec = otherArgs[0];
        if (!spec) {
          output = { ok: false, error: 'usage: press <key> (supports cmd+shift+p style combos)' };
          break;
        }
        const parsed = parseKeyCombo(spec);
        if (!parsed) {
          output = { ok: false, error: `press: could not parse key '${spec}'` };
          break;
        }
        // VS Code / Electron apps register keybindings against real key events
        // — dispatchEvent won't trigger them. Routing through CDP Input.* does.
        try { await cdp.send('Page.bringToFront'); } catch (_) {}
        const base = {
          modifiers: parsed.modifiers,
          key: parsed.key,
          code: parsed.code,
          windowsVirtualKeyCode: parsed.vk,
          nativeVirtualKeyCode: parsed.vk,
        };
        if (parsed.text) base.text = parsed.text;
        // rawKeyDown doesn't fire a JS 'keydown' event on some Electron
        // versions, so VS Code / CodeMirror keybindings miss it. Sending
        // keyDown always is safer; for character-producing keys we also
        // include text so inserted characters appear.
        await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, base));
        await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
        output = { ok: true, action: 'press', key: spec, resolved: parsed };
        break;
      }
      case 'scroll': {
        const dir = otherArgs[0] || 'down';
        const amt = parseInt(otherArgs[1]) || 300;
        const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
        const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: dx, deltaY: dy });
        output = { ok: true, action: 'scroll', direction: dir, amount: amt };
        break;
      }
      case 'longpress': {
        const lpTarget = otherArgs[0];
        const durationMs = parseInt(otherArgs.find(a => a.startsWith('--duration='))?.split('=')[1]) || 1000;
        const lpCoord = await cdp.evaluate(`(() => {
          const el = ${resolveRefExpr(lpTarget)};
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        })()`);
        const { x: lpX, y: lpY } = lpCoord.result.value;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: lpX, y: lpY, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, durationMs));
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lpX, y: lpY, button: 'left', clickCount: 1 });
        output = { ok: true, action: 'longpress', ref: lpTarget, duration: durationMs };
        break;
      }
      case 'drag': {
        const dragFrom = otherArgs[0];
        const dragTo = otherArgs[1];
        const dragCoords = await cdp.evaluate(`(() => {
          const from = ${resolveRefExpr(dragFrom)};
          const to = ${resolveRefExpr(dragTo)};
          const fr = from.getBoundingClientRect();
          const tr = to.getBoundingClientRect();
          return {
            x1: fr.x + fr.width/2, y1: fr.y + fr.height/2,
            x2: tr.x + tr.width/2, y2: tr.y + tr.height/2
          };
        })()`);
        const { x1, y1, x2, y2 } = dragCoords.result.value;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t, button: 'left'
          });
        }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
        output = { ok: true, action: 'drag', from: dragFrom, to: dragTo };
        break;
      }
      case 'eval': {
        const res = await cdp.evaluate(otherArgs.join(' '));
        output = { ok: true, action: 'eval', value: res.result.value };
        break;
      }
      case 'navigate':
      case 'goto': {
        const url = otherArgs[0];
        if (!url) { output = { ok: false, error: 'usage: navigate <url>' }; break; }
        // Page.navigate works for both page and webview targets.
        const navResult = await cdp.send('Page.navigate', { url });
        if (navResult.errorText) {
          output = { ok: false, error: navResult.errorText };
        } else {
          output = { ok: true, action: 'navigate', url, frameId: navResult.frameId };
        }
        break;
      }
      case 'reload': {
        await cdp.send('Page.reload');
        output = { ok: true, action: 'reload' };
        break;
      }
      case 'windows': {
        const all = await getTargets();
        // Only list targets we can address via --target index, so the index
        // shown here matches the index accepted by --target.
        const usable = all.filter(t => t.type === 'page' || t.type === 'webview' || t.type === 'iframe');
        output = {
          ok: true,
          action: 'windows',
          targets: usable.map((t, i) => ({ index: i, title: t.title, type: t.type, url: t.url }))
        };
        break;
      }
      case 'console':
      case 'logs': {
        // Enable Runtime events and collect console messages for ~2 seconds
        const consoleEntries = [];
        const levelFilter = otherArgs.find(a => ['log','warn','error','warning','info','debug'].includes(a));
        const countArg = otherArgs.find(a => /^\d+$/.test(a));
        const limit = countArg ? parseInt(countArg) : 50;
        const doClear = otherArgs.includes('--clear');

        // Subscribe to console events
        const ws2 = cdp._ws || null;
        const origHandler = cdp._onEvent;
        cdp._onEvent = (method, params) => {
          if (method === 'Runtime.consoleAPICalled') {
            const text = (params.args || []).map(a => a.value !== undefined ? String(a.value) : a.description || '').join(' ');
            consoleEntries.push({ type: params.type, text, ts: Date.now() });
          }
        };

        await cdp.send('Runtime.enable');
        // Also inject a console capture hook and read existing buffer
        const captureJs = `(() => {
          if (!window.__agentConsoleLog) {
            window.__agentConsoleLog = [];
            const orig = {};
            ['log','warn','error','info','debug'].forEach(t => {
              orig[t] = console[t];
              console[t] = function(...args) {
                window.__agentConsoleLog.push({type:t,text:args.map(String).join(' '),ts:Date.now()});
                orig[t].apply(console, args);
              };
            });
          }
          const entries = window.__agentConsoleLog.slice();
          ${doClear ? 'window.__agentConsoleLog.length = 0;' : ''}
          return entries;
        })()`;
        const bufResult = await cdp.evaluate(captureJs);
        let entries = bufResult.result?.value || [];

        // Filter
        if (levelFilter) {
          const normalized = levelFilter === 'warning' ? 'warn' : levelFilter;
          entries = entries.filter(e => e.type === normalized);
        }
        entries = entries.slice(-limit);
        output = { ok: true, action: 'console', count: entries.length, total: (bufResult.result?.value || []).length, entries };
        cdp._onEvent = origHandler;
        break;
      }
      default:
        output = { ok: false, error: `unknown action '${action}'` };
    }

    console.log(JSON.stringify(output, null, 2));
    cdp.close();
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

// ── CDP ──────────────────────────────────────────────────────────────────────

// Resolve a target against the CDP /json listing. Returns both the ws url
// and the raw target record so callers can inspect type (page vs webview),
// url and title — needed for picking the right screenshot strategy.
function resolveTarget(rawTarget = '0') {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json`, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        let all;
        try { all = JSON.parse(data); } catch (e) { return reject(new Error('bad CDP /json response')); }
        // Keep target types that can be eval'd via Runtime.evaluate.
        // Includes page AND webview (Electron embeds) — older behaviour
        // filtered webviews out, which broke anything using <webview>.
        const usable = all.filter(t => t.type === 'page' || t.type === 'webview' || t.type === 'iframe');
        if (!usable.length) return reject(new Error('No CDP targets found'));
        if (/^\d+$/.test(String(rawTarget))) {
          const idx = parseInt(rawTarget, 10);
          if (idx >= usable.length) return reject(new Error(`target index ${idx} out of range (${usable.length} targets)`));
          return resolve(usable[idx]);
        }
        const needle = String(rawTarget).toLowerCase();
        const hit = usable.find(t =>
          (t.title || '').toLowerCase().includes(needle) ||
          (t.url || '').toLowerCase().includes(needle));
        if (!hit) return reject(new Error(`no target matches '${rawTarget}' (try: windows)`));
        resolve(hit);
      });
    }).on('error', reject);
  });
}

function getCDPEndpoint(rawTarget = '0') {
  return resolveTarget(rawTarget).then(t => t.webSocketDebuggerUrl);
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const pending = new Map();
    
    const connectTimeout = setTimeout(() => reject(new Error('CDP connect timeout')), 5000);
    
    ws.on('open', () => {
      clearTimeout(connectTimeout);
      const api = {
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++msgId;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP timeout: ${method}`));
              }
            }, 20000);
          });
        },
        evaluate(expression) {
          return this.send('Runtime.evaluate', { expression, returnByValue: true });
        },
        close() {
          ws.close();
        }
      };
      resolve(api);
    });
    
    ws.on('message', data => {
      const msg = JSON.parse(data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
    
    ws.on('error', reject);
  });
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

const SNAPSHOT_JS = `(() => {
  const sel = [
    'button','input','select','textarea','a[href]',
    '[role="button"],[role="link"],[role="checkbox"],[role="radio"]',
    '[role="tab"],[role="menuitem"],[role="combobox"],[role="switch"]',
    '[tabindex]:not([tabindex="-1"])','[contenteditable="true"]','[aria-label]'
  ].join(',');
  const els = document.querySelectorAll(sel);
  const seen = new Set();
  const results = [];
  let n = 0;
  for (const el of els) {
    if (seen.has(el)) continue; seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (!el.offsetParent && el.tagName !== 'BODY') continue;
    n++;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || el.type || tag;
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim().slice(0,80) || '';
    results.push({ ref: '@e'+n, role, tag, label, value: el.value||'', frame: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }, interactive: true });
  }
  return results;
})()`;

const UI_SNAPSHOT_JS = `(() => {
  const interactiveSelector = [
    'button','input','select','textarea','a[href]',
    '[role="button"],[role="link"],[role="tab"]',
    '[contenteditable="true"]'
  ].join(',');
  
  const interactive = Array.from(document.querySelectorAll(interactiveSelector));
  const textNodes = [];
  
  // Find visible text nodes
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: node => {
        const text = node.textContent.trim();
        if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || !parent.offsetParent) return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  
  let node;
  while (node = walker.nextNode()) {
    textNodes.push(node.parentElement);
  }
  
  const all = [...new Set([...interactive, ...textNodes])];
  const results = [];
  let n = 0;
  
  for (const el of all.slice(0, 50)) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    
    const cs = window.getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const isInteractive = interactive.includes(el);
    
    n++;
    results.push({
      ref: '@e'+n,
      tag,
      role: el.getAttribute('role') || el.type || tag,
      text: el.textContent?.trim().slice(0,60) || '',
      interactive: isInteractive,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      color: cs.color,
      bg: cs.backgroundColor,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow === 'none' ? null : cs.boxShadow,
      opacity: cs.opacity,
    });
  }
  
  return results;
})()`;

// ── Run ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
