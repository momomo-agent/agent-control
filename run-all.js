#!/usr/bin/env node
/**
 * run-all.js — Run all flows in parallel, one per platform
 * Usage: node run-all.js [--json]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FLOWS_DIR = path.join(__dirname, 'flows');
const flows = fs.readdirSync(FLOWS_DIR).filter(f => f.endsWith('.json')).map(f => path.join(FLOWS_DIR, f));

if (!flows.length) { console.error('No flows found in flows/'); process.exit(1); }

const jsonMode = process.argv.includes('--json');
console.error(`▶ Running ${flows.length} flows in parallel...\n`);

const results = [];

// Web can run parallel; focus flows run sequentially (iOS first, then macOS)
const webFlows = [];
const focusFlows = [];
for (const f of flows) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (d.platform === 'web') webFlows.push(f);
  else focusFlows.push(f);
}
// Sort: ios before macos (ios needs clean focus)
focusFlows.sort((a, b) => {
  const pa = JSON.parse(fs.readFileSync(a, 'utf8')).platform;
  const pb = JSON.parse(fs.readFileSync(b, 'utf8')).platform;
  return pa === 'ios' ? -1 : pb === 'ios' ? 1 : 0;
});

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
  // All sequential: web first (fastest), then iOS, then macOS
  // Parallel causes focus conflicts on macOS
  const order = ['web', 'ios', 'macos', 'android'];
  const sorted = [...flows].sort((a, b) => {
    const pa = JSON.parse(fs.readFileSync(a, 'utf8')).platform;
    const pb = JSON.parse(fs.readFileSync(b, 'utf8')).platform;
    return order.indexOf(pa) - order.indexOf(pb);
  });
  for (const f of sorted) await runOne(f);

  const passed = results.filter(r => r.code === 0).length;
  console.error(`\n${passed}/${results.length} flows passed`);
  if (jsonMode) console.log(JSON.stringify(results.map(r => r.record).filter(Boolean), null, 2));
  process.exit(passed === results.length ? 0 : 1);
})();
