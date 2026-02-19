#!/usr/bin/env node
/**
 * Web demo — 在一个 Playwright session 里完成所有操作并截图
 * 输出 history.json 供 goal-runner report 使用
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = '/tmp/agent-control';
const HISTORY = path.join(DIR, 'history.json');
fs.mkdirSync(DIR, { recursive: true });

const history = [];
function addStep(s) { history.push(s); fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2)); }

async function screenshot(page, label) {
  const p = path.join(DIR, `step-${Date.now()}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

async function getTree(page) {
  const els = await page.$$eval('input, select, textarea, button, a, [role="button"], [type="radio"], [type="checkbox"]', nodes =>
    nodes.map((el, i) => {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || '';
      const name = el.getAttribute('name') || '';
      const value = el.value || el.textContent?.trim().slice(0, 50) || '';
      const role = type || tag;
      return { ref: `@e${i + 1}`, role, name, value: value.slice(0, 60) };
    })
  );
  return {
    count: els.length,
    elements: els,
    summary: els.map(e => `${e.ref} ${e.role} name="${e.name}" val="${e.value}"`).join('\n'),
    semantic: `${els.length} form elements. ` + els.filter(e => e.name).map(e => `${e.name}(${e.role})`).join(', '),
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // Step 1: Open form
  console.log('Step 1: Opening httpbin form...');
  await page.goto('https://httpbin.org/forms/post', { waitUntil: 'networkidle' });
  const ss1 = await screenshot(page);
  const tree1 = await getTree(page);
  addStep({
    type: 'observe', platform: 'web', timestamp: new Date().toISOString(),
    goal: '在 httpbin 表单页面填写一份披萨订单',
    note: '打开 httpbin 的 HTML 表单页面，看到一个披萨订单表单：Customer Name、Pizza Size (radio)、Toppings (checkbox)、Delivery Time、Comments',
    screenshot: ss1, elementCount: tree1.count, elements: tree1.summary, semantic: tree1.semantic,
  });
  console.log(`  ✅ ${tree1.count} elements, screenshot: ${ss1}`);

  // Step 2: Fill customer name
  console.log('Step 2: Filling customer name...');
  const beforeSS2 = await screenshot(page);
  const beforeTree2 = await getTree(page);
  await page.fill('input[name="custname"]', 'Momo');
  await page.waitForTimeout(300);
  const afterSS2 = await screenshot(page);
  const afterTree2 = await getTree(page);
  addStep({
    type: 'act-observe', platform: 'web', timestamp: new Date().toISOString(),
    goal: '在 httpbin 表单页面填写一份披萨订单',
    action: 'fill custname "Momo"',
    note: '表单第一个输入框是 Customer Name，填入 "Momo"',
    result: { ok: true, action: 'fill', ref: 'custname', value: 'Momo' },
    before: { screenshot: beforeSS2, elementCount: beforeTree2.count, elements: beforeTree2.summary, semantic: beforeTree2.semantic },
    after: { screenshot: afterSS2, elementCount: afterTree2.count, elements: afterTree2.summary, semantic: afterTree2.semantic },
    diff: 'Customer Name 从空变为 "Momo"',
  });
  console.log('  ✅ filled custname = Momo');

  // Step 3: Select pizza size
  console.log('Step 3: Selecting pizza size...');
  const beforeSS3 = await screenshot(page);
  const beforeTree3 = await getTree(page);
  await page.click('input[value="medium"]');
  await page.waitForTimeout(300);
  const afterSS3 = await screenshot(page);
  const afterTree3 = await getTree(page);
  addStep({
    type: 'act-observe', platform: 'web', timestamp: new Date().toISOString(),
    goal: '在 httpbin 表单页面填写一份披萨订单',
    action: 'click radio "medium"',
    note: 'Pizza Size 有 Small/Medium/Large 三个选项，选择 Medium',
    result: { ok: true, action: 'click', ref: 'medium', value: 'medium' },
    before: { screenshot: beforeSS3, elementCount: beforeTree3.count, elements: beforeTree3.summary, semantic: beforeTree3.semantic },
    after: { screenshot: afterSS3, elementCount: afterTree3.count, elements: afterTree3.summary, semantic: afterTree3.semantic },
    diff: 'Pizza Size radio 从未选中变为 Medium 选中',
  });
  console.log('  ✅ selected medium');

  // Step 4: Check topping
  console.log('Step 4: Selecting topping...');
  const beforeSS4 = await screenshot(page);
  await page.click('input[value="cheese"]');
  await page.waitForTimeout(300);
  const afterSS4 = await screenshot(page);
  addStep({
    type: 'act-observe', platform: 'web', timestamp: new Date().toISOString(),
    goal: '在 httpbin 表单页面填写一份披萨订单',
    action: 'click checkbox "cheese"',
    note: 'Toppings 有 Bacon/Cheese/Onion/Mushroom，勾选 Cheese',
    result: { ok: true, action: 'click', ref: 'cheese' },
    before: { screenshot: beforeSS4 },
    after: { screenshot: afterSS4 },
    diff: 'Cheese topping checkbox 变为选中状态',
  });
  console.log('  ✅ checked cheese');

  // Step 5: Fill delivery time
  console.log('Step 5: Filling delivery time...');
  const beforeSS5 = await screenshot(page);
  await page.fill('input[name="delivery"]', '19:30');
  await page.waitForTimeout(300);
  const afterSS5 = await screenshot(page);
  addStep({
    type: 'act-observe', platform: 'web', timestamp: new Date().toISOString(),
    goal: '在 httpbin 表单页面填写一份披萨订单',
    action: 'fill delivery "19:30"',
    note: '填写配送时间为 19:30',
    result: { ok: true, action: 'fill', ref: 'delivery', value: '19:30' },
    before: { screenshot: beforeSS5 },
    after: { screenshot: afterSS5 },
    diff: 'Delivery Time 从空变为 "19:30"',
  });
  console.log('  ✅ filled delivery = 19:30');

  // Step 6: Final observe
  console.log('Step 6: Final observe...');
  const ss6 = await screenshot(page);
  const tree6 = await getTree(page);
  addStep({
    type: 'observe', platform: 'web', timestamp: new Date().toISOString(),
    note: '表单填写完成：Customer=Momo, Size=Medium, Topping=Cheese, Delivery=19:30。准备提交。',
    screenshot: ss6, elementCount: tree6.count, elements: tree6.summary, semantic: tree6.semantic,
  });
  console.log(`  ✅ final state captured`);

  await browser.close();
  console.log(`\nDone! ${history.length} steps recorded.`);
})();
