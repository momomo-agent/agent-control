#!/usr/bin/env node
/**
 * agent-control Goal Runner — 语义化 observe/act + HTML 报告
 *
 * Usage:
 *   node goal-runner.js -p macos --goal "打开 README" observe --note "看到文件树"
 *   node goal-runner.js -p macos act-observe dblclick @e21 --note "双击打开 README"
 *   node goal-runner.js report
 *   node goal-runner.js reset
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CLI = path.join(__dirname, 'cli.js');
const REPORT_DIR = '/tmp/agent-control';
const HISTORY_FILE = path.join(REPORT_DIR, 'history.json');
try { fs.mkdirSync(REPORT_DIR, { recursive: true }); } catch {}

// ── Parse ──
const raw = process.argv.slice(2);
function flag(names, def) {
  for (const n of names) { const i = raw.indexOf(n); if (i !== -1 && i + 1 < raw.length) return raw[i + 1]; }
  return def;
}
function flagMulti(name) {
  const i = raw.indexOf(name);
  if (i === -1) return null;
  const parts = [];
  for (let j = i + 1; j < raw.length; j++) {
    if (raw[j].startsWith('--') || raw[j].startsWith('-p')) break;
    parts.push(raw[j]);
  }
  return parts.join(' ');
}
function hasFlag(names) { return names.some(n => raw.includes(n)); }

const platform = flag(['--platform', '-p'], 'macos');
const pid = flag(['--pid'], null);
const goalText = flagMulti('--goal') || flagMulti('-g');
const noteText = flagMulti('--note') || flagMulti('-n');
const screenshotOnly = hasFlag(['--ss']);
const treeOnly = hasFlag(['--tree']);

// ── History ──
function loadHistory() { try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; } }
function saveHistory(h) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2)); }
function addStep(step) { const h = loadHistory(); h.push(step); saveHistory(h); }

// ── AC ──
function ac(tokens) {
  const argv = [CLI, '-p', platform, ...tokens, ...(pid ? ['--pid', pid] : [])];
  const r = spawnSync('node', argv, { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}

function takeScreenshot() {
  const p = path.join(REPORT_DIR, `step-${Date.now()}.png`);
  const r = ac(['screenshot', p]);
  try { if (JSON.parse(r).ok) return p; } catch {} return null;
}

function getTree() {
  const r = ac(['snapshot', '-i']);
  try {
    const els = JSON.parse(r);
    return {
      count: els.length,
      elements: els,
      summary: els.map(e => `${e.ref} ${e.role}${(e.value || e.label) ? ` "${e.value || e.label}"` : ''}`).join('\n'),
    };
  } catch { return { count: 0, elements: [], summary: '' }; }
}

function semanticSummary(elements) {
  if (!elements || elements.length === 0) return 'No interactive elements found.';
  const roles = {};
  elements.forEach(e => { roles[e.role] = (roles[e.role] || 0) + 1; });
  const roleSummary = Object.entries(roles).map(([r, c]) => `${c} ${r}`).join(', ');
  const named = elements.filter(e => e.value || e.label).slice(0, 8);
  const namedStr = named.map(e => `"${e.value || e.label}"`).join(', ');
  return `${elements.length} elements (${roleSummary}). Key items: ${namedStr}${elements.length > 8 ? '...' : ''}`;
}

function diffSummary(before, after) {
  if (!before || !after) return '';
  const bLabels = new Set(before.elements.map(e => e.value || e.label).filter(Boolean));
  const aLabels = new Set(after.elements.map(e => e.value || e.label).filter(Boolean));
  const added = [...aLabels].filter(l => !bLabels.has(l));
  const removed = [...bLabels].filter(l => !aLabels.has(l));
  const parts = [];
  if (added.length) parts.push(`New: ${added.slice(0, 5).map(l => `"${l}"`).join(', ')}`);
  if (removed.length) parts.push(`Gone: ${removed.slice(0, 5).map(l => `"${l}"`).join(', ')}`);
  if (!parts.length) return 'UI unchanged.';
  return parts.join(' | ');
}

// ── Find command ──
const skip = new Set(['-p', '--platform', '--pid', '--goal', '-g', '--note', '-n']);
let cmdIdx = -1;
for (let i = 0; i < raw.length; i++) {
  if (skip.has(raw[i])) { i++; continue; }
  if (raw[i].startsWith('--')) continue;
  cmdIdx = i; break;
}
const command = cmdIdx >= 0 ? raw[cmdIdx] : 'observe';
const actionTokens = [];
if (cmdIdx >= 0) {
  for (let i = cmdIdx + 1; i < raw.length; i++) {
    if (skip.has(raw[i])) { while (i + 1 < raw.length && !raw[i + 1].startsWith('-')) i++; i++; continue; }
    if (raw[i].startsWith('--')) continue;
    actionTokens.push(raw[i]);
  }
}

// ── Commands ──
switch (command) {
  case 'observe': case 'look': {
    const mode = screenshotOnly ? 'screenshot' : treeOnly ? 'tree' : 'both';
    const result = { type: 'observe', platform, timestamp: new Date().toISOString() };
    if (goalText) result.goal = goalText;
    if (noteText) result.note = noteText;
    if (mode !== 'tree') result.screenshot = takeScreenshot();
    if (mode !== 'screenshot') {
      const tree = getTree();
      result.elementCount = tree.count;
      result.elements = tree.summary;
      result.semantic = semanticSummary(tree.elements);
    }
    addStep(result);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    break;
  }

  case 'act': {
    const actionStr = actionTokens.join(' ');
    const r = ac(actionTokens);
    let parsed; try { parsed = JSON.parse(r); } catch { parsed = r; }
    const step = { type: 'act', platform, action: actionStr, result: parsed, timestamp: new Date().toISOString() };
    if (noteText) step.note = noteText;
    addStep(step);
    console.log(r);
    break;
  }

  case 'act-observe': {
    const actionStr = actionTokens.join(' ');
    const beforeSS = takeScreenshot();
    const beforeTree = getTree();
    const r = ac(actionTokens);
    let parsed; try { parsed = JSON.parse(r); } catch { parsed = r; }
    spawnSync('sleep', ['0.5']);
    const afterSS = takeScreenshot();
    const afterTree = getTree();

    const step = {
      type: 'act-observe', platform, action: actionStr, result: parsed,
      before: { screenshot: beforeSS, elementCount: beforeTree.count, elements: beforeTree.summary, semantic: semanticSummary(beforeTree.elements) },
      after: { screenshot: afterSS, elementCount: afterTree.count, elements: afterTree.summary, semantic: semanticSummary(afterTree.elements) },
      diff: diffSummary(beforeTree, afterTree),
      timestamp: new Date().toISOString(),
    };
    if (goalText) step.goal = goalText;
    if (noteText) step.note = noteText;
    addStep(step);
    console.log(JSON.stringify({ ok: true, action: actionStr, result: parsed, diff: step.diff }, null, 2));
    break;
  }

  case 'report': generateReport(); break;
  case 'reset': saveHistory([]); console.log('History cleared.'); break;
  default: console.log(ac([command, ...actionTokens]));
}

// ── Report ──
function generateReport() {
  const history = loadHistory();
  if (!history.length) { console.log('No steps. Use observe/act-observe first.'); return; }

  const goals = [...new Set(history.map(s => s.goal).filter(Boolean))];
  const platforms = [...new Set(history.map(s => s.platform).filter(Boolean))];

  const stepsHtml = history.map((s, i) => {
    const num = i + 1;
    const pClass = s.platform || 'macos';
    const pLabel = { macos: '🖥 macOS', web: '🌐 Web', ios: '📱 iOS' }[pClass] || pClass;

    // Goal marker
    const goalHtml = s.goal ? `<div class="step-goal">🎯 ${esc(s.goal)}</div>` : '';
    // Note (semantic)
    const noteHtml = s.note ? `<div class="step-note">💭 ${esc(s.note)}</div>` : '';

    if (s.type === 'observe') {
      return `
      <div class="step">
        ${goalHtml}
        <div class="step-header">
          <span class="step-num">${num}</span>
          <span class="step-type observe">👁 OBSERVE</span>
          <span class="platform-tag ${pClass}">${pLabel}</span>
          <span class="step-time">${fmtTime(s.timestamp)}</span>
        </div>
        ${noteHtml}
        ${s.semantic ? `<div class="semantic">📋 ${esc(s.semantic)}</div>` : ''}
        ${s.screenshot ? `<div class="screenshot"><img src="${s.screenshot}"></div>` : ''}
        ${s.elements ? `<details class="tree"><summary>Element tree (${s.elementCount})</summary><pre>${esc(s.elements)}</pre></details>` : ''}
      </div>`;
    }

    if (s.type === 'act') {
      const ok = s.result?.ok !== false;
      return `
      <div class="step">
        <div class="step-header">
          <span class="step-num">${num}</span>
          <span class="step-type act">🤚 ACT</span>
          <span class="platform-tag ${pClass}">${pLabel}</span>
          <span class="step-action">${esc(s.action)}</span>
          <span class="step-result ${ok ? 'ok' : 'fail'}">${ok ? '✅' : '❌'}</span>
        </div>
        ${noteHtml}
      </div>`;
    }

    if (s.type === 'act-observe') {
      const ok = s.result?.ok !== false;
      return `
      <div class="step">
        ${goalHtml}
        <div class="step-header">
          <span class="step-num">${num}</span>
          <span class="step-type act-observe">🤚→👁 ACT + OBSERVE</span>
          <span class="platform-tag ${pClass}">${pLabel}</span>
          <span class="step-action">${esc(s.action)}</span>
          <span class="step-result ${ok ? 'ok' : 'fail'}">${ok ? '✅' : '❌'}</span>
        </div>
        ${noteHtml}
        ${s.diff ? `<div class="diff">🔄 ${esc(s.diff)}</div>` : ''}
        <div class="before-after">
          <div class="ba-col">
            <div class="ba-label">Before</div>
            ${s.before?.screenshot ? `<img src="${s.before.screenshot}">` : ''}
            ${s.before?.semantic ? `<div class="ba-semantic">${esc(s.before.semantic)}</div>` : ''}
          </div>
          <div class="ba-arrow">→</div>
          <div class="ba-col">
            <div class="ba-label">After</div>
            ${s.after?.screenshot ? `<img src="${s.after.screenshot}">` : ''}
            ${s.after?.semantic ? `<div class="ba-semantic">${esc(s.after.semantic)}</div>` : ''}
          </div>
        </div>
        <details class="tree"><summary>Element diff</summary>
          <div class="diff-grid">
            <div><strong>Before (${s.before?.elementCount || 0})</strong><pre>${esc(s.before?.elements || '')}</pre></div>
            <div><strong>After (${s.after?.elementCount || 0})</strong><pre>${esc(s.after?.elements || '')}</pre></div>
          </div>
        </details>
      </div>`;
    }
    return '';
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>agent-control — Run Report</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0b;--bg2:#111113;--bg3:#1a1a1e;--border:#2a2a2e;--text:#e8e8ec;--text2:#8888a0;--accent:#6ee7b7;--accent2:#34d399;--macos:#f472b6;--web:#60a5fa;--ios:#fbbf24;--mono:'JetBrains Mono',monospace;--serif:'Instrument Serif',Georgia,serif}
body{background:var(--bg);color:var(--text);font-family:var(--mono);font-size:13px;line-height:1.7;padding:40px 24px}
.container{max-width:1200px;margin:0 auto}
h1{font-family:var(--serif);font-size:42px;font-weight:400;margin-bottom:8px}
h1 em{color:var(--accent);font-style:italic}
.meta{color:var(--text2);font-size:12px;margin-bottom:16px}
.goals{margin-bottom:48px;padding:16px 20px;background:var(--bg2);border:1px solid var(--border);border-radius:8px}
.goals-label{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:var(--text2);margin-bottom:8px}
.goals-list{color:var(--accent);font-size:14px}

.step{border:1px solid var(--border);border-radius:12px;margin-bottom:24px;overflow:hidden;background:var(--bg2)}
.step-header{display:flex;align-items:center;gap:12px;padding:16px 20px;background:var(--bg3);border-bottom:1px solid var(--border);flex-wrap:wrap}
.step-num{width:28px;height:28px;border-radius:50%;background:var(--border);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0}
.step-type{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;padding:3px 10px;border-radius:4px;font-weight:500}
.step-type.observe{background:rgba(96,165,250,0.15);color:var(--web)}
.step-type.act{background:rgba(244,114,182,0.15);color:var(--macos)}
.step-type.act-observe{background:rgba(110,231,183,0.15);color:var(--accent)}
.platform-tag{font-size:11px;padding:2px 8px;border-radius:3px;border:1px solid var(--border)}
.platform-tag.macos{color:var(--macos);border-color:rgba(244,114,182,0.3)}
.platform-tag.web{color:var(--web);border-color:rgba(96,165,250,0.3)}
.platform-tag.ios{color:var(--ios);border-color:rgba(251,191,36,0.3)}
.step-action{color:var(--text);font-weight:500;font-size:14px}
.step-result{font-size:16px}
.step-result.ok{color:var(--accent2)}
.step-result.fail{color:#ef4444}
.step-time{margin-left:auto;color:#444;font-size:11px}

.step-goal{padding:12px 20px;background:rgba(110,231,183,0.05);border-bottom:1px solid var(--border);font-size:14px;color:var(--accent)}
.step-note{padding:12px 20px;font-size:13px;color:var(--text);font-style:italic;border-bottom:1px solid rgba(42,42,46,0.5)}
.semantic{padding:12px 20px;font-size:12px;color:var(--text2);border-bottom:1px solid rgba(42,42,46,0.5)}
.diff{padding:12px 20px;font-size:12px;color:var(--ios);background:rgba(251,191,36,0.05)}

.screenshot{padding:20px}
.screenshot img{width:100%;border-radius:8px;border:1px solid var(--border)}

.tree{padding:0 20px 20px}
.tree summary{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:var(--text2);cursor:pointer;padding:12px 0}
.tree pre{background:var(--bg);padding:16px;border-radius:8px;font-size:11px;line-height:1.5;overflow-x:auto;max-height:250px;overflow-y:auto;color:var(--text2)}

.before-after{display:grid;grid-template-columns:1fr auto 1fr;gap:0;padding:20px}
.ba-col img{width:100%;border-radius:8px;border:1px solid var(--border);margin-bottom:8px}
.ba-label{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:var(--text2);margin-bottom:12px}
.ba-semantic{font-size:11px;color:var(--text2);margin-top:8px;line-height:1.5}
.ba-arrow{display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--accent);padding:0 16px}

.diff-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.diff-grid pre{background:var(--bg);padding:12px;border-radius:6px;font-size:10px;line-height:1.4;max-height:200px;overflow-y:auto;color:var(--text2)}
.diff-grid strong{font-size:11px;color:var(--text2);display:block;margin-bottom:6px}

@media(max-width:768px){.before-after{grid-template-columns:1fr}.ba-arrow{transform:rotate(90deg);padding:8px 0}.diff-grid{grid-template-columns:1fr}}
</style></head>
<body><div class="container">
  <h1>Run <em>Report</em></h1>
  <div class="meta">${history.length} steps · platforms: ${platforms.join(', ')} · ${new Date().toLocaleString()}</div>
  ${goals.length ? `<div class="goals"><div class="goals-label">Goals</div><div class="goals-list">${goals.map(g => `🎯 ${esc(g)}`).join('<br>')}</div></div>` : ''}
  ${stepsHtml}
</div></body></html>`;

  const p = path.join(REPORT_DIR, 'report.html');
  fs.writeFileSync(p, html);
  console.log(`Report: ${p}`);
  spawnSync('open', [p]);
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtTime(t) { try { return new Date(t).toLocaleTimeString(); } catch { return t || ''; } }
