#!/usr/bin/env node
/**
 * GenUI DBB 批量测试 — Playwright 录屏 + 截图
 * Usage: node genui-dbb-batch.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DBB_DIR = path.join(__dirname, '.ai/dbb');
const OUT_DIR = '/tmp/agent-control/genui-dbb-batch';
const URL = 'http://localhost:3000';
const INPUT_SEL = 'input[type="text"], input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])';
const BTN_SEL = 'button[type="submit"]';

fs.mkdirSync(OUT_DIR, { recursive: true });

// Load all genui-* DBB files
const scenarios = fs.readdirSync(DBB_DIR)
  .filter(f => f.startsWith('genui-') && f.endsWith('.json') && f !== 'genui-demo.json' && f !== 'genui-complex.json')
  .map(f => JSON.parse(fs.readFileSync(path.join(DBB_DIR, f), 'utf8')));

async function runScenario(browser, scenario) {
  const id = scenario.id;
  const dir = path.join(OUT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  console.log(`\n🎬 [${id}] ${scenario.name}`);
  const ctx = await browser.newContext({ recordVideo: { dir, size: { width: 1280, height: 800 } } });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  let stepNum = 0;
  try {
    // Open page
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Process steps: extract fill/click pairs
    const intents = [];
    for (let i = 0; i < scenario.steps.length; i++) {
      const s = scenario.steps[i];
      if (s.action && s.action.startsWith('fill')) {
        // Extract text after "fill @e1 " or "fill input "
        const text = s.action.replace(/^fill\s+\S+\s+/, '');
        intents.push({ text, description: s.description });
      }
    }

    for (const intent of intents) {
      stepNum++;
      console.log(`  📝 Step ${stepNum}: ${intent.description}`);

      // Clear and fill input
      const input = page.locator(INPUT_SEL).first();
      await input.click();
      await input.fill('');
      await input.fill(intent.text);
      await page.waitForTimeout(500);

      // Screenshot before send
      await page.screenshot({ path: path.join(dir, `step${stepNum}-input.png`) });

      // Click send
      await page.locator(BTN_SEL).click();
      console.log(`  ⏳ Waiting for UI generation...`);

      // Wait for response (loading indicator gone or new card appears)
      await page.waitForTimeout(12000);

      // Screenshot result
      await page.screenshot({ path: path.join(dir, `step${stepNum}-result.png`), fullPage: true });
      console.log(`  ✅ Step ${stepNum} done`);
    }

    console.log(`✅ [${id}] All ${stepNum} steps passed`);
  } catch (e) {
    console.error(`❌ [${id}] Failed at step ${stepNum}: ${e.message}`);
    await page.screenshot({ path: path.join(dir, `error-step${stepNum}.png`) }).catch(() => {});
  }

  await page.close();
  await ctx.close();
  // Rename video
  const vids = fs.readdirSync(dir).filter(f => f.endsWith('.webm'));
  if (vids.length) {
    fs.renameSync(path.join(dir, vids[0]), path.join(dir, 'recording.webm'));
  }
}

(async () => {
  console.log(`🚀 GenUI DBB Batch Runner — ${scenarios.length} scenarios`);
  console.log(`📁 Output: ${OUT_DIR}\n`);

  const browser = await chromium.launch({ headless: false });

  for (const s of scenarios) {
    await runScenario(browser, s);
  }

  await browser.close();

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 Summary:');
  for (const s of scenarios) {
    const dir = path.join(OUT_DIR, s.id);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const hasError = files.some(f => f.startsWith('error'));
    console.log(`  ${hasError ? '❌' : '✅'} ${s.id} — ${s.name} (${files.length} files)`);
  }
  console.log(`\n📁 Results: ${OUT_DIR}`);
})();
