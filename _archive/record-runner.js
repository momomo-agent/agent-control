#!/usr/bin/env node
/**
 * agent-control Record Runner — 录屏 + 操作 + HTML 报告
 *
 * Usage:
 *   node record-runner.js -p android --name "Settings 搜索" run scenario.json
 *   node record-runner.js -p android --name "手动测试" interactive
 *   node record-runner.js -p macos --pid 1234 --name "BrainDown" run scenario.json
 *   node record-runner.js report                    # 生成最近一次的报告
 *   node record-runner.js report --all              # 生成所有录制的报告
 *
 * 录屏方式:
 *   android  → adb shell screenrecord
 *   ios      → xcrun simctl io booted recordVideo
 *   macos    → screencapture -v (macOS 15+) 或 ffmpeg
 *   web      → ffmpeg 录桌面
 */

const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = path.join(__dirname, 'cli.js');
const REPORT_DIR = '/tmp/agent-control/recordings';
try { fs.mkdirSync(REPORT_DIR, { recursive: true }); } catch {}

// ── Args ──
const raw = process.argv.slice(2);
function flag(names, def) {
  for (const n of names) { const i = raw.indexOf(n); if (i !== -1 && i + 1 < raw.length) return raw[i + 1]; }
  return def;
}
function hasFlag(names) { return names.some(n => raw.includes(n)); }

const platform = flag(['--platform', '-p'], 'android');
const pid = flag(['--pid'], null);
const testName = flag(['--name', '-n'], `test-${Date.now()}`);

// Parse positional args (skip flags and their values)
const flagsWithValue = new Set(['--platform', '-p', '--pid', '--name', '-n']);
const positional = [];
for (let i = 0; i < raw.length; i++) {
  if (flagsWithValue.has(raw[i])) { i++; continue; } // skip flag + value
  if (raw[i].startsWith('-')) continue; // skip boolean flags
  positional.push(raw[i]);
}
const cmd = positional[0] || 'interactive';

// ── Platform Recorders ──

class AndroidRecorder {
  constructor(outDir) {
    this.outDir = outDir;
    this.remoteFile = '/sdcard/ac-recording.mp4';
    this.proc = null;
  }

  start() {
    // Kill any existing screenrecord
    try { execSync('adb shell pkill -f screenrecord', { stdio: 'pipe', timeout: 5000 }); } catch {}
    // Start recording in background (max 180s)
    this.proc = spawn('adb', ['shell', 'screenrecord', '--time-limit', '180', this.remoteFile], {
      stdio: 'ignore', detached: true
    });
    this.proc.unref();
    // Give it a moment to start
    spawnSync('sleep', ['1']);
    return true;
  }

  stop() {
    // Send SIGINT to screenrecord on device
    try { execSync('adb shell pkill -2 screenrecord', { stdio: 'pipe', timeout: 5000 }); } catch {}
    spawnSync('sleep', ['2']);
    // Pull the file
    const localFile = path.join(this.outDir, 'recording.mp4');
    try {
      execSync(`adb pull ${this.remoteFile} "${localFile}"`, { stdio: 'pipe', timeout: 30000 });
      execSync(`adb shell rm ${this.remoteFile}`, { stdio: 'pipe', timeout: 5000 });
      const stat = fs.statSync(localFile);
      if (stat.size > 0) return localFile;
    } catch {}
    return null;
  }
}

class MacOSRecorder {
  constructor(outDir, windowArgs) {
    this.outDir = outDir;
    this.localFile = path.join(outDir, 'recording.mp4');
    this.windowArgs = windowArgs || []; // e.g. ['--pid', '123'] or ['--window', 'Finder']
    this.pid = null;
  }

  start() {
    try { fs.unlinkSync('/tmp/agent-control-screenrecord.pid'); } catch {}
    const startSh = path.join(__dirname, 'macos-driver', 'start-record.sh');
    const args = ['start', this.localFile, ...this.windowArgs].map(a => `"${a}"`).join(' ');
    try {
      const pidStr = execSync(`bash "${startSh}" ${args}`, { encoding: 'utf8', timeout: 25000 }).trim();
      this.pid = parseInt(pidStr, 10);
    } catch (e) {
      return false;
    }
    return !!this.pid;
  }

  captureFrame() {}

  stop() {
    if (this.pid) {
      try { execSync(`kill -INT ${this.pid}`, { stdio: 'pipe', timeout: 3000 }); } catch {}
      spawnSync('sleep', ['3']);
    }
    try {
      const stat = fs.statSync(this.localFile);
      if (stat.size > 0) return this.localFile;
    } catch {}
    return null;
  }
}

class IOSRecorder {
  constructor(outDir) {
    this.outDir = outDir;
    this.localFile = path.join(outDir, 'recording.mp4');
    this.pid = null;
  }

  start() {
    try { fs.unlinkSync(this.localFile); } catch {}
    const proc = spawn('xcrun', ['simctl', 'io', 'booted', 'recordVideo', '--codec=h264', this.localFile], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.pid = proc.pid;
    this._proc = proc;
    // Wait for "Recording started" on stderr
    let started = false;
    proc.stderr.on('data', d => { if (d.toString().includes('Recording')) started = true; });
    for (let i = 0; i < 10 && !started; i++) spawnSync('sleep', ['0.5']);
    return true;
  }

  captureFrame() {}

  stop() {
    if (this._proc) {
      try { process.kill(this._proc.pid, 'SIGINT'); } catch {}
      spawnSync('sleep', ['3']);
    }
    try {
      const stat = fs.statSync(this.localFile);
      if (stat.size > 0) return this.localFile;
    } catch {}
    return null;
  }
}

class WebRecorder {
  constructor(outDir) {
    this.outDir = outDir;
    this.localFile = path.join(outDir, 'recording.mp4');
    this.videoDir = path.join(outDir, '_webvideo');
  }

  start() {
    // Tell web daemon to start Playwright video recording
    try {
      const r = execSync(`curl -s -X POST http://localhost:3901/cmd -H "Content-Type: application/json" -d '{"args":["start-video","${this.videoDir}"]}'`, { encoding: 'utf8', timeout: 10000 });
      const j = JSON.parse(r);
      return j.ok;
    } catch { return false; }
  }

  captureFrame() {}

  stop() {
    try {
      const r = execSync(`curl -s -X POST http://localhost:3901/cmd -H "Content-Type: application/json" -d '{"args":["stop-video"]}'`, { encoding: 'utf8', timeout: 10000 });
      const j = JSON.parse(r);
      const webmPath = j.path || (() => {
        const files = fs.readdirSync(this.videoDir).filter(f => f.endsWith('.webm'));
        return files.length ? path.join(this.videoDir, files[0]) : null;
      })();
      if (webmPath && fs.existsSync(webmPath)) {
        // Convert WebM to MP4
        try {
          execSync(`ffmpeg -i "${webmPath}" -c:v libx264 -preset ultrafast -y "${this.localFile}"`, { timeout: 15000, stdio: 'pipe' });
        } catch {
          fs.copyFileSync(webmPath, this.localFile); // fallback: copy as-is
        }
        return this.localFile;
      }
    } catch {}
    return null;
  }
}

function createRecorder(platform, outDir) {
  switch (platform) {
    case 'android': return new AndroidRecorder(outDir);
    case 'ios': return new IOSRecorder(outDir);
    case 'macos': return new MacOSRecorder(outDir, pid ? ['--pid', pid] : []);
    case 'web': return new WebRecorder(outDir);
    default: return new AndroidRecorder(outDir);
  }
}

// ── AC helper ──
let _recorder = null; // module-level ref for frame capture

function ensureWebDaemon() {
  if (platform !== 'web') return;
  const script = path.join(__dirname, 'web-driver', 'index.js');
  const r = spawnSync('node', [script, 'start-daemon'], { encoding: 'utf8', timeout: 60000 });
  if (r.stdout) console.log('🌐 Web daemon:', safeParse(r.stdout)?.status || r.stdout.trim());
}

function ac(argTokens) {
  const argv = [CLI, '-p', platform, ...argTokens, ...(pid ? ['--pid', pid] : [])];
  const r = spawnSync('node', argv, { encoding: 'utf8', timeout: 120000 });
  return { raw: (r.stdout || '').trim(), code: r.status };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function screenshot(outPath) {
  // Capture a frame for video if recorder supports it
  if (_recorder && typeof _recorder.captureFrame === 'function') _recorder.captureFrame();
  const r = ac(['screenshot', outPath]);
  return r.code === 0;
}

// ── Run Scenario ──
function runScenario(scenarioPath, runDir) {
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const { id, name, steps } = scenario;
  const results = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNum = i + 1;
    const beforeImg = path.join(runDir, `step-${stepNum}-before.png`);
    const afterImg = path.join(runDir, `step-${stepNum}-after.png`);

    // Before screenshot
    screenshot(beforeImg);

    // Execute action
    const startMs = Date.now();
    let res;
    if (step.action) {
      res = ac(step.action.split(/\s+/));
    } else if (step.actions) {
      res = { raw: '', code: 0 };
      for (const a of step.actions) {
        const r = ac(a.split(/\s+/));
        res.raw += r.raw + '\n';
        if (r.code !== 0) res.code = r.code;
        if (step.delay) spawnSync('sleep', [String(step.delay / 1000 || 1)]);
      }
    }
    const durationMs = Date.now() - startMs;

    // Wait for UI to settle
    spawnSync('sleep', [String(step.wait || 1)]);

    // After screenshot
    screenshot(afterImg);

    const ok = res.code === 0 && (!step.expect || safeParse(res.raw)?.ok !== false);
    results.push({
      step: stepNum,
      description: step.description || step.action || 'action',
      action: step.action || step.actions?.join(' ; '),
      ok,
      durationMs,
      beforeImg: path.basename(beforeImg),
      afterImg: path.basename(afterImg),
      output: res.raw?.substring(0, 500),
    });

    console.log(`  ${ok ? '✅' : '❌'} Step ${stepNum}: ${step.description || step.action} (${durationMs}ms)`);
  }

  return results;
}

// ── Interactive Mode ──
function runInteractive(runDir) {
  console.log(`\n🎬 Interactive recording mode — platform: ${platform}`);
  console.log('Commands: snapshot, tap, fill, press, swipe, screenshot, open, shell');
  console.log('Type "done" to stop recording.\n');

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const results = [];
  let stepNum = 0;

  return new Promise(resolve => {
    function prompt() {
      rl.question(`[${platform}] > `, line => {
        line = line.trim();
        if (line === 'done' || line === 'exit' || line === 'q') {
          rl.close();
          resolve(results);
          return;
        }
        if (!line) { prompt(); return; }

        stepNum++;
        const beforeImg = path.join(runDir, `step-${stepNum}-before.png`);
        const afterImg = path.join(runDir, `step-${stepNum}-after.png`);

        screenshot(beforeImg);
        const startMs = Date.now();
        const res = ac(line.split(/\s+/));
        const durationMs = Date.now() - startMs;
        spawnSync('sleep', ['1']);
        screenshot(afterImg);

        const ok = res.code === 0;
        console.log(ok ? `  ✅ ${res.raw.substring(0, 200)}` : `  ❌ ${res.raw.substring(0, 200)}`);

        results.push({
          step: stepNum,
          description: line,
          action: line,
          ok,
          durationMs,
          beforeImg: path.basename(beforeImg),
          afterImg: path.basename(afterImg),
          output: res.raw?.substring(0, 500),
        });

        prompt();
      });
    }
    prompt();
  });
}

// ── HTML Report ──
function generateReport(runDir, meta, steps, videoFile) {
  const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const passed = steps.filter(s => s.ok).length;
  const total = steps.length;
  const allPass = passed === total;

  const videoHtml = videoFile ? `
    <div class="video-section">
      <div class="section-label">📹 Screen Recording</div>
      <video controls autoplay muted loop playsinline>
        <source src="${path.basename(videoFile)}" type="video/mp4">
      </video>
    </div>` : '';

  const stepsHtml = steps.map(s => `
    <div class="step ${s.ok ? 'pass' : 'fail'}">
      <div class="step-header">
        <span class="step-num">${s.step}</span>
        <span class="step-result ${s.ok ? 'ok' : 'fail'}">${s.ok ? '✅' : '❌'}</span>
        <span class="step-desc">${esc(s.description)}</span>
        <span class="step-time">${s.durationMs}ms</span>
      </div>
      <div class="step-body">
        <div class="before-after">
          <div class="ba-col">
            <div class="ba-label">Before</div>
            ${fs.existsSync(path.join(runDir, s.beforeImg)) ? `<img src="${s.beforeImg}" loading="lazy">` : '<div class="no-img">No screenshot</div>'}
          </div>
          <div class="ba-arrow">→</div>
          <div class="ba-col">
            <div class="ba-label">After</div>
            ${fs.existsSync(path.join(runDir, s.afterImg)) ? `<img src="${s.afterImg}" loading="lazy">` : '<div class="no-img">No screenshot</div>'}
          </div>
        </div>
        ${s.output ? `<details class="output"><summary>Output</summary><pre>${esc(s.output)}</pre></details>` : ''}
      </div>
    </div>`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>agent-control — ${esc(meta.name)}</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0b;--bg2:#111113;--bg3:#1a1a1e;--border:#2a2a2e;--text:#e8e8ec;--text2:#8888a0;--accent:#6ee7b7;--red:#ef4444;--mono:'JetBrains Mono',monospace;--serif:'Instrument Serif',Georgia,serif}
body{background:var(--bg);color:var(--text);font-family:var(--mono);font-size:13px;line-height:1.7;padding:40px 24px}
.container{max-width:1200px;margin:0 auto}
h1{font-family:var(--serif);font-size:42px;font-weight:400;margin-bottom:8px}
h1 em{font-style:italic}
h1 em.pass{color:var(--accent)}
h1 em.fail{color:var(--red)}
.meta{color:var(--text2);font-size:12px;margin-bottom:32px;display:flex;gap:16px;flex-wrap:wrap}
.meta-tag{padding:3px 10px;border-radius:4px;border:1px solid var(--border)}
.meta-tag.android{color:#a3e635;border-color:rgba(163,230,53,0.3)}
.meta-tag.ios{color:#fbbf24;border-color:rgba(251,191,36,0.3)}
.meta-tag.macos{color:#f472b6;border-color:rgba(244,114,182,0.3)}
.meta-tag.web{color:#60a5fa;border-color:rgba(96,165,250,0.3)}

.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:32px}
.summary-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center}
.summary-card .num{font-size:28px;font-weight:600}
.summary-card .num.pass{color:var(--accent)}
.summary-card .num.fail{color:var(--red)}
.summary-card .label{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:var(--text2);margin-top:4px}

.video-section{margin-bottom:32px}
.video-section video{width:100%;max-height:600px;border-radius:12px;border:1px solid var(--border);background:#000}
.section-label{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:var(--text2);margin-bottom:12px}

.step{border:1px solid var(--border);border-radius:12px;margin-bottom:16px;overflow:hidden;background:var(--bg2)}
.step.pass{border-left:3px solid var(--accent)}
.step.fail{border-left:3px solid var(--red)}
.step-header{display:flex;align-items:center;gap:12px;padding:14px 20px;background:var(--bg3);cursor:pointer}
.step-num{width:24px;height:24px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0}
.step-result{font-size:16px}
.step-desc{flex:1;font-size:13px}
.step-time{color:var(--text2);font-size:11px}

.step-body{padding:16px 20px}
.before-after{display:grid;grid-template-columns:1fr auto 1fr;gap:0;margin-bottom:12px}
.ba-col img{width:100%;border-radius:8px;border:1px solid var(--border)}
.ba-label{font-size:10px;text-transform:uppercase;letter-spacing:2px;color:var(--text2);margin-bottom:8px}
.ba-arrow{display:flex;align-items:center;justify-content:center;font-size:24px;color:var(--accent);padding:0 12px}
.no-img{background:var(--bg3);border-radius:8px;padding:40px;text-align:center;color:var(--text2);font-size:12px}

.output{margin-top:8px}
.output summary{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:var(--text2);cursor:pointer}
.output pre{background:var(--bg);padding:12px;border-radius:6px;font-size:11px;line-height:1.5;overflow-x:auto;max-height:200px;overflow-y:auto;color:var(--text2);margin-top:8px}

@media(max-width:768px){.before-after{grid-template-columns:1fr}.ba-arrow{transform:rotate(90deg);padding:8px 0}}
</style></head>
<body><div class="container">
  <h1>Test <em class="${allPass ? 'pass' : 'fail'}">${esc(meta.name)}</em></h1>
  <div class="meta">
    <span class="meta-tag ${meta.platform}">${meta.platform}</span>
    <span>${meta.date}</span>
    <span>${passed}/${total} passed</span>
    ${meta.duration ? `<span>${meta.duration}</span>` : ''}
  </div>

  <div class="summary">
    <div class="summary-card"><div class="num">${total}</div><div class="label">Steps</div></div>
    <div class="summary-card"><div class="num pass">${passed}</div><div class="label">Passed</div></div>
    <div class="summary-card"><div class="num ${total - passed > 0 ? 'fail' : ''}">${total - passed}</div><div class="label">Failed</div></div>
  </div>

  ${videoHtml}

  <div class="section-label">📋 Steps</div>
  ${stepsHtml}
</div></body></html>`;

  const reportPath = path.join(runDir, 'report.html');
  fs.writeFileSync(reportPath, html);
  return reportPath;
}

// ── Main ──
async function main() {
  if (cmd === 'report') {
    // Find latest run and open report
    const runs = fs.readdirSync(REPORT_DIR).filter(d => fs.statSync(path.join(REPORT_DIR, d)).isDirectory()).sort().reverse();
    if (runs.length === 0) { console.log('No recordings found.'); return; }
    const latest = path.join(REPORT_DIR, runs[0], 'report.html');
    if (fs.existsSync(latest)) {
      console.log(`Opening: ${latest}`);
      spawnSync('open', [latest]);
    } else {
      console.log(`No report in ${runs[0]}`);
    }
    return;
  }

  // Create run directory
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const runId = `${ts}-${testName.replace(/\s+/g, '-')}`;
  const runDir = path.join(REPORT_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  console.log(`\n🎬 Recording: ${testName}`);
  console.log(`   Platform: ${platform}`);
  console.log(`   Output: ${runDir}\n`);

  // Pre-start web daemon if needed
  ensureWebDaemon();

  // Start recording
  const recorder = createRecorder(platform, runDir);
  _recorder = recorder; // expose for screenshot() frame capture
  const recordOk = recorder.start();
  if (recordOk) console.log('📹 Screen recording started\n');
  else console.log('⚠️  Screen recording failed to start, continuing without video\n');

  const startTime = Date.now();
  let steps;

  try {
    if (cmd === 'interactive') {
      steps = await runInteractive(runDir);
    } else if (cmd === 'run') {
      const scenarioPath = positional[1];
      if (!scenarioPath || !fs.existsSync(scenarioPath)) {
        console.error('Scenario file not found:', scenarioPath);
        process.exit(1);
      }
      steps = runScenario(scenarioPath, runDir);
    } else {
      // Auto mode — run all commands from args after the flags
      const actions = raw.filter(a => !a.startsWith('-') && !['android','ios','macos','web'].includes(a));
      steps = [];
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        const stepNum = i + 1;
        const beforeImg = path.join(runDir, `step-${stepNum}-before.png`);
        const afterImg = path.join(runDir, `step-${stepNum}-after.png`);
        screenshot(beforeImg);
        const s = Date.now();
        const res = ac(action.split(/\s+/));
        spawnSync('sleep', ['1']);
        screenshot(afterImg);
        const ok = res.code === 0;
        steps.push({
          step: stepNum, description: action, action, ok,
          durationMs: Date.now() - s,
          beforeImg: path.basename(beforeImg),
          afterImg: path.basename(afterImg),
          output: res.raw?.substring(0, 500),
        });
        console.log(`  ${ok ? '✅' : '❌'} ${action} (${Date.now() - s}ms)`);
      }
    }
  } finally {
    // Stop recording
    console.log('\n📹 Stopping recording...');
    const videoFile = recorder.stop();
    if (videoFile) console.log(`✅ Video saved: ${videoFile}`);
    else console.log('⚠️  No video captured');

    const duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

    // Generate report
    const meta = {
      name: testName,
      platform,
      date: new Date().toLocaleString(),
      duration,
    };

    // Save metadata
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ ...meta, steps, videoFile: videoFile ? path.basename(videoFile) : null }, null, 2));

    const reportPath = generateReport(runDir, meta, steps || [], videoFile);
    console.log(`\n📊 Report: ${reportPath}`);

    // Open report
    spawnSync('open', [reportPath]);
  }
}

main().catch(console.error);
