#!/usr/bin/env node
const WebSocket = require('ws');
const http = require('http');

async function main() {
  const args = process.argv.slice(2);
  const action = args.find(a => !a.startsWith('--'));
  
  try {
    // Get CDP endpoint
    const wsUrl = await new Promise((resolve, reject) => {
      http.get('http://localhost:9229/json', res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          const pages = JSON.parse(data);
          if (!pages.length) return reject(new Error('No pages'));
          resolve(pages[0].webSocketDebuggerUrl);
        });
      }).on('error', reject);
    });
    
    // Connect WebSocket
    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const pending = new Map();
    
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WS timeout')), 5000);
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
    
    const send = (method, params = {}) => {
      return new Promise((res, rej) => {
        const id = ++msgId;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rej(new Error(`Timeout: ${method}`));
          }
        }, 10000);
      });
    };
    
    if (action === 'snapshot') {
      const result = await send('Runtime.evaluate', {
        expression: `(() => {
          const els = document.querySelectorAll('button,input,textarea,a');
          return Array.from(els).slice(0,10).map((el,i) => ({
            ref: 'e'+(i+1),
            tag: el.tagName.toLowerCase(),
            text: el.textContent?.trim().slice(0,50) || ''
          }));
        })()`,
        returnByValue: true
      });
      console.log(JSON.stringify(result.result.value, null, 2));
    } else if (action === 'screenshot') {
      const { data } = await send('Page.captureScreenshot');
      const path = args[1] || '/tmp/screenshot.png';
      require('fs').writeFileSync(path, Buffer.from(data, 'base64'));
      console.log(path);
    }
    
    ws.close();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
