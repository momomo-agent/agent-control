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

// Android: direct adb calls (skip Node process spawn)
function adbCmd(cmd) {
  try { return execSync(`adb shell '${cmd.replace(/'/g, "'\\''")}'`, { encoding: 'utf8', timeout: 15000 }).trim(); }
  catch (e) { return e.stdout?.trim() || ''; }
}
function androidSnap() {
  let xml = '';
  for (let i = 0; i < 3; i++) {
    try { xml = execSync('adb exec-out "uiautomator dump /proc/self/fd/1 2>/dev/null"', { encoding: 'utf8', timeout: 8000 }); } catch {}
    if (xml.includes('<node')) break;
    spawnSync('sleep', ['1']);
  }
  if (!xml.includes('<node')) return [];
  const els = []; let c = 0;
  const re = /<node\s+([^>]+?)(?:\/>|>)/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const a = m[1];
    const g = n => { const r = a.match(new RegExp(`${n}="([^"]*)"`)); return r ? r[1] : ''; };
    const text = g('text'), desc = g('content-desc'), cls = g('class'), bounds = g('bounds');
    const clickable = g('clickable') === 'true', focusable = g('focusable') === 'true';
    const bm = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!bm) continue;
    const [,x1,y1,x2,y2] = bm.map(Number);
    if (x2-x1 === 0 && y2-y1 === 0) continue;
    const isInteractive = clickable || (focusable && g('enabled') === 'true');
    if (!isInteractive && !text && !desc) continue;
    c++;
    els.push({ ref: `@e${c}`, role: cls.split('.').pop(), text: text || desc, clickable, cx: Math.round(x1+(x2-x1)/2), cy: Math.round(y1+(y2-y1)/2) });
  }
  return els;
}
function androidClick(ref, els) {
  const el = (els || androidSnapCache || []).find(e => e.ref === ref);
  if (!el) return false;
  adbCmd(`input tap ${el.cx} ${el.cy}`);
  return true;
}
function androidSS(p) {
  try { execSync(`adb exec-out screencap -p > "${p}"`, { timeout: 10000 }); return fs.existsSync(p); } catch { return false; }
}
let androidSnapCache = null;

// ── Ref finder ──
function findRef(els, hints) {
  if (!Array.isArray(els)) return null;
  for (const h of hints) {
    const lh = h.toLowerCase();
    const el = els.find(e =>
      (e.label||'').toLowerCase().includes(lh) ||
      (e.text||'').toLowerCase().includes(lh) ||
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
  const isAndroid = P === 'android';

  const doSnap = async () => {
    if (isAndroid) { androidSnapCache = androidSnap(); return androidSnapCache; }
    return await ac(P, 'snapshot', '-i');
  };

  switch (step.action) {
    case 'open': {
      if (step.app && isAndroid) {
        adbCmd(`monkey -p ${step.app} -c android.intent.category.LAUNCHER 1`);
        await sleep(1000);
        return { ok: true };
      }
      const url = (step.url || '').replace('$FLOWLAB', FLOWLAB);
      const r = await ac(P, 'open', url);
      if (!r.ok) return { ok: false, tag: 'DRIVER_ERROR', msg: r.error || 'open failed' };
      await sleep(1000);
      return { ok: true };
    }
    case 'snapshot': {
      let snap = await doSnap();
      if (isAndroid && (!Array.isArray(snap) || snap.length === 0)) {
        await sleep(3000); snap = await doSnap();
      }
      if (Array.isArray(snap) && snap.length > 0) { ctx.snap = snap; return { ok: true, snap }; }
      return { ok: false, tag: 'NOT_READY', msg: 'no elements' };
    }
    case 'screenshot': {
      const p = path.join(ctx.artifactsDir, `${step.label || 'screenshot'}.png`);
      if (isAndroid) { androidSS(p); return { ok: true, path: p }; }
      const r = await ac(P, 'screenshot', p);
      return { ok: true, path: p };
    }
    case 'wait': {
      await sleep(step.ms || 1000);
      return { ok: true };
    }
    case 'keys': case 'press': {
      const key = step.value || step.key || '';
      if (isAndroid) { const km = { home:'KEYCODE_HOME',back:'KEYCODE_BACK',enter:'KEYCODE_ENTER' }; adbCmd(`input keyevent ${km[key]||'KEYCODE_'+key.toUpperCase()}`); }
      else { await ac(P, 'press', key); }
      if (step.wait) await sleep(step.wait);
      return { ok: true };
    }
    case 'swipe': {
      if (isAndroid) { adbCmd('input swipe 540 1560 540 660 200'); }
      else { await ac(P, 'swipe', step.direction || 'up'); }
      if (step.wait) await sleep(step.wait);
      return { ok: true };
    }
    case 'shell': {
      if (isAndroid && step.cmd) { adbCmd(step.cmd); }
      else if (step.cmd) { try { execSync(step.cmd, { timeout: 10000 }); } catch {} }
      return { ok: true };
    }
    case 'fill': {
      const snap = await doSnap();
      const ref = findRef(snap || ctx.snap, step.find);
      if (!ref) return { ok: false, tag: 'NOT_FOUND', msg: `${step.find[0]} not found` };
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
      // Android: try cached snap first, only re-dump if not found
      if (isAndroid) {
        let snap = androidSnapCache || ctx.snap;
        let ref = findRef(snap, step.find);
        if (!ref) { snap = await doSnap(); ref = findRef(snap, step.find); }
        if (!ref) return { ok: false, tag: 'NOT_FOUND', msg: `${step.find[0]} not found` };
        return androidClick(ref, snap) ? { ok: true } : { ok: false, tag: 'NOT_FOUND', msg: `${ref} tap failed` };
      }
      const snap = await doSnap();
      const ref = findRef(snap || ctx.snap, step.find);
      if (!ref) return { ok: false, tag: 'NOT_FOUND', msg: `${step.find[0]} not found` };
      const r = await ac(P, 'click', ref);
      return r.ok ? { ok: true } : { ok: false, tag: 'DRIVER_ERROR', msg: r.error };
    }
    case 'verify': {
      let snap = isAndroid ? androidSnap() : await ac(P, 'snapshot');
      if (isAndroid && (!Array.isArray(snap) || snap.length < 3)) {
        await sleep(2000);
        snap = androidSnap();
      }
      if (step.contains) {
        const found = Array.isArray(snap) && snap.some(e => (e.value||e.text||e.label||'').includes(step.contains));
        return found ? { ok: true } : { ok: false, tag: 'ASSERT_FAIL', msg: `"${step.contains}" not found` };
      }
      if (step.find) {
        const ref = findRef(snap, step.find);
        return ref ? { ok: true } : { ok: false, tag: 'ASSERT_FAIL', msg: `${step.find[0]} not found` };
      }
      return { ok: true };
    }
    case 'verifyActivity': {
      if (isAndroid && step.contains) {
        for (let i = 0; i < 6; i++) {
          const out = adbCmd('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"');
          if (out.includes(step.contains)) return { ok: true };
          await sleep(1000);
        }
        const out = adbCmd('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"');
        return out.includes(step.contains) ? { ok: true } : { ok: false, tag: 'ASSERT_FAIL', msg: `"${step.contains}" not in: ${out.slice(0,120)}` };
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
