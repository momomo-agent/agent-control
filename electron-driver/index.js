#!/usr/bin/env node
const WebSocket = require('ws');
const http = require('http');

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

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9229/json', res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const ui = args.includes('--ui');
  const action = args.find(a => !a.startsWith('--'));
  const otherArgs = args.filter(a => a !== action && a !== '--ui');
  
  try {
    const wsUrl = await getCDPEndpoint();
    const cdp = await cdpConnect(wsUrl);
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
        const { data } = await cdp.send('Page.captureScreenshot');
        require('fs').writeFileSync(spath, Buffer.from(data, 'base64'));
        output = { ok: true, action: 'screenshot', path: spath };
        break;
      }
      case 'click':
      case 'dblclick':
      case 'rightclick': {
        const clickTarget = otherArgs[0];
        const clickJs = resolveRef(clickTarget) + (action === 'dblclick'
          ? `.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`
          : action === 'rightclick'
          ? `.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}))`
          : `.click()`);
        await cdp.evaluate(clickJs);
        output = { ok: true, action, ref: clickTarget };
        break;
      }
      case 'fill':
      case 'type': {
        const fillTarget = otherArgs[0];
        const fillText = otherArgs.slice(1).join(' ');
        const fillJs = `(() => {
          const el = ${resolveRefExpr(fillTarget)};
          const ns = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          ns.call(el, ${JSON.stringify(fillText)});
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
        })()`;
        await cdp.evaluate(fillJs);
        output = { ok: true, action: 'fill', ref: fillTarget, value: fillText };
        break;
      }
      case 'press': {
        const key = otherArgs[0] || 'Enter';
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key, code: 'Key' + key.charAt(0).toUpperCase() + key.slice(1),
          windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Tab' ? 9 : 0,
        });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
        output = { ok: true, action: 'press', key };
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
      case 'windows': {
        const targets = await getTargets();
        output = { ok: true, action: 'windows', targets: targets.map((t, i) => ({ index: i, title: t.title, type: t.type, url: t.url })) };
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

function getCDPEndpoint() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9229/json', res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const pages = JSON.parse(data);
        if (!pages.length) return reject(new Error('No pages found'));
        resolve(pages[0].webSocketDebuggerUrl);
      });
    }).on('error', reject);
  });
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
    results.push({ ref: 'e'+n, role, tag, label, value: el.value||'', frame: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }, interactive: true });
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
      ref: 'e'+n,
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
