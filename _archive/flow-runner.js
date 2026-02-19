#!/usr/bin/env node
/**
 * flow-runner.js — 执行 golden flow + 产出 run record
 *
 * Usage:
 *   node flow-runner.js --platform web --flow flowlab-signup
 *   node flow-runner.js --platform web --flow flowlab-signup --json
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { RunRecord } = require('./run-record');
const { canRetry, getPolicy } = require('./retry');

const CLI = path.join(__dirname, 'cli.js');
const FLOWLAB = `file://${path.join(__dirname, 'flowlab', 'index.html')}`;
const DAEMON_PORT = 3901;

// ── Helpers ──

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
    req.write(data); req.end();
  });
}

async function ac(platform, ...args) {
  if (platform === 'web') return httpCmd(args);
  const r = spawnSync('node', [CLI, '--platform', platform, ...args], { encoding: 'utf8', timeout: 30000 });
  const out = (r.stdout || '').trim();
  try { return JSON.parse(out); } catch { return { raw: out, stderr: r.stderr }; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Retry wrapper ──
// stepFn(s) should call s.succeed() or s.fail(tag, msg). Returns true if passed.
async function withRetry(run, action, params, stepFn, fixFns = {}) {
  let s = run.step(action, params);
  await stepFn(s);
  if (s.raw.status === 'passed') return s;

  const tag = s.raw.failureTag;
  const policy = getPolicy(tag);
  if (!policy) return s; // not retryable

  for (let i = 0; i < policy.retries; i++) {
    // Run fix action if available
    const fix = fixFns[policy.fix];
    if (fix) await fix();
    await sleep(policy.delayMs);

    // Retry: create new step with same action
    s.retry();
    s = run.step(`${action}:retry${i + 1}`, params);
    await stepFn(s);
    if (s.raw.status === 'passed') return s;
  }
  return s; // still failed after retries
}

// ── Flows ──

const flows = {
  'flowlab-signup': async (run) => {
    const P = run.platform;

    // Step 1: Open page
    let s = run.step('open', { url: FLOWLAB });
    const openRes = await ac(P, 'open', FLOWLAB);
    if (openRes.ok) s.succeed(openRes);
    else { s.fail('DRIVER_ERROR', openRes.error || 'open failed'); return; }
    await sleep(1000);

    // Step 2: Snapshot (retryable: NOT_READY)
    let snap;
    s = await withRetry(run, 'snapshot', { interactive: true }, async (st) => {
      snap = await ac(P, 'snapshot', '-i');
      if (Array.isArray(snap) && snap.length > 0) {
        st.artifact('snapshot.json', snap);
        st.succeed({ count: snap.length });
      } else { snap = null; st.fail('NOT_READY', 'no elements found'); }
    }, { resnapshot: async () => sleep(1000) });
    if (!snap) return;

    // Step 3: Screenshot initial
    s = run.step('screenshot', { label: 'initial' });
    const ssPath = path.join(run.artifactsDir, 'step-2-initial.png');
    const ssRes = await ac(P, 'screenshot', ssPath);
    if (ssRes.ok) s.succeed({ path: ssRes.path }); else s.fail('DRIVER_ERROR', ssRes.error);

    // Step 4-6: Fill form fields
    for (const [label, hints, val] of [
      ['fill-name', ['text'], 'Test User'],
      ['fill-email', ['email'], 'test@flowlab.dev'],
      ['fill-password', ['password'], 'Test1234!'],
    ]) {
      s = await withRetry(run, label, {}, async (st) => {
        const curSnap = await ac(P, 'snapshot', '-i');
        const ref = findRef(curSnap || snap, hints);
        if (!ref) { st.fail('NOT_FOUND', `${label} input not found`); return; }
        const r = await ac(P, 'fill', ref, val);
        if (r.ok) st.succeed(r); else st.fail('DRIVER_ERROR', r.error);
      }, { resnapshot: () => sleep(500) });
      if (s.raw.status !== 'passed') return;
    }

    // Step 7: Select role (retryable: NOT_FOUND)
    s = await withRetry(run, 'select-role', {}, async (st) => {
      const curSnap = await ac(P, 'snapshot', '-i');
      const ref = findRef(curSnap || snap, ['select-one', 'select']);
      if (!ref) { st.fail('NOT_FOUND', 'role select not found'); return; }
      const r = await ac(P, 'select', ref, 'developer');
      if (r.ok) st.succeed(r); else st.fail('DRIVER_ERROR', r.error);
    }, { resnapshot: () => sleep(500) });
    if (s.raw.status !== 'passed') return;

    // Step 8: Check terms (retryable: NOT_FOUND)
    s = await withRetry(run, 'check-terms', {}, async (st) => {
      const curSnap = await ac(P, 'snapshot', '-i');
      const ref = findRef(curSnap || snap, ['checkbox']);
      if (!ref) { st.fail('NOT_FOUND', 'terms checkbox not found'); return; }
      const r = await ac(P, 'click', ref);
      if (r.ok) st.succeed(r); else st.fail('DRIVER_ERROR', r.error);
    }, { resnapshot: () => sleep(500) });

    // Step 9: Click signup
    const btnRef = findRef(snap, ['Create Account']);
    s = run.step('click-signup', { ref: btnRef });
    if (!btnRef) { s.fail('NOT_FOUND', 'signup button not found'); return; }
    const cb = await ac(P, 'click', btnRef);
    if (cb.ok) s.succeed(cb); else s.fail('DRIVER_ERROR', cb.error);
    await sleep(500);

    // Step 10: Verify login
    s = run.step('verify-login', {});
    const snap2 = await ac(P, 'snapshot', '-i');
    s.artifact('post-login-snapshot.json', snap2);
    const hasLogout = Array.isArray(snap2) && snap2.some(e => (e.label || '').toLowerCase().includes('log out'));
    if (hasLogout) s.succeed({ loggedIn: true });
    else s.fail('ASSERT_FAIL', 'logout button not found after signup');

    // Step 11: Screenshot logged-in
    s = run.step('screenshot', { label: 'logged-in' });
    const ss2 = path.join(run.artifactsDir, 'step-10-logged-in.png');
    const r2 = await ac(P, 'screenshot', ss2);
    if (r2.ok) s.succeed({ path: r2.path }); else s.fail('DRIVER_ERROR', r2.error);

    // Step 12: Create new item
    const addRef = findRef(snap2, ['New Item', '+']);
    s = run.step('click-new-item', { ref: addRef });
    if (!addRef) { s.fail('NOT_FOUND', 'add item button not found'); return; }
    await ac(P, 'click', addRef); await sleep(500);
    s.succeed({ ref: addRef });

    // Step 13: Fill item title
    s = run.step('fill-item-title', {});
    const snap3 = await ac(P, 'snapshot', '-i');
    const titleRef = findRef(snap3, ['Item title', 'text']);
    if (!titleRef) { s.fail('NOT_FOUND', 'item title input not found'); return; }
    const ft = await ac(P, 'fill', titleRef, 'My First Item');
    if (ft.ok) s.succeed(ft); else s.fail('DRIVER_ERROR', ft.error);

    // Step 14: Save
    const saveRef = findRef(snap3, ['Save']);
    s = run.step('save-item', { ref: saveRef });
    if (!saveRef) { s.fail('NOT_FOUND', 'save button not found'); return; }
    await ac(P, 'click', saveRef); await sleep(500);
    s.succeed({});

    // Step 15: Verify item
    s = run.step('verify-item', {});
    const snap4 = await ac(P, 'snapshot');
    const found = Array.isArray(snap4) && snap4.some(e => (e.label || '').includes('My First Item'));
    s.artifact('final-snapshot.json', snap4);
    if (found) s.succeed({ itemVisible: true });
    else s.fail('ASSERT_FAIL', '"My First Item" not found in list');

    // Step 16: Final screenshot
    s = run.step('screenshot', { label: 'final' });
    const ss3 = path.join(run.artifactsDir, 'step-15-final.png');
    await ac(P, 'screenshot', ss3);
    s.succeed({ path: ss3 });
  },
  'textedit-crud': async (run) => {
    const P = run.platform;

    // Step 1: Open TextEdit
    let s = run.step('open-textedit', {});
    try {
      execSync('open -a TextEdit', { timeout: 5000 });
      await sleep(1500);
      // Cmd+N for new doc
      const pr = await ac(P, 'press', 'Meta+n');
      await sleep(1000);
      s.succeed({});
    } catch (e) { s.fail('DRIVER_ERROR', e.message); return; }

    // Step 2: Snapshot (retryable: NOT_READY)
    let snap;
    s = await withRetry(run, 'snapshot', {}, async (st) => {
      snap = await ac(P, 'snapshot', '-i');
      if (Array.isArray(snap) && snap.length > 0) { st.artifact('snapshot.json', snap); st.succeed({ count: snap.length }); }
      else { snap = null; st.fail('NOT_READY', 'no elements'); }
    }, { resnapshot: () => sleep(500) });
    if (!snap) return;

    // Step 3: Screenshot initial
    s = run.step('screenshot', { label: 'initial' });
    const ss1 = path.join(run.artifactsDir, 'step-2-initial.png');
    await ac(P, 'screenshot', ss1);
    s.succeed({ path: ss1 });

    // Step 4: Fill text (retryable: NOT_FOUND)
    s = await withRetry(run, 'fill-text', {}, async (st) => {
      const curSnap = await ac(P, 'snapshot', '-i');
      const ref = findRef(curSnap || snap, ['TextArea', 'Text View']);
      if (!ref) { st.fail('NOT_FOUND', 'text area not found'); return; }
      const fr = await ac(P, 'fill', ref, 'Hello from agent-control!');
      if (fr.ok) st.succeed(fr); else st.fail('DRIVER_ERROR', fr.error);
    }, { resnapshot: () => sleep(500) });

    // Step 5: Verify text
    s = run.step('verify-text', {});
    const snap2 = await ac(P, 'snapshot', '-i');
    s.artifact('after-fill.json', snap2);
    const hasText = Array.isArray(snap2) && snap2.some(e => (e.value || '').includes('Hello from agent-control'));
    if (hasText) s.succeed({ textFound: true });
    else s.fail('ASSERT_FAIL', 'typed text not found');

    // Step 6: Edit — select all + retype
    s = run.step('edit-text', {});
    await ac(P, 'press', 'Meta+a');
    await sleep(200);
    const textRef2 = findRef(snap2, ['TextArea', 'Text View']);
    const fr2 = await ac(P, 'fill', textRef2 || textRef, 'Edited by agent-control!');
    if (fr2.ok) s.succeed(fr2); else s.fail('DRIVER_ERROR', fr2.error);

    // Step 7: Verify edit
    s = run.step('verify-edit', {});
    const snap3 = await ac(P, 'snapshot', '-i');
    s.artifact('after-edit.json', snap3);
    const edited = Array.isArray(snap3) && snap3.some(e => (e.value || '').includes('Edited by agent-control'));
    if (edited) s.succeed({ editVerified: true });
    else s.fail('ASSERT_FAIL', 'edited text not found');

    // Step 8: Final screenshot
    s = run.step('screenshot', { label: 'final' });
    const ss2 = path.join(run.artifactsDir, 'step-7-final.png');
    await ac(P, 'screenshot', ss2);
    s.succeed({ path: ss2 });

    // Step 9: Close without saving (Cmd+W, then Cmd+Delete to discard)
    s = run.step('close-doc', {});
    await ac(P, 'press', 'Meta+w');
    await sleep(500);
    // If save dialog appears, press "Don't Save" (Cmd+D on macOS save dialog)
    await ac(P, 'press', 'Meta+d');
    await sleep(300);
    s.succeed({});
  },
  'settings-nav': async (run) => {
    // iOS: use macOS driver on Simulator PID for reliable AX
    const simPID = () => { try { return execSync('pgrep -x Simulator', { encoding: 'utf8', timeout: 2000 }).trim().split('\n')[0]; } catch { return null; } };
    const focusSim = () => {
      // Re-foreground Settings + activate Simulator window for AX access
      try { execSync('xcrun simctl launch booted com.apple.Preferences', { timeout: 3000 }); } catch {}
      try { execSync('open -a Simulator', { timeout: 3000 }); } catch {}
    };
    const macBin = path.join(__dirname, 'macos-driver', '.build', 'debug', 'agent-control');
    const macSnap = async () => {
      focusSim(); await sleep(500);
      const r = spawnSync(macBin, ['snapshot', '--pid', simPID()], { encoding: 'utf8', timeout: 15000 });
      try { return JSON.parse(r.stdout); } catch { return []; }
    };
    const macClick = async (ref) => {
      const r = spawnSync(macBin, ['click', ref, '--pid', simPID()], { encoding: 'utf8', timeout: 5000 });
      try { return JSON.parse(r.stdout); } catch { return { ok: r.status === 0 }; }
    };
    const iosSS = (p) => { spawnSync('xcrun', ['simctl', 'io', 'booted', 'screenshot', p], { timeout: 10000 }); return { ok: fs.existsSync(p), path: p }; };

    // Step 1: Launch Settings
    let s = run.step('launch-settings', {});
    try {
      execSync('xcrun simctl terminate booted com.apple.Preferences 2>/dev/null; sleep 0.5; xcrun simctl launch booted com.apple.Preferences; sleep 2; open -a Simulator', { timeout: 10000 });
      await sleep(1000);
      s.succeed({});
    } catch (e) { s.fail('DRIVER_ERROR', e.message); return; }

    // Step 2: Snapshot (retryable: NOT_READY)
    let snap;
    s = await withRetry(run, 'snapshot', {}, async (st) => {
      snap = await macSnap();
      if (Array.isArray(snap) && snap.length > 0) { st.artifact('snapshot.json', snap); st.succeed({ count: snap.length }); }
      else { snap = null; st.fail('NOT_READY', 'no elements'); }
    }, { resnapshot: () => focusSim() });
    if (!snap) return;

    // Step 3: Screenshot
    s = run.step('screenshot', { label: 'initial' });
    iosSS(path.join(run.artifactsDir, 'step-2-initial.png'));
    s.succeed({});

    // Step 4: Tap 通用 (retryable: NOT_FOUND)
    let genRef;
    s = await withRetry(run, 'tap-general', {}, async (st) => {
      const curSnap = await macSnap();
      genRef = findRef(curSnap || snap, ['通用', 'General']);
      if (!genRef) { st.fail('NOT_FOUND', 'General not found'); return; }
      const tr = await macClick(genRef);
      if (tr.ok) st.succeed(tr); else st.fail('DRIVER_ERROR', tr.error || 'click failed');
    }, { resnapshot: () => focusSim() });
    if (s.raw.status !== 'passed') return;
    await sleep(2000);

    // Step 5: Verify
    s = run.step('verify-general', {});
    const snap2 = await macSnap();
    s.artifact('general-snapshot.json', snap2);
    const ok = Array.isArray(snap2) && snap2.some(e => (e.label || '').includes('关于本机') || (e.label || '').includes('About'));
    if (ok) s.succeed({ navigated: true }); else s.fail('ASSERT_FAIL', 'About not found');

    // Step 6: Screenshot
    s = run.step('screenshot', { label: 'general' });
    iosSS(path.join(run.artifactsDir, 'step-5-general.png'));
    s.succeed({});

    // Step 7: Go back (retryable: NOT_FOUND)
    s = await withRetry(run, 'go-back', {}, async (st) => {
      const snap3 = await macSnap();
      const backRef = findRef(snap3, ['设置', 'Back', '返回']);
      if (backRef) { await macClick(backRef); await sleep(500); st.succeed({}); }
      else st.fail('NOT_FOUND', 'back button not found');
    }, { resnapshot: () => focusSim() });

    // Step 8: Final screenshot
    s = run.step('screenshot', { label: 'final' });
    iosSS(path.join(run.artifactsDir, 'step-7-final.png'));
    s.succeed({});
  },
};

// ── Ref finder ──
function findRef(elements, hints) {
  if (!Array.isArray(elements)) return null;
  for (const hint of hints) {
    const h = hint.toLowerCase();
    const el = elements.find(e =>
      (e.label || '').toLowerCase().includes(h) ||
      (e.name || '').toLowerCase().includes(h) ||
      (e.role || '').toLowerCase().includes(h) ||
      (e.value || '').toLowerCase().includes(h)
    );
    if (el) return el.ref;
  }
  return null;
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);
  const resumeId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;

  let platform, flowName;
  if (resumeId) {
    // Resume: read old record for platform + flow
    const oldPath = path.join(__dirname, 'runs', resumeId, 'record.json');
    if (!fs.existsSync(oldPath)) { console.error(`Run not found: ${resumeId}`); process.exit(1); }
    const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    platform = old.platform;
    flowName = old.name;
    console.error(`▶ Resuming from ${resumeId} (${platform}/${flowName})`);
  } else {
    platform = args.includes('-p') ? args[args.indexOf('-p') + 1]
      : args.includes('--platform') ? args[args.indexOf('--platform') + 1] : 'web';
    flowName = args.includes('--flow') ? args[args.indexOf('--flow') + 1] : 'flowlab-signup';
  }
  const jsonMode = args.includes('--json');

  const flow = flows[flowName];
  if (!flow) { console.error(`Unknown flow: ${flowName}`); process.exit(1); }

  // Ensure web daemon is running for web platform
  if (platform === 'web') {
    ac('web', 'start-daemon');
    sleep(2000);
  }

  const run = new RunRecord(platform, flowName);
  if (resumeId) run.resumedFrom = resumeId;
  console.error(`▶ Starting flow "${flowName}" on ${platform} [${run.runId}]`);

  await flow(run);
  run.finish();

  const recordPath = run.save();

  if (jsonMode) {
    console.log(JSON.stringify(run.toJSON(), null, 2));
  } else {
    console.log(run.printSummary());
    console.log(`Record: ${recordPath}`);
  }

  process.exit(run.status === 'passed' ? 0 : 1);
}

main();
