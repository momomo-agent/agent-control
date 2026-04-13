#!/usr/bin/env node
const WebSocket = require('ws');
const http = require('http');

const args = process.argv.slice(2);
const action = args[0];

http.get('http://localhost:9229/json', res => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    const pages = JSON.parse(data);
    const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
    
    ws.on('open', () => {
      if (action === 'snapshot') {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: 'Array.from(document.querySelectorAll("button,input")).slice(0,5).map((el,i)=>({ref:"e"+(i+1),tag:el.tagName,text:el.textContent?.trim()||""}))',
            returnByValue: true
          }
        }));
      }
    });
    
    ws.on('message', msg => {
      const data = JSON.parse(msg);
      if (data.result) {
        console.log(JSON.stringify(data.result.result.value, null, 2));
        ws.close();
        process.exit(0);
      }
    });
    
    setTimeout(() => {
      console.error('Timeout');
      process.exit(1);
    }, 5000);
  });
});
