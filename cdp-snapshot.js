#!/usr/bin/env node
/**
 * Lightweight CDP snapshot — connects to a browser's remote debugging port,
 * gets the active tab's DOM as an indented accessibility tree.
 * Used by `screen` command when drilling into a browser app.
 *
 * Usage: node cdp-snapshot.js [--port 9222] [--json]
 */

const http = require('http');

const args = process.argv.slice(2);
let port = 9222;
let jsonMode = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i+1]) port = parseInt(args[i+1]);
  if (args[i] === '--json') jsonMode = true;
}

async function getTargets(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function cdpSend(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP timeout')), 10000);
    ws.on('message', function handler(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.removeListener('message', handler);
          clearTimeout(timeout);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch(e) {}
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function getSnapshot(port) {
  const WebSocket = require('ws');

  // Find active page target
  const targets = await getTargets(port);
  const page = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('No active page found');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  try {
    // Enable Runtime
    await cdpSend(ws, 1, 'Runtime.enable');

    // Get page info
    const { result: titleResult } = await cdpSend(ws, 2, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ title: document.title, url: location.href })'
    });
    const pageInfo = JSON.parse(titleResult.value);

    // Get interactive elements as structured tree
    const { result: snapshotResult } = await cdpSend(ws, 3, 'Runtime.evaluate', {
      expression: `(function() {
        const INTERACTIVE = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],[role="combobox"],[role="option"],[role="slider"],[contenteditable="true"]';
        const LANDMARK = 'nav,main,aside,header,footer,section,article,form,[role="navigation"],[role="main"],[role="complementary"],[role="banner"],[role="contentinfo"],[role="search"],[role="form"],[role="region"]';
        const HEADING = 'h1,h2,h3,h4,h5,h6,[role="heading"]';

        let counter = 0;
        function scan(root, depth, maxDepth) {
          if (depth > maxDepth) return [];
          const results = [];
          const children = root.children || [];

          for (const el of children) {
            if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML' && getComputedStyle(el).position === 'static') continue;

            const isInteractive = el.matches(INTERACTIVE);
            const isLandmark = el.matches(LANDMARK);
            const isHeading = el.matches(HEADING);

            if (isInteractive) {
              counter++;
              const role = el.getAttribute('role') || el.tagName.toLowerCase();
              const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60) || '';
              const value = el.value || el.getAttribute('aria-checked') || '';
              results.push({ ref: '@w' + counter, role, label, value: value || undefined, depth });
            } else if (isLandmark || isHeading) {
              const role = el.getAttribute('role') || el.tagName.toLowerCase();
              const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (isHeading ? el.textContent?.trim().slice(0, 60) : '') || '';
              results.push({ role, label, depth, children: scan(el, depth + 1, maxDepth) });
            } else {
              // Recurse into non-landmark containers
              const sub = scan(el, depth, maxDepth);
              results.push(...sub);
            }
          }
          return results;
        }

        const tree = scan(document.body, 0, 6);
        return JSON.stringify(tree);
      })()`
    });

    const tree = JSON.parse(snapshotResult.value);
    ws.close();
    return { pageInfo, tree };
  } finally {
    ws.close();
  }
}

function formatTree(nodes, baseIndent = '') {
  let lines = [];
  for (const node of nodes) {
    const indent = baseIndent + '  '.repeat(node.depth || 0);
    if (node.ref) {
      // Interactive element
      const val = node.value ? ` val="${node.value}"` : '';
      const label = node.label ? ` "${node.label}"` : '';
      lines.push(`${indent}${node.ref} ${node.role}${label}${val}`);
    } else {
      // Landmark/heading
      const label = node.label ? ` "${node.label}"` : '';
      lines.push(`${indent}- ${node.role}${label}`);
      if (node.children?.length) {
        lines.push(...formatTree(node.children, baseIndent));
      }
    }
  }
  return lines;
}

(async () => {
  try {
    const { pageInfo, tree } = await getSnapshot(port);

    if (jsonMode) {
      console.log(JSON.stringify({ pageInfo, tree }, null, 2));
    } else {
      console.log(`  Web Content: "${pageInfo.title}"`);
      console.log(`  URL: ${pageInfo.url}`);
      const lines = formatTree(tree, '    ');
      if (lines.length === 0) {
        console.log('    (no interactive elements)');
      } else {
        console.log(lines.join('\n'));
      }
    }
  } catch(e) {
    console.error(`cdp-snapshot: ${e.message}`);
    process.exit(1);
  }
})();
