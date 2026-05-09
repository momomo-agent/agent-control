#!/usr/bin/env node
/**
 * agent-control — 统一 CLI 入口
 *
 * Usage:
 *   agent-control --platform macos snapshot -i
 *   agent-control --platform web open example.com ; snapshot -i
 *   agent-control --platform ios tap @e1
 *
 * 不指定 platform 时自动检测
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const args = process.argv.slice(2);

// Ensure stdout is fully flushed before exit (pipe mode truncation fix)
const _origExit = process.exit.bind(process);
function flushAndExit(code = 0) {
  if (process.stdout.writableFinished || process.stdout.writableEnded) {
    _origExit(code);
    return;
  }
  process.stdout.write('', () => _origExit(code));
  setTimeout(() => _origExit(code), 500).unref();
}

// ── Parse --platform and --enhanced ──
let platform = null;
let enhanced = false;
let compact = false;
let jsonMode = false;
let allMode = false;
let pidArg = null;
let driverArgs = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--platform' || args[i] === '-p') {
    platform = args[i + 1]; i++;
  } else if (args[i] === '--enhanced' || args[i] === '-e') {
    enhanced = true;
  } else if (args[i] === '--compact' || args[i] === '-c') {
    compact = true; enhanced = true;
  } else if (args[i] === '--json' || args[i] === '--raw') {
    jsonMode = true; enhanced = false;
  } else if (args[i] === '--all') {
    allMode = true; enhanced = true;
  } else if (args[i] === '--pid') {
    pidArg = args[i + 1]; i++;
  } else if (args[i] === '--app') {
    driverArgs.push('--app', args[i + 1]); i++;
  } else {
    driverArgs.push(args[i]);
  }
}
// Append --pid after command for drivers that expect it
if (pidArg) driverArgs.push('--pid', pidArg);

// ── Normalize refs: ensure @ prefix ──
// Drivers expect @e3 format (aligned with agent-browser convention)
driverArgs = driverArgs.map(a => /^e\d+$/.test(a) ? '@' + a : a);

// ── Extract actual command from driverArgs (skip flags like --app, --pid) ──
const flagsWithVal = new Set(['--app', '--pid']);
const flagsNoVal = new Set(['-i']);
function getCommand() {
  for (let i = 0; i < driverArgs.length; i++) {
    if (flagsWithVal.has(driverArgs[i])) { i++; continue; }
    if (flagsNoVal.has(driverArgs[i])) continue;
    return driverArgs[i];
  }
  return null;
}

// ── Per-platform help (avoids spawning drivers / daemons just for --help) ──
const PLATFORM_HELP = {
  web: [
    'agent-control-web — Playwright-powered browser driver',
    '',
    'Daemon: auto-starts at 127.0.0.1:3901 on first command. Kill with `close`.',
    '  --cdp <ws://...>          Connect to an existing Chrome via CDP instead of launching.',
    '',
    'Commands (chain with ; or &&):',
    '  open <url>                Navigate',
    '  snapshot [-i]             Get DOM / interactive tree',
    '  find <text>               Filter snapshot by text match',
    '  click @ref | x y          Click (--right for right-click)',
    '  fill @ref "text"          Clear + type (--submit to press Enter)',
    '  type "text"               Type at focus',
    '  press <key>               Keyboard key (Enter, Escape, ArrowDown, ...)',
    '  select @ref "value"       Select option from dropdown',
    '  scroll dir [amount]       Scroll up/down/left/right',
    '  screenshot [@ref] [path]  PNG (default /tmp/agent-control-web.png, --full for fullpage)',
    '  wait <ms>|@ref|url=<re>   Wait for timeout / element / URL match',
    '  eval "js"                 Run JS in page context',
    '  close                     Close browser + daemon',
  ].join('\n'),
  macos: [
    'agent-control-macos — Accessibility (AX) driver',
    '',
    'Prerequisite: System Settings → Privacy & Security → Accessibility → allow Terminal / iTerm / Node',
    '',
    'Target selection:',
    '  --app <name|bundleId>     Target an app window (recommended, privacy-friendly)',
    '  --pid <pid>               Target a specific app by PID',
    '',
    'Commands:',
    '  snapshot [-i|-e]          Element tree (-i interactive only, -e enhanced summary)',
    '  find <text>               Filter snapshot by label/value',
    '  click @ref | x y          Click (--focus-guard to not steal focus)',
    '  double-click @ref | x y   Double-click (--focus-guard ok)',
    '  right-click @ref | x y    Right-click',
    '  fill @ref "text"          Focus + type (--focus-guard ok)',
    '  type "text"               Type at current focus',
    '  press <key>               Send key (Enter, Tab, Escape, cmd+shift+4, ...)',
    '  drag @from @to            Drag between refs or coordinates',
    '  scroll dir [amount]       Scroll inside focused window',
    '  screenshot [path]         PNG (requires --app, or --full for full-screen)',
    '  hover @ref | x y          Move cursor without clicking',
    '  activate                  Bring target app to front',
    '  console [N]               Tail unified log for target app (--level=<info|debug|error>)',
    '',
    'macOS shortcuts (top-level):',
    '  virtual-cursor start|move|hide|stop|status    Lavender virtual cursor (alias vcursor)',
  ].join('\n'),
  ios: [
    'agent-control-ios — iOS simulator + real-device driver',
    '',
    'Backend auto-selection (override with --sim / --real):',
    '  • If a simulator is booted → use idb (fast)',
    '  • Else if an iPhone/iPad is plugged in + trusted → use pymobiledevice3',
    '',
    'Commands:',
    '  snapshot [-i]             UI element tree',
    '  tap @ref | x y            Tap',
    '  fill @ref "text"          Focus + type',
    '  type "text"               Type at focus',
    '  swipe <dir> [amount]      Swipe up/down/left/right',
    '  press home|lock|siri      Hardware button (sim); volumeUp/Down on real',
    '  screenshot [path]         PNG (element-scoped with @ref)',
    '  longpress @ref | x y      Long press [--duration=N ms]',
    '  drag x1 y1 x2 y2          Drag',
    '  open <url>                Open URL',
    '  launch <bundleId>         Launch app',
    '  terminate <bundleId>      Kill app',
    '  list-apps                 List installed apps',
    '  windows                   List windows/scenes (simulator)',
    '  console [--process=X] N   Stream system log (simulator)',
    '  unlock                    Real-device only',
    '  install <ipa>             Real-device only',
    '',
    'Diagnose: agent-control doctor -p ios',
  ].join('\n'),
  android: [
    'agent-control-android — adb + uiautomator bridge',
    '',
    'Prerequisites:',
    '  • Android platform-tools on PATH (`adb`)',
    '  • Connected device / running emulator (verify: `adb devices`)',
    '  • For USB: enable Developer Options + USB debugging on the device',
    '',
    'Commands:',
    '  snapshot [-i]             UI element tree',
    '  tap @ref | x y            Tap',
    '  longpress @ref | x y      Long press [--duration=ms]',
    '  swipe <dir> [amount]      Swipe up/down/left/right',
    '  fill @ref "text"          Type text into element',
    '  press <key>               home/back/enter/menu/power/volumeUp/volumeDown',
    '  screenshot [@ref] [path]  PNG (element-scoped crops the full capture)',
    '  open <package>            Launch app by package name',
    '  start <pkg/.Activity>     Start specific activity',
    '  stop <package>            Force-stop app',
    '  devices                   List connected devices',
    '  current                   Show current foreground activity',
    '  console [level] [N]       logcat tail (--tag=X, --package=X, --clear)',
    '  shell <cmd>               Raw adb shell',
    '',
    'Environment: ANDROID_SERIAL pins a specific device when multiple are connected.',
  ].join('\n'),
  electron: [
    'agent-control-electron — Electron app CDP driver',
    '',
    'Target must expose Chrome DevTools:',
    '  • Set CDP_PORT via --port <n> or ELECTRON_DEBUG_PORT env (default 9229)',
    '  • The Electron app must be launched with --remote-debugging-port=<n>',
    '  • --target <idx|substr>  Pick a page/webview (index or title/URL substring; default 0)',
    '',
    'Commands:',
    '  windows                   List Page/Webview/iframe targets',
    '  navigate <url>            Load URL in selected target',
    '  reload                    Reload',
    '  snapshot [-i|-e]          DOM element tree (--ui for renderer ui)',
    '  click @ref | x y          Click',
    '  double-click @ref | x y',
    '  right-click @ref | x y',
    '  fill @ref "text"          Clear + type',
    '  press <key>               Keyboard key (Enter, cmd+shift+p, ...)',
    '  scroll dir                Scroll',
    '  eval "js"                 Run JS in page context',
    '  screenshot [path]         PNG (for webviews, falls through to macOS AX driver)',
    '',
    'Example: agent-control -p electron --port 9223 --target RemoteClaw snapshot',
  ].join('\n'),
  flutter: [
    'agent-control-flutter — Dart VM Service driver',
    '',
    'Prereq: launch the Flutter app with --observatory-port / --vm-service-port.',
    'Set FLUTTER_VM_SERVICE_URL=ws://127.0.0.1:<port>/ws before running, or',
    'pass --vm-service ws://... as the first arg.',
    '',
    'Commands:',
    '  snapshot [-i]             Widget/semantics tree',
    '  click @ref | x y          Tap',
    '  fill @ref "text"          Enter text',
    '  scroll dir [amount]       Scroll',
    '  swipe dir                 Swipe gesture',
    '  press <key>               Key event (enter/tab/escape/back/...)',
    '  longpress @ref | x y      [--duration=ms]',
    '  drag @from @to | x1 y1 x2 y2',
    '  find <text>               Find widgets by text',
    '  back                      Pop navigation',
    '  screenshot [path]         PNG',
  ].join('\n'),
};

// ── Auto-pick platform (sticky) ──
// Remember the last platform + (optionally) target via ~/.cache/agent-control/context.json.
// When -p is given, update sticky; otherwise, use sticky as the default.
// First-time fallback uses a sensible heuristic.
const STICKY_PATH = path.join(os.homedir(), '.cache', 'agent-control', 'context.json');

function readSticky() {
  try {
    return JSON.parse(require('fs').readFileSync(STICKY_PATH, 'utf8')) || {};
  } catch { return {}; }
}
function writeSticky(obj) {
  try {
    const dir = path.dirname(STICKY_PATH);
    require('fs').mkdirSync(dir, { recursive: true });
    require('fs').writeFileSync(STICKY_PATH, JSON.stringify(obj, null, 2));
  } catch {}
}

function heuristicPlatform() {
  // iOS sim booted?
  const simR = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'],
    { encoding: 'utf8', timeout: 4000, stdio: ['pipe','pipe','pipe'] });
  if (simR.status === 0 && simR.stdout) {
    try {
      const data = JSON.parse(simR.stdout);
      for (const [, devs] of Object.entries(data.devices)) {
        for (const d of devs) if (d.state === 'Booted') return 'ios';
      }
    } catch {}
  }
  // Web daemon running?
  const fs_ = require('fs');
  try {
    const s = JSON.parse(fs_.readFileSync('/tmp/agent-control-web.json', 'utf8'));
    process.kill(s.pid, 0);
    return 'web';
  } catch {}
  // Android device connected?
  const adbR = spawnSync('adb', ['devices'], { encoding: 'utf8', timeout: 3000, stdio: ['pipe','pipe','pipe'] });
  if (adbR.status === 0 && adbR.stdout) {
    const lines = adbR.stdout.split('\n').slice(1).filter(l => /\bdevice\b/.test(l));
    if (lines.length > 0) return 'android';
  }
  // Fallback: macOS
  return 'macos';
}

function pickAutoPlatform() {
  const sticky = readSticky();
  if (sticky.platform) return sticky.platform;
  return heuristicPlatform();
}

// Normalize equivalent commands across platforms (so `agent-control snap` works everywhere).
const COMMAND_ALIASES = {
  snap: { default: 'snapshot' },
  tap: { default: 'click', ios: 'tap', android: 'tap' },
  click: { default: 'click', ios: 'tap', android: 'tap' },
};

// ── Subcommand shortcuts ──
const cmd0 = getCommand();

// Commands that should NOT auto-pick platform (they own their own routing / are global)
const CLI_SUBCOMMANDS = new Set([
  'doctor', 'check', 'shot', 'auto', 'run-all', 'goal', 'viewer',
  'help', '--help', '-h',
  'virtual-cursor', 'vcursor',
  'platform', 'context',              // sticky-context management (below)
  'use', 'switch',                     // shorthand for `platform set`
  'where', 'who', 'pwd',               // shorthand for `platform show`
  'unuse',                             // shorthand for `platform clear`
]);

const VALID_PLATFORMS = new Set(['web', 'macos', 'ios', 'android', 'electron', 'flutter']);

// Shorthand verbs that just manage sticky context without running a driver.
//   agent-control use <plat> [--app X] [--port N]
//   agent-control switch <plat> ...
//   agent-control where | who | pwd
//   agent-control unuse
if (cmd0 === 'use' || cmd0 === 'switch') {
  const plat = driverArgs[1];
  if (!plat || !VALID_PLATFORMS.has(plat)) {
    console.error('usage: agent-control use <web|macos|ios|android|electron|flutter> [--app <name>] [--port <n>]');
    process.exit(1);
  }
  const next = { platform: plat };
  const appIdx = driverArgs.indexOf('--app');
  if (appIdx !== -1) next.app = driverArgs[appIdx + 1];
  const portIdx = driverArgs.indexOf('--port');
  if (portIdx !== -1) next.port = driverArgs[portIdx + 1];
  writeSticky(next);
  const extras = [];
  if (next.app) extras.push(`--app ${next.app}`);
  if (next.port) extras.push(`--port ${next.port}`);
  console.log(`✓ using ${plat}${extras.length ? ' ' + extras.join(' ') : ''}`);
  process.exit(0);
}
if (cmd0 === 'where' || cmd0 === 'who' || cmd0 === 'pwd') {
  const sticky = readSticky();
  if (!sticky.platform) {
    console.log('(no sticky context) — set with `agent-control use <platform>`');
  } else {
    const extras = [];
    if (sticky.app) extras.push(`--app ${sticky.app}`);
    if (sticky.port) extras.push(`--port ${sticky.port}`);
    console.log(`${sticky.platform}${extras.length ? ' ' + extras.join(' ') : ''}`);
  }
  process.exit(0);
}
if (cmd0 === 'unuse') {
  const fs_ = require('fs');
  try { fs_.unlinkSync(STICKY_PATH); } catch {}
  console.log('✓ sticky cleared');
  process.exit(0);
}

// Manage sticky context: `agent-control platform` / `agent-control context set <plat> [--app X]`
if (cmd0 === 'platform' || cmd0 === 'context') {
  const fs_ = require('fs');
  const sub = driverArgs[1];
  const sticky = readSticky();
  if (!sub || sub === 'show' || sub === 'get') {
    console.log(JSON.stringify(sticky, null, 2));
    process.exit(0);
  }
  if (sub === 'clear' || sub === 'reset') {
    try { fs_.unlinkSync(STICKY_PATH); } catch {}
    console.log(JSON.stringify({ ok: true, cleared: true }, null, 2));
    process.exit(0);
  }
  if (sub === 'set') {
    const plat = driverArgs[2];
    if (!plat) { console.error('usage: agent-control platform set <web|macos|ios|android|electron|flutter> [--app <name>] [--port <n>]'); process.exit(1); }
    const next = { platform: plat };
    const appIdx = driverArgs.indexOf('--app');
    if (appIdx !== -1) next.app = driverArgs[appIdx + 1];
    const portIdx = driverArgs.indexOf('--port');
    if (portIdx !== -1) next.port = driverArgs[portIdx + 1];
    writeSticky(next);
    console.log(JSON.stringify({ ok: true, ...next }, null, 2));
    process.exit(0);
  }
  console.error('usage: agent-control platform [show|set <plat>|clear]');
  process.exit(1);
}

// If user passed -p explicitly, persist to sticky (so next run remembers).
if (platform) {
  const fs_ = require('fs');
  const sticky = readSticky();
  const appIdx = driverArgs.indexOf('--app');
  const portIdx = driverArgs.indexOf('--port');
  const next = { platform };
  if (appIdx !== -1) next.app = driverArgs[appIdx + 1];
  else if (sticky.platform === platform && sticky.app) next.app = sticky.app;
  if (portIdx !== -1) next.port = driverArgs[portIdx + 1];
  else if (sticky.platform === platform && sticky.port) next.port = sticky.port;
  writeSticky(next);
}

// Auto-pick platform for unknown/non-subcommand first-tokens when -p missing.
// Excludes the CLI subcommands above (they handle themselves).
if (!platform && cmd0 && !CLI_SUBCOMMANDS.has(cmd0)) {
  platform = pickAutoPlatform();
  // If sticky has --app and user didn't pass one, inject it for macos.
  const sticky = readSticky();
  if (platform === 'macos' && sticky.app && !driverArgs.includes('--app')) {
    // Insert '--app <name>' just after the first token so the macOS driver parses it.
    driverArgs.push('--app', sticky.app);
  }
  if (platform === 'electron' && sticky.port && !driverArgs.includes('--port')) {
    driverArgs.push('--port', sticky.port);
  }
}

// Apply command aliases so cross-platform verbs work uniformly.
if (cmd0 && COMMAND_ALIASES[cmd0]) {
  const spec = COMMAND_ALIASES[cmd0];
  const resolved = spec[platform] || spec.default;
  if (resolved && resolved !== cmd0) {
    const idx = driverArgs.indexOf(cmd0);
    if (idx !== -1) driverArgs[idx] = resolved;
  }
}

if (cmd0 === 'doctor' || cmd0 === 'check') {
  const subArgs = driverArgs.slice(1);
  if (platform) subArgs.push('-p', platform);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'doctor.js'), ...subArgs], { stdio: 'inherit' });
  process.exit(r.status || 0);
}

// ── `agent-control shot` — open-the-box screenshot ──
// Auto-picks the best available backend and uses a sane default output path.
//   Force order: --real > --sim > --macos > --web > --android > --electron > auto
//   Auto: iOS simulator > iOS real device > macOS > err
//   Default output: ./shot-YYYYMMDD-HHMMSS.png
if (cmd0 === 'shot') {
  const shotArgs = driverArgs.slice(1);

  if (shotArgs.includes('--help') || shotArgs.includes('-h') || shotArgs[0] === 'help') {
    console.log([
      'agent-control shot — quick screenshot, auto-picks backend.',
      '',
      'Usage:',
      '  agent-control shot [path.png] [options]',
      '',
      'Backend (auto by default: iOS sim > iOS real > macOS > err):',
      '  --sim                Force iOS simulator (must be booted)',
      '  --real               Force iOS real device (must be plugged in + trusted)',
      '  --macos              macOS screen (default --full if no --app)',
      '  --app <name>         macOS: screenshot a single app window (implies --macos)',
      '  --full               macOS: full screen (implies --macos)',
      '  --web [@ref]         Active browser page (optional element ref)',
      '  --android            Connected Android device / emulator',
      '  --electron           Current Electron target (needs --port)',
      '  --port <n>           Electron debug port (default 9229)',
      '',
      'Options:',
      '  --open               Open the PNG after saving',
      '  -h, --help           Show this help',
      '',
      'Output path:',
      '  If no path is given, saves to ./shot-YYYYMMDD-HHMMSS.png in the current dir.',
      '',
      'Examples:',
      '  agent-control shot                                # auto',
      '  agent-control shot /tmp/x.png --open              # auto + open',
      '  agent-control shot --real /tmp/real.png',
      '  agent-control shot --macos --app Finder',
      '  agent-control shot --web                          # active browser page',
      '  agent-control shot --android /tmp/android.png',
      '  agent-control shot --electron --port 9223',
    ].join('\n'));
    process.exit(0);
  }

  const forceReal = shotArgs.includes('--real');
  const forceSim = shotArgs.includes('--sim');
  const fullFlag = shotArgs.includes('--full');
  const appIdx = shotArgs.indexOf('--app');
  const appName = appIdx !== -1 ? shotArgs[appIdx + 1] : null;
  const forceMacos = shotArgs.includes('--macos') || platform === 'macos' || fullFlag || !!appName;
  const forceWeb = shotArgs.includes('--web');
  const forceAndroid = shotArgs.includes('--android');
  const forceElectron = shotArgs.includes('--electron');
  const portIdx = shotArgs.indexOf('--port');
  const electronPort = portIdx !== -1 ? shotArgs[portIdx + 1] : null;
  const openFlag = shotArgs.includes('--open');
  const refArg = shotArgs.find(a => /^@?e\d+$/.test(a));
  // Anything that's not a known flag or its value and not a ref is the output path
  const KNOWN_FLAGS = new Set(['--real','--sim','--macos','--full','--web','--android','--electron','--open','--help','-h']);
  const KNOWN_FLAGS_WITH_VAL = new Set(['--app','--port']);
  const explicitPath = shotArgs.find((a, i) => {
    if (KNOWN_FLAGS.has(a)) return false;
    if (KNOWN_FLAGS_WITH_VAL.has(a)) return false;
    if (i > 0 && KNOWN_FLAGS_WITH_VAL.has(shotArgs[i - 1])) return false; // flag value
    if (a.startsWith('-')) return false;
    if (/^@?e\d+$/.test(a)) return false;
    return true;
  });

  function ts() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  const outPath = explicitPath || path.resolve(process.cwd(), `shot-${ts()}.png`);

  function detectIosBackend() {
    if (forceSim) return 'sim';
    if (forceReal) return 'real';
    const simR = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'],
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe','pipe','pipe'] });
    if (simR.status === 0 && simR.stdout) {
      try {
        const data = JSON.parse(simR.stdout);
        for (const [, devs] of Object.entries(data.devices)) {
          for (const d of devs) if (d.state === 'Booted') return 'sim';
        }
      } catch {}
    }
    const py = spawnSync('python3', [path.join(ROOT, 'ios-driver', 'real-device.py'), 'detect'],
      { encoding: 'utf8', timeout: 6000, stdio: ['pipe','pipe','pipe'] });
    if (py.stdout) {
      try {
        const d = JSON.parse(py.stdout);
        if (d.ok && d.devices && d.devices.length > 0) return 'real';
      } catch {}
    }
    return null;
  }

  let backendChoice = null;
  if (forceMacos) backendChoice = 'macos';
  else if (forceWeb) backendChoice = 'web';
  else if (forceAndroid) backendChoice = 'android';
  else if (forceElectron) backendChoice = 'electron';
  else {
    // Auto: iOS first (sim > real), then macOS as fallback
    backendChoice = detectIosBackend();
    if (!backendChoice) {
      console.log(JSON.stringify({
        ok: false,
        error: 'no device available for automatic capture',
        hint: 'Options: (a) boot a simulator (`open -a Simulator`); (b) plug in an iPhone + trust this Mac; (c) `shot --macos` for Mac screen; (d) `shot --web` if a browser daemon is running. Diagnose: `agent-control doctor`.',
      }, null, 2));
      process.exit(1);
    }
  }

  let result;
  const fs_ = require('fs');
  if (backendChoice === 'macos') {
    const rel = path.join(ROOT, 'macos-driver', '.build', 'release', 'agent-control');
    const dbg = path.join(ROOT, 'macos-driver', '.build', 'debug', 'agent-control');
    const bin = fs_.existsSync(rel) ? rel : dbg;
    if (!fs_.existsSync(bin)) {
      console.log(JSON.stringify({ ok: false, error: 'macOS driver not built', hint: 'cd macos-driver && swift build -c release' }, null, 2));
      process.exit(1);
    }
    const macArgs = ['screenshot'];
    if (appName) macArgs.push('--app', appName);
    else if (!fullFlag) macArgs.push('--full');
    if (fullFlag) macArgs.push('--full');
    macArgs.push(outPath);
    const r = spawnSync(bin, macArgs, { encoding: 'utf8', timeout: 20000, stdio: ['pipe','pipe','pipe'] });
    if (r.status === 0 && fs_.existsSync(outPath)) {
      result = { ok: true, backend: 'macos', path: outPath };
    } else {
      result = { ok: false, backend: 'macos', error: (r.stderr || r.stdout || 'screenshot failed').trim() };
    }
  } else if (backendChoice === 'web') {
    // Delegate to cli.js -p web screenshot <path>
    const webArgs = ['screenshot'];
    if (refArg) webArgs.push(refArg.startsWith('@') ? refArg : '@' + refArg);
    webArgs.push(outPath);
    const r = spawnSync('node', [path.join(ROOT, 'cli.js'), '-p', 'web', ...webArgs],
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe','pipe','pipe'] });
    try { result = JSON.parse(r.stdout || '{}'); }
    catch { result = { ok: false, error: (r.stderr || r.stdout || 'screenshot failed').trim() }; }
    result.backend = 'web';
    if (result.ok && !result.path) result.path = outPath;
    if (!result.ok && !result.hint) {
      result.hint = 'Start the browser first: `agent-control -p web open https://example.com`.';
    }
  } else if (backendChoice === 'android') {
    const r = spawnSync('node', [path.join(ROOT, 'android-driver', 'index.js'), 'screenshot', outPath],
      { encoding: 'utf8', timeout: 25000, stdio: ['pipe','pipe','pipe'] });
    try { result = JSON.parse(r.stdout || '{}'); }
    catch { result = { ok: false, error: (r.stderr || r.stdout || 'screenshot failed').trim() }; }
    result.backend = 'android';
    if (result.ok && !result.path) result.path = outPath;
  } else if (backendChoice === 'electron') {
    const electronArgs = [];
    if (electronPort) electronArgs.push('--port', electronPort);
    electronArgs.push('screenshot', outPath);
    const r = spawnSync('node', [path.join(ROOT, 'electron-driver', 'index.js'), ...electronArgs],
      { encoding: 'utf8', timeout: 25000, stdio: ['pipe','pipe','pipe'] });
    try { result = JSON.parse(r.stdout || '{}'); }
    catch { result = { ok: false, error: (r.stderr || r.stdout || 'screenshot failed').trim() }; }
    result.backend = 'electron';
    if (result.ok && !result.path) result.path = outPath;
    if (!result.ok && !result.hint) {
      result.hint = 'Launch your Electron app with --remote-debugging-port=<port>, then `shot --electron --port <port>`.';
    }
  } else {
    // iOS backend (sim or real)
    const script = path.join(ROOT, 'ios-driver', 'index.js');
    const flag = backendChoice === 'real' ? '--real' : '--sim';
    const r = spawnSync('node', [script, flag, 'screenshot', outPath],
      { encoding: 'utf8', timeout: 25000, stdio: ['pipe','pipe','pipe'] });
    try { result = JSON.parse(r.stdout || '{}'); }
    catch { result = { ok: false, error: (r.stderr || r.stdout || 'screenshot failed').trim() }; }
    if (!result.backend) result.backend = backendChoice === 'real' ? 'ios-real' : 'ios-sim';
    if (result.ok && !result.path) result.path = outPath;
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.ok && openFlag && process.platform === 'darwin') {
    spawnSync('open', [result.path], { stdio: 'ignore' });
  }
  process.exit(result.ok ? 0 : 1);
}
if (cmd0 === 'demo') {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'demo.js'), ...driverArgs.slice(1)], { stdio: 'inherit' });
  process.exit(r.status || 0);
}
if (cmd0 === 'find' && platform !== 'web') {
  // CLI-level find: snapshot + filter for non-web platforms
  const query = driverArgs.slice(1).join(' ').toLowerCase();
  if (!query) { console.error('usage: agent-control -p <platform> find <text>'); process.exit(1); }
  // Replace driverArgs to run snapshot -i, then filter
  driverArgs = ['snapshot', '-i'];
  enhanced = true;
  // Store query for post-processing
  global.__findQuery = query;
}

// Track whether user explicitly passed -p <plat>
const userSpecifiedPlatform = platform !== null;

// ── Per-platform help (print directly, don't spawn drivers/daemons) ──
if ((cmd0 === 'help' || cmd0 === '--help' || cmd0 === '-h') && userSpecifiedPlatform && PLATFORM_HELP[platform]) {
  console.log(PLATFORM_HELP[platform]);
  console.log('\nFor the global overview: `agent-control help`');
  process.exit(0);
}

// ── virtual-cursor alias: maps to macos `cursor <sub>` ──
// Top-level shortcut so `agent-control virtual-cursor start` works without -p macos.
if (cmd0 === 'virtual-cursor' || cmd0 === 'vcursor') {
  platform = 'macos';
  const cmdIdx = driverArgs.indexOf(cmd0);
  if (cmdIdx >= 0) driverArgs[cmdIdx] = 'cursor';
}

// ── Route to driver ──
const { enhance } = require('./snapshot-enhance');

function runDriver(cmd, args, timeout = 15000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  return r;
}

function maybeEnhance(r) {
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();

  // Check for empty/error results and provide helpful messages
  if (r.status !== 0 && !out) {
    const hints = {
      macos: 'Check: is the app running? Is --pid correct? Grant Accessibility permission in System Settings > Privacy.',
      ios: 'Check: is Simulator running with a booted device? Run: xcrun simctl list devices booted',
      web: 'Check: is the URL correct? Run: agent-control -p web open <url> first.',
    };
    console.error(JSON.stringify({ ok: false, error: err || 'command failed', hint: hints[platform] || '' }, null, 2));
    flushAndExit(1);
    return;
  }

  if (!enhanced && !jsonMode && driverArgs.includes('snapshot')) {
    // snapshot defaults to enhanced text output; use --raw/--json for JSON
    enhanced = true;
  }

  if (!enhanced || !driverArgs.includes('snapshot')) {
    if (out) process.stdout.write(out + '\n');
    if (err) process.stderr.write(err + '\n');
    flushAndExit(r.status || 0);
    return;
  }
  try {
    const els = JSON.parse(out);
    const arr = Array.isArray(els) ? els : Object.values(els);
    if (arr.length === 0) {
      console.log(JSON.stringify({ ok: false, error: 'no elements found', hint: platform === 'macos' ? 'Is --pid correct? Is the app in foreground?' : platform === 'ios' ? 'Is Simulator running? Try: open -a Simulator' : 'Did you open a URL first?' }, null, 2));
      flushAndExit(1);
    }
    const result = enhance(arr, { platform, all: allMode });
    if (global.__findQuery) {
      const q = global.__findQuery;
      const matches = result.elements.filter(el => {
        const t = [el.label, el.value, el.name, el.text, el.role, el.tag].filter(Boolean).join(' ').toLowerCase();
        return t.includes(q);
      });
      console.log(JSON.stringify({ ok: true, action: 'find', query: q, count: matches.length, elements: matches }));
    } else if (compact) {
      console.log(result.summary);
      console.log(result.text);
    } else if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.summary);
      console.log(result.text);
    }
  } catch(e) { console.error('enhance error:', e.message); process.stdout.write(out + '\n'); }
  flushAndExit(r.status || 0);
}

const drivers = {
  macos: () => {
    const fs_ = require('fs');
    // Prefer release build when available (optimized), fall back to debug.
    const rel = path.join(ROOT, 'macos-driver', '.build', 'release', 'agent-control');
    const dbg = path.join(ROOT, 'macos-driver', '.build', 'debug', 'agent-control');
    const bin = fs_.existsSync(rel) ? rel : dbg;
    if (!fs_.existsSync(bin)) {
      console.error('macOS driver not built. Run: cd macos-driver && swift build -c release');
      process.exit(1);
    }
    const timeout = (driverArgs[0] === 'console' || driverArgs[0] === 'logs') ? 30000 : 15000;
    maybeEnhance(runDriver(bin, driverArgs, timeout));
  },
  web: () => {
    const fs = require('fs');
    const STATE = '/tmp/agent-control-web.json';
    // Extract --cdp from driverArgs
    let cdpUrl = null;
    const cdpIdx = driverArgs.indexOf('--cdp');
    if (cdpIdx !== -1) {
      cdpUrl = driverArgs[cdpIdx + 1];
      driverArgs.splice(cdpIdx, 2);
    }
    function daemonAlive() {
      try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); process.kill(s.pid, 0); return true; } catch { return false; }
    }
    // If --cdp, kill existing daemon (it's connected to a different target)
    if (cdpUrl && daemonAlive()) {
      try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); process.kill(s.pid); } catch {}
      spawnSync('sleep', ['0.5']);
    }
    if (!daemonAlive()) {
      // Start daemon in background
      const { spawn } = require('child_process');
      const script = path.join(ROOT, 'web-driver', 'index.js');
      const startArgs = cdpUrl
        ? ['--cdp', cdpUrl, 'open', 'about:blank']
        : ['--headed', 'open', 'about:blank'];
      const child = spawn('node', [script, ...startArgs], {
        detached: true, stdio: 'ignore',
      });
      child.unref();
      // Wait for daemon to be ready
      for (let i = 0; i < 20; i++) {
        spawnSync('sleep', ['0.3']);
        if (daemonAlive()) break;
      }
      if (!daemonAlive()) { console.error('Failed to start web daemon'); process.exit(1); }
    }
    // Send command via HTTP
    const http = require('http');
    const data = JSON.stringify({ args: driverArgs });
    const req = http.request({
      hostname: '127.0.0.1', port: 3901, path: '/cmd', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (enhanced && driverArgs.includes('snapshot')) {
          try {
            const els = JSON.parse(body);
            const arr = Array.isArray(els) ? els : Object.values(els);
            const r = enhance(arr, { platform, all: allMode });
            if (compact) {
              console.log(r.summary);
              console.log(r.text);
            } else if (jsonMode) {
              console.log(JSON.stringify(r, null, 2));
            } else {
              console.log(r.summary);
              console.log(r.text);
            }
          } catch { process.stdout.write(body); }
        } else {
          process.stdout.write(body + '\n');
        }
        process.exit(0);
      });
    });
    req.on('error', e => { console.error('Web daemon error:', e.message); process.exit(1); });
    req.write(data);
    req.end();
  },
  ios: () => {
    const script = path.join(ROOT, 'ios-driver', 'index.js');
    // iOS snapshot via WDA can take ~30s on first run; give it room.
    const t = /snapshot|launch|install|uninstall/.test(driverArgs[0] || '') ? 60000 : 25000;
    maybeEnhance(runDriver('node', [script, ...driverArgs], t));
  },
  android: () => {
    const script = path.join(ROOT, 'android-driver', 'index.js');
    maybeEnhance(runDriver('node', [script, ...driverArgs], 60000));
  },
  electron: () => {
    const script = path.join(ROOT, 'electron-driver', 'index.js');
    maybeEnhance(runDriver('node', [script, ...driverArgs], 30000));
  },
  flutter: () => {
    const script = path.join(ROOT, 'flutter-driver', 'index.js');
    maybeEnhance(runDriver('node', [script, ...driverArgs], 30000));
  },
};

if (driverArgs.length === 0 || ((cmd0 === 'help' || cmd0 === '--help') && !userSpecifiedPlatform)) {
  console.log(`agent-control — Give AI hands.

Usage:
  agent-control -p <platform> [options] <command> [args...]
  agent-control <subcommand> [args...]
  agent-control <shortcut>  [args...]            # auto-picks platform

Platforms:
  web       Playwright (auto-starts daemon)
  macos     Accessibility API (--pid or --app to target)
  ios       Simulator (idb) + Real Device (pymobiledevice3)
  android   adb + uiautomator (brew install --cask android-platform-tools)
  electron  Electron via CDP (requires --remote-debugging-port)
  flutter   Flutter via Dart VM Service Protocol

Shortcuts (no -p needed — uses sticky context, falls back to heuristic):
  shot [path.png] [flags]        Quick screenshot
  snap [-i]                      Quick snapshot
  click @ref | x y               Click/tap
  fill @ref "text"               Fill
  press <key>                    Key
  screenshot [path]              Screenshot
  open <url>                     Navigate (web)
  <any driver command>           Routes to sticky platform

Switch / show target device (no side-effects):
  agent-control use <plat> [--app X] [--port N]   Pin platform (+ optional target)
  agent-control switch <plat> ...                 Alias of 'use'
  agent-control where                             Print sticky context
  agent-control unuse                             Clear sticky
  # Also: every time you pass -p <plat>, sticky auto-updates.

Driver commands (use with -p <plat>):
  snapshot [-i] [-e]             See UI elements
  click @ref | x y               Click/tap  (macOS: --focus-guard)
  drag @r1 @r2                   Drag between refs or coordinates
  fill @ref "text"               Clear + type  (macOS: --focus-guard)
  select @ref "value"            Select dropdown (web)
  press <key>                    Keyboard key
  screenshot [path]              Save PNG
  open <url>                     Navigate (web)
  swipe <dir>                    Swipe (iOS/Android)
  close                          Close browser daemon (web)
  console [level] [N]            System/app logs

macOS shortcuts (top-level):
  virtual-cursor start|move|hide|stop|status    Lavender virtual cursor (alias vcursor)

Subcommands:
  doctor  [-p <plat>]                            Environment check (all platforms)
  shot    [path.png] [--real|--sim|--macos|--web|--android|--electron]
  auto    -p <plat> --goal "..." [--url <url>]   LLM-driven goal loop
  run-all [--json]                               Run all flows
  goal    -p <plat> observe|act|act-observe ...  Step-by-step goal runner
  viewer                                         Open HTML report viewer

Per-platform help:
  agent-control -p <platform> help               # detailed help for one platform

Options:
  -e, --enhanced    Filter interactive elements + semantic summary
  --pid <pid>       Target specific app by PID (macOS)
  --app <name>      Target app by name or bundleId (macOS)
  --real            Force real device backend (iOS)
  --sim             Force simulator backend (iOS)

Examples:
  agent-control doctor                                   # full self-check
  agent-control doctor -p ios                            # iOS only
  agent-control shot                                     # auto screenshot
  agent-control shot --web --open                        # browser page + open
  agent-control shot --macos --app Finder
  agent-control snap                                     # auto snapshot
  agent-control -p web open https://example.com
  agent-control -p macos --app Finder snapshot -i
  agent-control -p ios --real list-apps
  agent-control -p android help
  agent-control auto -p web --goal "Sign up" --url https://example.com`);
  process.exit(0);
}

// Top-level subcommands → delegate (must come after help so `help` isn't misrouted)
const subcommands = {
  auto: 'auto.js',
  doctor: 'doctor.js',
  'run-all': 'run-all.js',
  goal: 'goal-runner.js',
  viewer: 'viewer.js',
};
if (cmd0 && subcommands[cmd0]) {
  const { spawnSync: ss } = require('child_process');
  const r = ss('node', [path.join(ROOT, subcommands[cmd0]), ...args.slice(args.indexOf(cmd0) + 1)], { stdio: 'inherit', encoding: 'utf8' });
  process.exit(r.status || 0);
}

if (!drivers[platform]) {
  console.error(JSON.stringify({ ok: false, error: `unknown platform '${platform}'. Use: macos, web, ios, android, electron, flutter` }));
  process.exit(1);
}

drivers[platform]();
