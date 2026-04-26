#!/usr/bin/env node
/**
 * xctest-driver.js — XCUITest-based simulator driver for agent-control
 * 
 * Replaces idb for tap/type/fill operations on iOS 26+ simulators.
 * Uses Apple's XCUITest framework which properly handles HID events.
 * 
 * Usage:
 *   node xctest-driver.js tap <x> <y> [--bundleId <id>]
 *   node xctest-driver.js tap <ref> [--bundleId <id>]
 *   node xctest-driver.js type <text> [--ref <ref>] [--x <x> --y <y>] [--bundleId <id>]
 *   node xctest-driver.js fill <ref> <text> [--bundleId <id>]
 *   node xctest-driver.js snapshot [--interactive] [--bundleId <id>]
 *   node xctest-driver.js swipe <direction> [--bundleId <id>]
 */
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CMD_FILE = '/tmp/agent-control-cmd.json';
const RESULT_FILE = '/tmp/agent-control-result.json';
const PROJECT_DIR = path.join(__dirname, 'xctest-runner');

// Find the built xctestrun file
function findXCTestRun() {
  const dd = path.join(
    process.env.HOME,
    'Library/Developer/Xcode/DerivedData'
  );
  try {
    const dirs = fs.readdirSync(dd).filter(d => d.startsWith('SimDriver-'));
    for (const d of dirs) {
      const buildDir = path.join(dd, d, 'Build/Products');
      if (!fs.existsSync(buildDir)) continue;
      const files = fs.readdirSync(buildDir).filter(f => f.endsWith('.xctestrun'));
      if (files.length > 0) return path.join(buildDir, files[0]);
    }
  } catch {}
  return null;
}

function getBootedUDID() {
  try {
    const out = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
    const data = JSON.parse(out);
    for (const [, devices] of Object.entries(data.devices))
      for (const d of devices) if (d.state === 'Booted') return d.udid;
  } catch {}
  return null;
}

function runTest(cmd) {
  // Write command
  fs.writeFileSync(CMD_FILE, JSON.stringify(cmd));
  
  // Clean old result
  try { fs.unlinkSync(RESULT_FILE); } catch {}
  
  const udid = getBootedUDID();
  if (!udid) return { ok: false, error: 'no booted simulator' };
  
  const xctestrun = findXCTestRun();
  if (!xctestrun) return { ok: false, error: 'xctestrun not found — run build first' };
  
  // Run the test
  const r = spawnSync('xcodebuild', [
    'test-without-building',
    '-xctestrun', xctestrun,
    '-destination', `platform=iOS Simulator,id=${udid}`,
    '-only-testing', 'SimDriverUITests/SimDriverUITests/testRunCommand',
  ], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  
  // Read result
  try {
    const data = fs.readFileSync(RESULT_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    // Parse xcodebuild output for errors
    const stderr = (r.stderr || '') + (r.stdout || '');
    if (stderr.includes('TEST EXECUTE SUCCEEDED') || stderr.includes('Test Suite.*passed')) {
      return { ok: true, note: 'test passed but no result file' };
    }
    return { ok: false, error: 'test failed', detail: stderr.slice(-500) };
  }
}

// Parse args
const args = process.argv.slice(2);
const action = args[0];

if (!action || action === 'help' || action === '--help') {
  console.log(`xctest-driver — XCUITest-based iOS simulator driver

Commands:
  tap <x> <y>              Tap coordinates
  tap <ref>                Tap element by label/id
  type <text>              Type text (into focused element)
  type <text> --ref <ref>  Tap element then type
  type <text> --x <x> --y <y>  Tap coords then type
  fill <ref> <text>        Clear + type into element
  snapshot [--interactive] Get UI element tree
  swipe <direction>        Swipe up/down/left/right
  build                    Build the test runner`);
  process.exit(0);
}

// Extract flags
function getFlag(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}
const bundleId = getFlag('--bundleId') || getFlag('--bundle');

if (action === 'build') {
  console.log('Building XCUITest runner...');
  const udid = getBootedUDID();
  const dest = udid
    ? `platform=iOS Simulator,id=${udid}`
    : 'generic/platform=iOS Simulator';
  const r = spawnSync('xcodebuild', [
    'build-for-testing',
    '-project', path.join(PROJECT_DIR, 'SimDriver.xcodeproj'),
    '-scheme', 'SimDriverUITests',
    '-destination', dest,
  ], { encoding: 'utf8', timeout: 120000, stdio: 'inherit' });
  process.exit(r.status || 0);
}

let cmd = { action, bundleId };

switch (action) {
  case 'tap': {
    const a1 = args[1], a2 = args[2];
    if (a1 && a2 && !isNaN(a1) && !isNaN(a2)) {
      cmd.x = parseFloat(a1);
      cmd.y = parseFloat(a2);
    } else if (a1) {
      cmd.ref = a1;
    }
    break;
  }
  case 'type': case 'text': {
    cmd.action = 'type';
    cmd.text = args[1] || '';
    const ref = getFlag('--ref');
    const x = getFlag('--x'), y = getFlag('--y');
    if (ref) cmd.ref = ref;
    else if (x && y) { cmd.x = parseFloat(x); cmd.y = parseFloat(y); }
    break;
  }
  case 'fill': {
    cmd.ref = args[1];
    cmd.text = args.slice(2).filter(a => !a.startsWith('--')).join(' ');
    break;
  }
  case 'snapshot': {
    cmd.interactive = args.includes('--interactive') || args.includes('-i');
    break;
  }
  case 'swipe': {
    cmd.direction = args[1] || 'up';
    break;
  }
  default:
    console.log(JSON.stringify({ ok: false, error: `unknown action: ${action}` }));
    process.exit(1);
}

const result = runTest(cmd);
console.log(JSON.stringify(result, null, 2));
