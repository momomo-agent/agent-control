#!/usr/bin/env node
/**
 * agent-control Goal Runner — observe/act + HTML 可视化报告
 *
 * Usage:
 *   node goal-runner.js -p macos observe                    # 截图 + 树
 *   node goal-runner.js -p macos observe --ss               # 只截图
 *   node goal-runner.js -p macos act click @e3              # 执行动作
 *   node goal-runner.js -p macos act-observe dblclick @e5   # 执行 + 观察
 *   node goal-runner.js -p macos report                     # 生成 HTML 报告
 *   node goal-runner.js -p macos reset                      # 清空历史
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CLI = path.join(__dirname, 'cli.js');
const REPORT_DIR = '/tmp/agent-control';
const HISTORY_FILE = path.join(REPORT_DIR, 'history.json');
try { fs.mkdirSync(REPORT_DIR, { recursive: true }); } catch {}

// ── Parse args ──
const args = process.argv.slice(2);
function flag(names, def) {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return def;
}
function hasFlag(names) { return names.some(n => args.includes(n)); }

const platform = flag(['--platform', '-p'], 'macos');
const pid = flag(['--pid'], null);
const screenshotOnly = hasFlag(['--screenshot-only', '--ss']);
const treeOnly = hasFlag(['--tree-only', '--tree']);

// ── History ──
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function saveHistory(h) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2)); }
function addStep(step) { const h = loadHistory(); h.push(step); saveHistory(h); }

// ── AC wrapper ──
function ac(tokens) {
  const argv = [CLI, '-p', platform, ...tokens, ...(pid ? ['--pid', pid] : [])];
  const r = spawnSync('node', argv, { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}

// ── Screenshot ──
function takeScreenshot() {
  const ts = Date.now();
  const ssPath = path.join(REPORT_DIR, `step-${ts}.png`);
  const result = ac(['screenshot', ssPath]);
  try {
    const parsed = JSON.parse(result);
    if (parsed.ok) return ssPath;
  } catch {}
  return null;
}

// ── Snapshot tree ──
function getTree() {
  const raw = ac(['snapshot', '-i']);
  try {
    const elements = JSON.parse(raw);
    return {
      count: elements.length,
      elements,
      summary: elements.map(e => {
        const v = e.value || e.label || '';
        return `${e.ref} ${e.role}${v ? ` "${v}"` : ''}`;
      }).join('\n'),
    };
  } catch { return { count: 0, elements: [], summary: '' }; }
}

// ── Observe ──
function observe(mode) {
  const result = { ok: true, action: 'observe', timestamp: new Date().toISOString() };
  if (mode !== 'tree') result.screenshot = takeScreenshot();
  if (mode !== 'screenshot') {
    const tree = getTree();
    result.elementCount = tree.count;
    result.elements = tree.summary;
  }
  return result;
}

// ── Find command ──
const skipNext = new Set(['-p', '--platform', '--pid']);
let cmdIdx = -1;
for (let i = 0; i < args.length; i++) {
  if (skipNext.has(args[i])) { i++; continue; }
  if (args[i].startsWith('-')) continue;
  cmdIdx = i; break;
}
const command = cmdIdx >= 0 ? args[cmdIdx] : 'observe';
const actionTokens = [];
if (cmdIdx >= 0) {
  for (let i = cmdIdx + 1; i < args.length; i++) {
    if (skipNext.has(args[i])) { i++; continue; }
    if (args[i].startsWith('--')) continue;
    actionTokens.push(args[i]);
  }
}

// ── Commands ──
switch (command) {
  case 'observe': case 'look': case 'see': {
    const mode = screenshotOnly ? 'screenshot' : treeOnly ? 'tree' : 'both';
    const state = observe(mode);
    // Record step
    addStep({ type: 'observe', ...state });
    console.log(JSON.stringify(state, null, 2));
    break;
  }

  case 'act': case 'do': {
    const actionStr = actionTokens.join(' ');
    const result = ac(actionTokens);
    let parsed; try { parsed = JSON.parse(result); } catch { parsed = result; }
    addStep({ type: 'act', action: actionStr, result: parsed, timestamp: new Date().toISOString() });
    console.log(result);
    break;
  }

  case 'act-observe': case 'do-look': {
    const actionStr = actionTokens.join(' ');
    // Screenshot BEFORE action
    const beforeSS = takeScreenshot();
    const beforeTree = getTree();

    // Execute
    const actResult = ac(actionTokens);
    let parsed; try { parsed = JSON.parse(actResult); } catch { parsed = actResult; }

    spawnSync('sleep', ['0.5']);

    // Screenshot AFTER action
    const afterSS = takeScreenshot();
    const afterTree = getTree();

    // Record step with before/after
    addStep({
      type: 'act-observe',
      action: actionStr,
      result: parsed,
      before: { screenshot: beforeSS, elementCount: beforeTree.count, elements: beforeTree.summary },
      after: { screenshot: afterSS, elementCount: afterTree.count, elements: afterTree.summary },
      timestamp: new Date().toISOString(),
    });

    console.log(JSON.stringify({
      ok: true,
      actionResult: parsed,
      before: { screenshot: beforeSS, elementCount: beforeTree.count },
      after: { screenshot: afterSS, elementCount: afterTree.count },
    }, null, 2));
    break;
  }

  case 'report': {
    generateReport();
    break;
  }

  case 'reset': {
    saveHistory([]);
    console.log('History cleared.');
    break;
  }

  default: {
    const result = ac([command, ...actionTokens]);
    console.log(result);
  }
}

// ── HTML Report Generator ──
function generateReport() {
  const history = loadHistory();
  if (history.length === 0) { console.log('No steps recorded. Use observe/act-observe first.'); return; }

  const stepsHtml = history.map((step, i) => {
    const num = i + 1;

    if (step.type === 'observe') {
      return `
      <div class="step">
        <div class="step-header">
          <span class="step-num">${num}</span>
          <span class="step-type observe">OBSERVE</span>
          <span class="step-time">${step.timestamp || ''}</span>
        </div>
        ${step.screenshot ? `<div class="screenshot"><img src="${step.screenshot}" alt="Step ${num}"></div>` : ''}
        ${step.elements ? `
        <div class="tree">
          <div class="tree-header">Elements (${step.elementCount})</div>
          <pre>${escHtml(step.elements)}</pre>
        </div>` : ''}
      </div>`;
    }

    if (step.type === 'act') {
      return `
      <div class="step">
        <div class="step-header">
          <span class="step-num">${num}</span>
          <span class="step-type act">ACT</span>
          <span class="step-action">${escHtml(step.action)}</span>
        </div>
        <div class="result ${step.result?.ok ? 'ok' : 'fail'}">
          ${step.result?.ok ? '✅' : '❌'} ${JSON.stringify(step.result)}
        </div>
      </div>`;
    }

    if (step.type === 'act-observe') {
      return `
      <div class="step">
        <div class="step-header">
          <span class="step-num">${num}</span>
          <span class="step-type act-observe">ACT + OBSERVE</span>
          <span class="step-action">${escHtml(step.action)}</span>
          <span class="step-result ${step.result?.ok ? 'ok' : 'fail'}">${step.result?.ok ? '✅' : '❌'}</span>
        </div>
        <div class="before-after">
          <div class="ba-col">
            <div class="ba-label">Before</div>
            ${step.before?.screenshot ? `<img src="${step.before.screenshot}" alt="Before">` : '<div class="no-img">No screenshot</div>'}
            <div class="ba-count">${step.before?.elementCount || 0} elements</div>
            ${step.before?.elements ? `<pre class="ba-tree">${escHtml(step.before.elements)}</pre>` : ''}
          </div>
          <div class="ba-arrow">→</div>
          <div class="ba-col">
            <div class="ba-label">After</div>
            ${step.after?.screenshot ? `<img src="${step.after.screenshot}" alt="After">` : '<div class="no-img">No screenshot</div>'}
            <div class="ba-count">${step.after?.elementCount || 0} elements</div>
            ${step.after?.elements ? `<pre class="ba-tree">${escHtml(step.after.elements)}</pre>` : ''}
          </div>
        </div>
      </div>`;
    }

    return '';
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>agent-control — Run Report</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0a0a0b; --bg2: #111113; --bg3: #1a1a1e;
  --border: #2a2a2e; --text: #e8e8ec; --text2: #8888a0;
  --accent: #6ee7b7; --accent2: #34d399;
  --macos: #f472b6; --web: #60a5fa; --ios: #fbbf24;
  --mono: 'JetBrains Mono', monospace;
  --serif: 'Instrument Serif', Georgia, serif;
}
body { background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 13px; line-height: 1.7; padding: 40px 24px; }
.container { max-width: 1200px; margin: 0 auto; }
h1 { font-family: var(--serif); font-size: 36px; font-weight: 400; margin-bottom: 8px; }
h1 em { color: var(--accent); font-style: italic; }
.meta { color: var(--text2); font-size: 12px; margin-bottom: 48px; }

.step {
  border: 1px solid var(--border); border-radius: 12px;
  margin-bottom: 24px; overflow: hidden;
  background: var(--bg2);
}
.step-header {
  display: flex; align-items: center; gap: 12px;
  padding: 16px 20px; background: var(--bg3);
  border-bottom: 1px solid var(--border);
}
.step-num {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--border); display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; flex-shrink: 0;
}
.step-type {
  font-size: 11px; text-transform: uppercase; letter-spacing: 2px;
  padding: 3px 10px; border-radius: 4px; font-weight: 500;
}
.step-type.observe { background: rgba(96,165,250,0.15); color: var(--web); }
.step-type.act { background: rgba(244,114,182,0.15); color: var(--macos); }
.step-type.act-observe { background: rgba(110,231,183,0.15); color: var(--accent); }
.step-action { color: var(--text); font-weight: 500; }
.step-result.ok { color: var(--accent2); }
.step-result.fail { color: #ef4444; }
.step-time { margin-left: auto; color: var(--text2); font-size: 11px; }

.screenshot { padding: 20px; }
.screenshot img { width: 100%; border-radius: 8px; border: 1px solid var(--border); }

.tree { padding: 0 20px 20px; }
.tree-header { font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: var(--text2); margin-bottom: 8px; }
.tree pre {
  background: var(--bg); padding: 16px; border-radius: 8px;
  font-size: 12px; line-height: 1.6; overflow-x: auto;
  max-height: 300px; overflow-y: auto; color: var(--text2);
}

.result { padding: 16px 20px; font-size: 13px; }
.result.ok { color: var(--accent2); }
.result.fail { color: #ef4444; }

.before-after {
  display: grid; grid-template-columns: 1fr auto 1fr;
  gap: 0; padding: 20px;
}
.ba-col { }
.ba-col img { width: 100%; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 8px; }
.ba-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: 2px;
  color: var(--text2); margin-bottom: 12px;
}
.ba-count { font-size: 12px; color: var(--text2); margin-bottom: 8px; }
.ba-tree {
  background: var(--bg); padding: 12px; border-radius: 6px;
  font-size: 11px; line-height: 1.5; max-height: 200px;
  overflow-y: auto; color: var(--text2);
}
.ba-arrow {
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; color: var(--accent); padding: 0 16px;
}
.no-img { padding: 40px; text-align: center; color: #333; }

@media (max-width: 768px) {
  .before-after { grid-template-columns: 1fr; }
  .ba-arrow { transform: rotate(90deg); padding: 8px 0; }
}
</style>
</head>
<body>
<div class="container">
  <h1>Run <em>Report</em></h1>
  <div class="meta">${history.length} steps · platform: ${platform} · generated ${new Date().toISOString()}</div>
  ${stepsHtml}
</div>
</body>
</html>`;

  const reportPath = path.join(REPORT_DIR, 'report.html');
  fs.writeFileSync(reportPath, html);
  console.log(`Report: ${reportPath}`);
  // Auto-open
  spawnSync('open', [reportPath]);
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
