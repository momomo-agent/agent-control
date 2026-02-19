const {chromium} = require('playwright');
(async()=>{
  const b = await chromium.launch({headless:true});
  const p = await b.newPage();
  await p.goto('file:///Users/kenefe/LOCAL/momo-agent/agent-control/flowlab/index.html');
  console.log('title:', await p.title());
  const els = await p.locator('input,select,button').count();
  console.log('interactive elements:', els);
  await b.close();
  console.log('OK');
})();
