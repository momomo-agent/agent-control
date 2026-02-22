#!/usr/bin/env node
/**
 * agent-control Auto Runner — goal-based LLM 循环
 *
 * Usage:
 *   node auto.js -p web --goal "点击 More information 链接" --url https://example.com
 *   AC_API_KEY=xxx AC_API_URL=https://api.openai.com/v1 AC_MODEL=gpt-4o node auto.js -p web --goal "..."
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CLI = path.join(__dirname, 'cli.js');
const REPORT_DIR = '/tmp/agent-control';
const MAX_STEPS = 15;

// ── Parse ──
const raw = process.argv.slice(2);
function flag(names, def) {
  for (const n of names) { const i = raw.indexOf(n); if (i !== -1 && i + 1 < raw.length) return raw[i + 1]; }
  return def;
}

const platform = flag(['--platform', '-p'], 'web');
const pid = flag(['--pid'], null);
const goal = flag(['--goal', '-g'], null);
const url = flag(['--url'], null);
const maxSteps = parseInt(flag(['--max', '-m'], MAX_STEPS));

const API_KEY = process.env.AC_API_KEY || process.env.OPENAI_API_KEY;
const API_URL = process.env.AC_API_URL || 'https://api.openai.com/v1';
const MODEL = process.env.AC_MODEL || 'gpt-4o-mini';

if (!goal) { console.error('Usage: node auto.js -p <platform> --goal "..." [--url <url>]'); process.exit(1); }
if (!API_KEY) { console.error('Set AC_API_KEY or OPENAI_API_KEY'); process.exit(1); }

// ── Helpers ──
function ac(tokens) {
  const argv = [CLI, '-p', platform, ...tokens, ...(pid ? ['--pid', pid] : [])];
  const r = spawnSync('node', argv, { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}

function snapshot() {
  const r = ac(['snapshot', '-i']);
  try {
    const els = JSON.parse(r);
    const { enhance } = require('./snapshot-enhance');
    return enhance(Array.isArray(els) ? els : Object.values(els), { platform });
  } catch { return { text: r, interactive: 0 }; }
}

function screenshot(label) {
  const p = path.join(REPORT_DIR, `auto-${Date.now()}-${label}.png`);
  ac(['screenshot', p]);
  return p;
}

async function callLLM(messages) {
  const resp = await fetch(`${API_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0 }),
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  let raw = data.choices[0].message.content;
  raw = raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  // Try JSON first
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  // Fallback: parse "CLICK @e1" / "FILL @e2 hello" / "DONE reason"
  const upper = raw.toUpperCase();
  if (upper.startsWith('DONE') || upper.includes('"done":true') || upper.includes('"done": true'))
    return { done: true, reason: raw };
  const act = raw.match(/^(click|fill|select|press|swipe)\s+@?e?(\d+)\s*(.*)/i);
  if (act) return { done: false, reason: raw, action: act[1].toLowerCase(), ref: `@e${act[2]}`, text: act[3] || undefined };
  throw new Error('Cannot parse: ' + raw.slice(0, 200));
}

const SYSTEM = `You control a GUI. You see interactive elements and pick the next action toward a goal.

RESPOND WITH ONLY A JSON OBJECT. No explanation, no markdown, no text outside the JSON.

Action format:
{"done":false,"reason":"...","action":"click","ref":"@eN"}
{"done":false,"reason":"...","action":"fill","ref":"@eN","text":"..."}

Goal achieved:
{"done":true,"reason":"..."}

Rules:
- ONLY use refs from the snapshot
- One action per response
- Pick the closest match if exact label differs
- If stuck 3 times, {"done":true,"reason":"stuck"}`;

// ── Main loop ──
async function run() {
  const steps = [];
  try { fs.mkdirSync(REPORT_DIR, { recursive: true }); } catch {}

  // Open URL if provided
  if (url && platform === 'web') {
    ac(['open', url]);
    spawnSync('sleep', ['1']);
  }

  console.log(`🎯 Goal: ${goal}`);
  console.log(`🖥  Platform: ${platform} | Model: ${MODEL} | Max: ${maxSteps} steps\n`);

  for (let i = 0; i < maxSteps; i++) {
    // Observe
    const snap = snapshot();
    const ss = screenshot(`step-${i}`);

    // Auto-done if no interactive elements after an action
    if (i > 0 && snap.interactive === 0) {
      console.log(`✅ Done (step ${i}): no interactive elements — goal likely achieved`);
      steps.push({ i, action: 'done', reason: 'no interactive elements remaining', ok: true, screenshot: ss });
      break;
    }

    // Build messages
    const history = steps.map(s => `Step ${s.i}: ${s.action} ${s.ref||''} ${s.text||''} → ${s.ok ? '✅' : '❌'} ${s.reason}`).join('\n');
    const userMsg = `Goal: ${goal}\n\nCurrent UI (${snap.interactive} interactive elements):\n${snap.text}\n\n${history ? `History:\n${history}` : 'No actions taken yet.'}`;

    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userMsg },
    ];

    // Decide
    let decision;
    try {
      decision = await callLLM(messages);
    } catch (e) {
      console.error(`  ❌ LLM error: ${e.message}`);
      break;
    }

    if (decision.done) {
      console.log(`✅ Done (step ${i}): ${decision.reason}`);
      steps.push({ i, action: 'done', reason: decision.reason, ok: true, screenshot: ss });
      break;
    }

    // Act
    const { action, ref, text } = decision;
    const tokens = [action];
    if (ref) tokens.push(ref);
    if (text) tokens.push(text);

    console.log(`  ${i + 1}. ${action} ${ref || ''} ${text ? `"${text}"` : ''} — ${decision.reason}`);
    const result = ac(tokens);
    let ok = true;
    try { ok = JSON.parse(result).ok !== false; } catch {}

    steps.push({ i, action, ref, text, reason: decision.reason, ok, screenshot: ss });
    spawnSync('sleep', ['0.5']);
  }

  // Final screenshot
  screenshot('final');

  // Save report
  const report = { goal, platform, model: MODEL, steps, timestamp: new Date().toISOString() };
  const reportPath = path.join(REPORT_DIR, 'auto-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n📊 ${steps.length} steps. Report: ${reportPath}`);
}

run().catch(e => { console.error(e); process.exit(1); });
