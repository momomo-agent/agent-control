#!/usr/bin/env node
/**
 * dsl-runner.js — Execute flows defined in JSON DSL
 * Usage: node dsl-runner.js flows/flowlab-signup.json [--json]
 */
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { RunRecord } = require('./run-record');
const { canRetry, getPolicy } = require('./retry');

const CLI = path.join(__dirname, 'cli.js');
const MAC_BIN = path.join(__dirname, 'macos-driver', '.build', 'debug', 'agent-control');
const FLOWLAB = `file://${path.join(__dirname, 'flowlab', 'index.html')}`;
const DAEMON_PORT = 3901;
const http = require('http');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpCmd(args) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ args });
    const req = http.request({
      hostname: '127.0.0.1', port: DAEMON_PORT, path: '/cmd',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function ac(platform, ...args) {
  if (platform === 'web') return httpCmd(args);
  const r = spawnSync('node', [CLI, '--platform', platform, ...args], { encoding: 'utf8', timeout: 30000 });
  try { return JSON.parse((r.stdout || '').trim()); } catch { return { raw: r.stdout, stderr: r.stderr }; }
}

// iOS: direct macOS AX binary for Simulator
function simPID() {
  try { return execSync('pgrep -x Simulator', { encoding: 'utf8', timeout: 2000 }).trim().split('\n')[0]; }
  catch { return null; }
}
function focusSim() {
  try { execSync('osascript -e \'tell application "Simulator" to activate\'', { timeout: 3000 }); } catch {}
}

function iosSnap() {
  focusSim();
  function doSnap() {
    const r = spawnSync(MAC_BIN, ['snapshot', '--pid', simPID()], { encoding: 'utf8', timeout: 15000 });
    try {
      const els = JSON.parse(r.stdout);
      const chrome = ['Action','Volume Up','Volume Down','Sleep/Wake','Ring/Silent','Home','Save Screen','Rotate'];
      return els.filter(e => !chrome.includes(e.label));
    } catch { return []; }
  }
  let result = doSnap();
  if (result.length < 3) {
    spawnSync('sleep', ['0.5']);
    focusSim();
    result = doSnap();
  }
  return result;
}
function iosClick(ref) {
  const r = spawnSync(MAC_BIN, ['click', ref, '--pid', simPID()], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0;
}
function iosSS(p) {
  spawnSync('xcrun', ['simctl', 'io', 'booted', 'screenshot', p], { timeout: 10000 });
  return fs.existsSync(p);
}

// ── Ref finder ──
function findRef(els, hints) {
  if (!Array.isArray(els)) return null;
  for (const h of hints) {
    const lh = h.toLowerCase();
    const el = els.find(e =>
      (e.label||'').toLowerCase().includes(lh) ||
      (e.name||'').toLowerCase().includes(lh) ||
      (e.role||'').toLowerCase().includes(lh) ||
      (e.value||'').toLowerCase().includes(lh)
    );
    if (el) return el.ref;
  }
  return null;
}

// ── DSL Step Executor ──
async function execStep(step, ctx) {
  const P = ctx.platform;
  const isIOS = P === 'ios';

  const doSnap = async () => {
    if (isIOS) return iosSnap();
    return await ac(P, 'snapshot', '-i');
  };

  switch (step.action) {
    case 'open': {
      const url = (step.url || '').replace('$FLOWLAB', FLOWLAB);
      const r = await ac(P, 'open', url);
      if (!r.ok) return { ok: false, tag: 'DRIVER_ERROR', msg: r.error || 'open failed' };
      await sleep(1000);
      return { ok: true };
    }
    case 'snapshot': {
      const snap = await doSnap();
      if (Array.isArray(snap) && snap.length > 0) { ctx.snap = snap; return { ok: true, snap }; }
      return { ok: false, tag: 'NOT_READY', msg: 'no elements' };
    }
    case 'screenshot': {
      const p = path.join(ctx.artifactsDir, `${step.label || 'screenshot'}.png`);
      if (isIOS) { iosSS(p); return { ok: true, path: p }; }
      const r = await ac(P, 'screenshot', p);
      return { ok: true, path: p };
    }
    case 'wait': {
      await sleep(step.ms || 1000);
      return { ok: true };
    }
    case 'keys': {
      const r = await ac(P, 'press', step.value);
      if (step.wait) await sleep(step.wait);
      return { ok: true };
    }
    case 'fill': {
      const snap = await doSnap();
      const ref = findRef(snap || ctx.snap, step.find);
      if (!ref) return { ok: false, tag: 'NOT_FOUND', msg: `${step.find[0]} not found` };
      if (isIOS) { iosClick(ref); return { ok: true }; } // iOS fill = click (no text input in Settings)
      const r = await ac(P, 'fill', ref, step.value);
      return r.ok ? { ok: true } : { ok: false, tag: 'DRIVER_ERROR', msg: r.error };
    }
    case 'select': {
      const snap = await doSnap();
      const ref = findRef(snap || ctx.snap, step.find);
      if (!ref) return { ok: false, tag: 'NOT_FOUND', msg: `${step.find[0]} not found` };
      const r = await ac(P, 'select', ref, step.value);
      return r.ok ? { ok: true } : { ok: false, tag: 'DRIVER_ERROR', msg: r.error };
    }
    case 'click': {
      const snap = await doSnap();
      const ref = findRef(snap || ctx.snap, step.find);
      if (!ref) return { ok: false, tag: 'NOT_FOUND', msg: `${step.find[0]} not found` };
      if (isIOS) { iosClick(ref); return { ok: true }; }
      const r = await ac(P, 'click', ref);
      return r.ok ? { ok: true } : { ok: false, tag: 'DRIVER_ERROR', msg: r.error };
    }
    case 'verify': {
      if (isIOS) focusSim();
      const snap = isIOS ? iosSnap() : await ac(P, 'snapshot');
      if (step.contains) {
        const found = Array.isArray(snap) && snap.some(e => (e.value||'').includes(step.contains));
        return found ? { ok: true } : { ok: false, tag: 'ASSERT_FAIL', msg: `"${step.contains}" not found` };
      }
      if (step.find) {
        const ref = findRef(snap, step.find);
        return ref ? { ok: true } : { ok: false, tag: 'ASSERT_FAIL', msg: `${step.find[0]} not found` };
      }
      return { ok: true };
    }
    default:
      return { ok: false, tag: 'UNKNOWN', msg: `unknown action: ${step.action}` };
  }
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);
  const flowFile = args.find(a => a.endsWith('.json'));
  if (!flowFile) { console.error('Usage: node dsl-runner.js <flow.json> [--json]'); process.exit(1); }

  const flow = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
  const P = flow.platform;
  const run = new RunRecord(P, flow.name);
  const ctx = { platform: P, snap: null, artifactsDir: run.artifactsDir };

  console.error(`▶ DSL flow "${flow.name}" on ${P} [${run.runId}]`);

  // Setup
  if (flow.setup) {
    const s = run.step('setup', {});
    try {
      if (flow.setup.exec) execSync(flow.setup.exec, { timeout: 15000 });
      if (flow.setup.wait) await sleep(flow.setup.wait);
      if (flow.setup.keys) await ac(P, 'press', flow.setup.keys);
      if (flow.setup.postWait) await sleep(flow.setup.postWait);
      s.succeed({});
    } catch (e) { s.fail('DRIVER_ERROR', e.message); }
  }

  // Steps
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const label = step.label ? `${step.action}-${step.label}` : `${step.action}-${i}`;
    const policy = step.retry ? getPolicy('NOT_FOUND') : null;
    const maxTries = policy ? 1 + policy.retries : 1;

    let result, s;
    for (let t = 0; t < maxTries; t++) {
      const name = t === 0 ? label : `${label}:retry${t}`;
      s = run.step(name, step);
      result = await execStep(step, ctx);
      if (result.ok) { s.succeed(result); break; }
      s.fail(result.tag || 'UNKNOWN', result.msg || '');
      if (t < maxTries - 1) { s.retry(); await sleep(policy.delayMs); }
    }
    if (!result.ok && !step.optional) break;
  }

  run.finish();
  run.save();
  if (args.includes('--json')) console.log(JSON.stringify(run.toJSON(), null, 2));
  else { console.log(run.printSummary()); console.log(`Record: ${path.join(run.dir, 'record.json')}`); }
  process.exit(run.status === 'passed' ? 0 : 1);
}

main();
