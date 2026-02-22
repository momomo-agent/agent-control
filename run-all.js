#!/usr/bin/env node
/**
 * run-all.js — Run all flows in parallel, one per platform
 * Usage: node run-all.js [--json]
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FLOWS_DIR = path.join(__dirname, 'flows');
const flows = fs.readdirSync(FLOWS_DIR).filter(f => f.endsWith('.json')).map(f => path.join(FLOWS_DIR, f));

if (!flows.length) { console.error('No flows found in flows/'); process.exit(1); }

function canRun(flowData) {
  const p = flowData.platform;
  // Flows with explicit env tag: skip unless --env matches
  if (flowData.env) return process.argv.includes('--env') && process.argv[process.argv.indexOf('--env') + 1] === flowData.env;
  // Android: need adb with at least one device attached
  if (p === 'android') {
    try {
      const out = execSync('adb devices 2>/dev/null', { timeout: 3000, encoding: 'utf8', stdio: 'pipe' });
      return /\t(device|emulator)/.test(out);
    } catch { return false; }
  }
  // Web flows with localhost setup: check the exact URL responds
  if (flowData.setup?.url && /localhost/.test(flowData.setup.url)) {
    try {
      execSync(`curl -sf --max-time 2 "${flowData.setup.url}" >/dev/null 2>&1`);
      return true;
    } catch { return false; }
  }
  return true;
}

const jsonMode = process.argv.includes('--json');
const results = [];

// Pre-check which flows can run
const runnable = [];
const skipped = [];
for (const f of flows) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const name = path.basename(f, '.json');
  if (canRun(d)) { runnable.push(f); }
  else { skipped.push(name); results.push({ name, code: -1, record: null, skipped: true }); }
}
if (skipped.length) console.error(`⏭ Skipped (env unavailable): ${skipped.join(', ')}`);
console.error(`▶ Running ${runnable.length}/${flows.length} flows...\n`);

function runOne(f) {
  return new Promise(resolve => {
    const name = path.basename(f, '.json');
    let stdout = '', stderr = '';
    const child = spawn('node', [path.join(__dirname, 'dsl-runner.js'), f, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      let record; try { record = JSON.parse(stdout); } catch { record = null; }
      const sum = record ? record.summary : null;
      const icon = code === 0 ? '✅' : '❌';
      const steps = sum ? `${sum.passed}/${sum.total}` : '?';
      const time = sum && sum.totalMs ? (sum.totalMs / 1000).toFixed(1) + 's' : '-';
      console.error(`${icon} ${name} — ${steps} (${time})`);
      results.push({ name, code, record });
      resolve();
    });
  });
}

(async () => {
  const order = ['web', 'ios', 'macos', 'android'];
  const sorted = [...runnable].sort((a, b) => {
    const pa = JSON.parse(fs.readFileSync(a, 'utf8')).platform;
    const pb = JSON.parse(fs.readFileSync(b, 'utf8')).platform;
    return order.indexOf(pa) - order.indexOf(pb);
  });
  for (const f of sorted) await runOne(f);

  const ran = results.filter(r => !r.skipped);
  const passed = ran.filter(r => r.code === 0).length;
  const skipNote = skipped.length ? `, ${skipped.length} skipped` : '';
  console.error(`\n${passed}/${ran.length} flows passed${skipNote}`);
  if (jsonMode) console.log(JSON.stringify(results.map(r => r.record).filter(Boolean), null, 2));
  process.exit(passed === ran.length ? 0 : 1);
})();
