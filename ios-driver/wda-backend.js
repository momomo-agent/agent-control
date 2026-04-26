#!/usr/bin/env node
/**
 * wda-backend.js — WebDriverAgent backend for iOS simulator automation
 * 
 * Solves the iOS 26+ problem where idb ui tap/text silently fails.
 * WDA runs inside the simulator via XCUITest and properly handles
 * touch events and keyboard input.
 * 
 * Key discovery: waitForQuiescence must be false, otherwise WDA
 * waits 10s for app idle which never arrives in some apps.
 * 
 * Lifecycle:
 *   - WDA is built once and cached in /tmp/WDA-build/
 *   - WDA process is started on-demand and kept running
 *   - Session is created per-app (bundleId)
 *   - PID tracked in /tmp/wda-agent-control.pid
 */
const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const WDA_PORT = 8100;
const WDA_REPO = 'https://github.com/appium/WebDriverAgent.git';
const WDA_DIR = '/tmp/WebDriverAgent';
const WDA_BUILD = '/tmp/WDA-build';
const WDA_PID_FILE = '/tmp/wda-agent-control.pid';
const WDA_SESSION_FILE = '/tmp/wda-agent-control-session.json';
const WDA_LOG = '/tmp/wda-agent-control.log';

// ── HTTP helpers ──

function wdaRequest(method, path, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: WDA_PORT,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function wdaRequestSync(method, urlPath, body, timeoutMs = 15000) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const curlArgs = ['-s', '-X', method, `http://127.0.0.1:${WDA_PORT}${urlPath}`,
    '-H', 'Content-Type: application/json',
    '--max-time', String(Math.ceil(timeoutMs / 1000))];
  if (bodyStr) curlArgs.push('-d', bodyStr);
  const r = spawnSync('curl', curlArgs, { encoding: 'utf8', timeout: timeoutMs + 2000 });
  if (r.stdout) {
    try { return JSON.parse(r.stdout); }
    catch { return { raw: r.stdout }; }
  }
  return null;
}

// ── WDA lifecycle ──

function isWdaRunning() {
  try {
    const r = spawnSync('curl', ['-s', '--max-time', '3',
      `http://127.0.0.1:${WDA_PORT}/status`], { encoding: 'utf8', timeout: 5000 });
    if (r.stdout && r.stdout.includes('"ready"')) return true;
  } catch {}
  return false;
}

function ensureWdaCloned() {
  if (fs.existsSync(path.join(WDA_DIR, 'WebDriverAgent.xcodeproj'))) return true;
  const r = spawnSync('git', ['clone', '--depth', '1', WDA_REPO, WDA_DIR],
    { encoding: 'utf8', timeout: 60000 });
  return r.status === 0;
}

function buildWda(udid) {
  if (fs.existsSync(path.join(WDA_BUILD, 'Build/Products/Debug-iphonesimulator/WebDriverAgentRunner-Runner.app'))) {
    return true; // Already built
  }
  const r = spawnSync('xcodebuild', [
    'build-for-testing',
    '-project', path.join(WDA_DIR, 'WebDriverAgent.xcodeproj'),
    '-scheme', 'WebDriverAgentRunner',
    '-destination', `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath', WDA_BUILD,
    'CODE_SIGNING_ALLOWED=NO',
  ], { encoding: 'utf8', timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'] });
  return r.status === 0;
}

function startWda(udid) {
  if (isWdaRunning()) return true;

  if (!ensureWdaCloned()) return false;
  if (!buildWda(udid)) return false;

  // Start WDA in background
  const logFd = fs.openSync(WDA_LOG, 'w');
  const child = spawn('xcodebuild', [
    'test-without-building',
    '-project', path.join(WDA_DIR, 'WebDriverAgent.xcodeproj'),
    '-scheme', 'WebDriverAgentRunner',
    '-destination', `platform=iOS Simulator,id=${udid}`,
    '-derivedDataPath', WDA_BUILD,
  ], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  fs.writeFileSync(WDA_PID_FILE, String(child.pid));

  // Wait for WDA to be ready
  for (let i = 0; i < 30; i++) {
    spawnSync('sleep', ['1']);
    if (isWdaRunning()) return true;
  }
  return false;
}

function stopWda() {
  try {
    const pid = fs.readFileSync(WDA_PID_FILE, 'utf8').trim();
    process.kill(parseInt(pid), 'SIGTERM');
  } catch {}
  spawnSync('pkill', ['-f', 'WebDriverAgentRunner'], { timeout: 5000 });
  try { fs.unlinkSync(WDA_PID_FILE); } catch {}
  try { fs.unlinkSync(WDA_SESSION_FILE); } catch {}
}

// ── Session management ──

function getSession() {
  try {
    const data = JSON.parse(fs.readFileSync(WDA_SESSION_FILE, 'utf8'));
    // Verify session is still valid
    const r = wdaRequestSync('GET', `/session/${data.sessionId}/source`, null, 5000);
    if (r && !r.value?.error) return data;
  } catch {}
  return null;
}

function createSession(bundleId) {
  // Create session WITHOUT bundleId to avoid WDA runner stealing foreground
  const caps = { capabilities: { alwaysMatch: {} } };
  const r = wdaRequestSync('POST', '/session', caps, 15000);
  if (!r?.value?.sessionId) return null;
  const session = { sessionId: r.value.sessionId, bundleId };

  // Disable waitForQuiescence — critical for iOS 26+
  wdaRequestSync('POST', `/session/${session.sessionId}/appium/settings`,
    { settings: { waitForQuiescence: false } }, 5000);

  // Set defaultActiveApplication if bundleId provided
  if (bundleId) {
    wdaRequestSync('POST', `/session/${session.sessionId}/appium/settings`,
      { settings: { defaultActiveApplication: bundleId } }, 5000);
    // Activate the app
    wdaRequestSync('POST', `/session/${session.sessionId}/wda/apps/activate`,
      { bundleId }, 10000);
  }

  fs.writeFileSync(WDA_SESSION_FILE, JSON.stringify(session));
  return session;
}

function ensureSession(bundleId) {
  let session = getSession();
  if (session && (!bundleId || session.bundleId === bundleId)) return session;
  // Create new session
  session = createSession(bundleId);
  return session;
}

// ── Commands ──

function findElement(sessionId, using, value) {
  const r = wdaRequestSync('POST', `/session/${sessionId}/element`,
    { using, value }, 10000);
  return r?.value?.ELEMENT || null;
}

function findElements(sessionId, using, value) {
  const r = wdaRequestSync('POST', `/session/${sessionId}/elements`,
    { using, value }, 10000);
  if (!r?.value || !Array.isArray(r.value)) return [];
  return r.value.map(e => e.ELEMENT || e['element-6066-11e4-a52e-4f735466cecf']);
}

function clickElement(sessionId, elementId) {
  const r = wdaRequestSync('POST', `/session/${sessionId}/element/${elementId}/click`,
    {}, 15000);
  return r?.value === null; // null means success in WDA
}

function typeIntoElement(sessionId, elementId, text) {
  const chars = text.split('');
  const r = wdaRequestSync('POST', `/session/${sessionId}/element/${elementId}/value`,
    { value: chars }, 15000);
  return r?.value === null;
}

function clearElement(sessionId, elementId) {
  const r = wdaRequestSync('POST', `/session/${sessionId}/element/${elementId}/clear`,
    {}, 15000);
  return r?.value === null;
}

function getSource(sessionId) {
  const r = wdaRequestSync('GET', `/session/${sessionId}/source`, null, 15000);
  return r?.value || '';
}

function getElementAttribute(sessionId, elementId, attr) {
  const r = wdaRequestSync('GET',
    `/session/${sessionId}/element/${elementId}/attribute/${attr}`, null, 5000);
  return r?.value;
}

function activateApp(sessionId, bundleId) {
  const r = wdaRequestSync('POST', `/session/${sessionId}/wda/apps/activate`,
    { bundleId }, 10000);
  return r?.value === null;
}

function sendKeys(sessionId, text) {
  const r = wdaRequestSync('POST', `/session/${sessionId}/wda/keys`,
    { value: text.split('') }, 10000);
  return r?.value === null;
}

// ── Parse XML source into element list ──

function parseSource(xml) {
  const elements = [];
  // Match all XCUIElement types
  const regex = /<(XCUIElementType\w+)\s+([^>]+)>/g;
  let match;
  let idx = 0;
  while ((match = regex.exec(xml)) !== null) {
    const type = match[1].replace('XCUIElementType', '');
    const attrs = match[2];
    const get = (name) => {
      const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
      return m ? m[1] : '';
    };
    const x = parseInt(get('x')) || 0;
    const y = parseInt(get('y')) || 0;
    const w = parseInt(get('width')) || 0;
    const h = parseInt(get('height')) || 0;
    if (w < 3 && h < 3) continue;
    const visible = get('visible');
    if (visible === 'false') continue;

    idx++;
    const INTERACTIVE = new Set([
      'Button', 'TextField', 'TextView', 'Switch', 'Slider',
      'Link', 'Tab', 'SegmentedControl', 'SearchField',
      'PopUpButton', 'ComboBox', 'CheckBox', 'SecureTextField',
    ]);
    elements.push({
      ref: `@e${idx}`,
      role: type,
      label: get('label'),
      value: get('value') || null,
      placeholder: get('placeholderValue') || null,
      enabled: get('enabled') !== 'false',
      frame: { x, y, w, h },
      interactive: INTERACTIVE.has(type),
    });
  }
  return elements;
}

// ── Exported API ──

module.exports = {
  isWdaRunning,
  startWda,
  stopWda,
  ensureSession,
  findElement,
  findElements,
  clickElement,
  typeIntoElement,
  clearElement,
  getSource,
  getElementAttribute,
  activateApp,
  sendKeys,
  parseSource,
  WDA_PORT,
};

// ── CLI mode ──

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === 'help') {
    console.log(`wda-backend — WebDriverAgent backend for agent-control

Commands:
  status              Check if WDA is running
  start [udid]        Start WDA for simulator
  stop                Stop WDA
  session [bundleId]  Create/get session
  source [bundleId]   Get page source
  tap <x> <y> [bundleId]  Tap coordinates
  type <text> [bundleId]  Type text into focused element
  click-type <class> <text> [bundleId]  Click element by class then type`);
    process.exit(0);
  }

  function getUdid() {
    const explicit = args.find(a => /^[A-F0-9-]{36}$/i.test(a));
    if (explicit) return explicit;
    try {
      const out = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
      const data = JSON.parse(out);
      for (const [, devices] of Object.entries(data.devices))
        for (const d of devices) if (d.state === 'Booted') return d.udid;
    } catch {}
    return null;
  }

  const udid = getUdid();
  let result;

  switch (cmd) {
    case 'status':
      result = { ok: true, running: isWdaRunning() };
      break;
    case 'start':
      if (!udid) { result = { ok: false, error: 'no booted simulator' }; break; }
      result = { ok: startWda(udid), action: 'start' };
      break;
    case 'stop':
      stopWda();
      result = { ok: true, action: 'stop' };
      break;
    case 'session': {
      if (!udid) { result = { ok: false, error: 'no booted simulator' }; break; }
      if (!isWdaRunning()) startWda(udid);
      const s = ensureSession(args[1]);
      result = s ? { ok: true, sessionId: s.sessionId } : { ok: false, error: 'session creation failed' };
      break;
    }
    case 'source': {
      if (!udid) { result = { ok: false, error: 'no booted simulator' }; break; }
      if (!isWdaRunning()) startWda(udid);
      const s = ensureSession(args[1]);
      if (!s) { result = { ok: false, error: 'no session' }; break; }
      const src = getSource(s.sessionId);
      const els = parseSource(src);
      result = { ok: true, elements: els, count: els.length };
      break;
    }
    case 'tap': {
      if (!udid) { result = { ok: false, error: 'no booted simulator' }; break; }
      if (!isWdaRunning()) startWda(udid);
      const bundleId = args[3];
      const s = ensureSession(bundleId);
      if (!s) { result = { ok: false, error: 'no session' }; break; }
      // Use W3C actions for coordinate tap
      const x = parseFloat(args[1]), y = parseFloat(args[2]);
      const tapResult = wdaRequestSync('POST', `/session/${s.sessionId}/actions`, {
        actions: [{
          type: 'pointer', id: 'finger1',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 50 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      }, 10000);
      result = { ok: tapResult?.value === null, action: 'tap', x, y };
      break;
    }
    case 'type': {
      if (!udid) { result = { ok: false, error: 'no booted simulator' }; break; }
      if (!isWdaRunning()) startWda(udid);
      const s = ensureSession(args[2]);
      if (!s) { result = { ok: false, error: 'no session' }; break; }
      result = { ok: sendKeys(s.sessionId, args[1]), action: 'type' };
      break;
    }
    case 'click-type': {
      if (!udid) { result = { ok: false, error: 'no booted simulator' }; break; }
      if (!isWdaRunning()) startWda(udid);
      const cls = args[1]; // e.g. XCUIElementTypeTextField
      const text = args[2];
      const bundleId = args[3];
      const s = ensureSession(bundleId);
      if (!s) { result = { ok: false, error: 'no session' }; break; }
      const elemId = findElement(s.sessionId, 'class name', cls);
      if (!elemId) { result = { ok: false, error: `no element of class ${cls}` }; break; }
      const clicked = clickElement(s.sessionId, elemId);
      if (!clicked) { result = { ok: false, error: 'click failed' }; break; }
      // Re-find after click (element may have changed)
      const elemId2 = findElement(s.sessionId, 'class name', cls);
      const typed = elemId2 ? typeIntoElement(s.sessionId, elemId2, text) : false;
      result = { ok: typed, action: 'click-type', class: cls, text };
      break;
    }
    default:
      result = { ok: false, error: `unknown command: ${cmd}` };
  }

  console.log(JSON.stringify(result, null, 2));
}
