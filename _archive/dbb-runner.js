#!/usr/bin/env node
/**
 * agent-control DBB Runner — 执行 .ai/dbb/*.json scenario 文件
 *
 * Usage:
 *   node dbb-runner.js <scenario.json>
 *   node dbb-runner.js --all          # 跑所有 scenario
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = path.join(__dirname, 'cli.js');
const DBB_DIR = path.join(__dirname, '.ai', 'dbb');

function run(platform, argTokens, pid) {
  const argv = [CLI, '-p', platform, ...argTokens, ...(pid ? ['--pid', pid] : [])];
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('node', argv, { encoding: 'utf8', timeout: 30000 });
    const out = (r.stdout || '').trim();
    return { ok: r.status === 0 && out.length > 0, raw: out, data: safeParse(out) };
  } catch (err) {
    return { ok: false, raw: err.message, data: null };
  }
}

function safeParse(s) {
  try {
    // Handle multi-JSON output (chain commands)
    const lines = s.trim().split('\n');
    const jsons = [];
    let buf = '';
    for (const line of lines) {
      buf += line + '\n';
      try {
        jsons.push(JSON.parse(buf));
        buf = '';
      } catch {}
    }
    return jsons.length === 1 ? jsons[0] : jsons;
  } catch { return null; }
}

function getPID(appName) {
  try {
    return execSync(`pgrep -x "${appName}"`, { encoding: 'utf8' }).trim().split('\n')[0];
  } catch { return null; }
}

function evaluate(expr, ctx) {
  if (!expr) return true;
  try {
    const fn = new Function('elements', 'title', 'result', `return (${expr})`);
    return !!fn(ctx.elements, ctx.title, ctx.result);
  } catch { return false; }
}

function runScenario(scenarioPath) {
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const { id, name, platform, target, steps } = scenario;

  console.log(`\n━━━ ${id}: ${name} ━━━`);
  console.log(`Platform: ${platform} | Target: ${JSON.stringify(target)}`);

  let pid = null;
  if (target?.app) {
    pid = getPID(target.app);
    if (!pid) {
      console.log(`⚠️  ${target.app} not running, trying to launch...`);
      try {
        execSync(`open -a "${target.app}"`, { timeout: 5000 });
        execSync('sleep 2');
        pid = getPID(target.app);
      } catch {}
    }
    if (!pid) {
      console.log(`❌ Cannot find ${target.app}`);
      return { id, name, pass: false, error: 'app not found' };
    }
    console.log(`PID: ${pid}`);
  }

  const results = [];
  let elements = [];
  let title = '';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNum = i + 1;
    let tokens = [];
    let displayArgs = '';

    if (step.chain) {
      // Build token array with ';' separators
      for (let ci = 0; ci < step.chain.length; ci++) {
        if (ci > 0) tokens.push(';');
        const c = step.chain[ci];
        tokens.push(...c.action.split(/\s+/));
        if (c.ref) tokens.push(c.ref);
        if (c.text) tokens.push(c.text);
        if (c.url) tokens.push(c.url);
        if (c.path) tokens.push(c.path);
        if (c.flags) tokens.push(...c.flags);
      }
      displayArgs = tokens.join(' ');
    } else {
      tokens.push(...step.action.split(/\s+/));
      if (step.ref) tokens.push(step.ref);
      if (step.text) tokens.push(step.text);
      if (step.path) tokens.push(step.path);
      if (step.flags) tokens.push(...step.flags);
      if (step.url) tokens.push(step.url);
      displayArgs = tokens.join(' ');
    }

    const res = run(platform, tokens, pid);

    // Update context
    if (step.action === 'snapshot' || step.chain) {
      // For chain commands, find the last array result (snapshot output)
      const data = res.data;
      let snapshotData = null;
      if (Array.isArray(data)) {
        // Multi-JSON: find last array (snapshot result)
        for (let j = data.length - 1; j >= 0; j--) {
          if (Array.isArray(data[j])) { snapshotData = data[j]; break; }
        }
        // If data itself is array of elements (single snapshot)
        if (!snapshotData && data.length > 0 && data[0]?.ref) snapshotData = data;
      }
      if (snapshotData) {
        elements = snapshotData;
        const titleEl = elements.find(e => (e.value || '').includes('—') || (e.label || '').includes('—'));
        if (titleEl) title = titleEl.value || titleEl.label;
      }
    }

    // Evaluate expectation
    const ctx = { elements, title, result: res.data };
    const passed = res.ok && evaluate(step.expect, ctx);

    const icon = passed ? '✅' : '❌';
    console.log(`  ${icon} Step ${stepNum}: ${displayArgs}${step.expect ? ` [expect: ${step.expect}]` : ''}`);

    if (!passed && step.expect) {
      console.log(`     Context: title="${title}", elements=${elements.length}`);
    }

    results.push({ step: stepNum, action: displayArgs, ok: res.ok, passed, expect: step.expect || null });
  }

  const allPassed = results.every(r => r.passed);
  console.log(`\n${allPassed ? '✅' : '❌'} ${id}: ${allPassed ? 'PASSED' : 'FAILED'}`);

  // Write report
  const report = { id, name, platform, timestamp: new Date().toISOString(), pass: allPassed, steps: results };
  const reportPath = path.join(DBB_DIR, `${id}-report.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report: ${reportPath}`);

  return report;
}

// ── Main ──
const arg = process.argv[2];
if (!arg) {
  console.log('Usage: node dbb-runner.js <scenario.json | --all>');
  process.exit(0);
}

if (arg === '--all') {
  const files = fs.readdirSync(DBB_DIR).filter(f => f.endsWith('.json') && !f.includes('-report'));
  const reports = files.map(f => runScenario(path.join(DBB_DIR, f)));
  const total = reports.length;
  const passed = reports.filter(r => r.pass).length;
  console.log(`\n━━━ Summary: ${passed}/${total} passed ━━━`);
} else {
  const p = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
  runScenario(p);
}
