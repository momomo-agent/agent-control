#!/usr/bin/env node
/**
 * agent-control Goal Runner — 单步执行模式
 *
 * 不自带 LLM，而是作为 agent 的工具被调用：
 *   1. agent 调用 goal-runner observe → 拿到当前 UI 状态
 *   2. agent 决策下一步
 *   3. agent 调用 goal-runner act <action> → 执行并返回新状态
 *
 * Usage:
 *   node goal-runner.js -p macos observe              # 看当前状态
 *   node goal-runner.js -p macos act click @e3        # 执行动作并返回新状态
 *   node goal-runner.js -p macos act dblclick @e5     # 双击
 *   node goal-runner.js -p web act open example.com   # Web 打开页面
 *   node goal-runner.js -p macos act-observe click @e3 # 执行 + 自动 observe
 *
 * 也支持自动模式（需要 ANTHROPIC_API_KEY 或 OPENAI_API_KEY）：
 *   node goal-runner.js -p macos --goal "打开 README" --auto
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CLI = path.join(__dirname, 'cli.js');

// ── Parse args ──
const args = process.argv.slice(2);
function flag(names, def) {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return def;
}

const platform = flag(['--platform', '-p'], 'macos');
const pid = flag(['--pid'], null);

// ── Agent Control wrapper ──
function ac(tokens) {
  const argv = [CLI, '-p', platform, ...tokens, ...(pid ? ['--pid', pid] : [])];
  const r = spawnSync('node', argv, { encoding: 'utf8', timeout: 30000 });
  return (r.stdout || '').trim();
}

function observe() {
  const raw = ac(['snapshot', '-i']);
  let elements = [];
  try { elements = JSON.parse(raw); } catch {}

  // Compact format for LLM consumption
  const summary = elements.map(e => {
    const v = e.value || e.label || '';
    return `${e.ref} ${e.role}${v ? ` "${v}"` : ''}`;
  }).join('\n');

  return { elements, summary, count: elements.length };
}

function act(actionTokens) {
  return ac(actionTokens);
}

// ── CLI routing ──
const cmd = args.find(a => !a.startsWith('-') && !['macos', 'web', 'ios'].includes(a) &&
  args.indexOf(a) > 0 && !args[args.indexOf(a) - 1]?.startsWith('-'));

// Find command position (first non-flag arg after platform)
let cmdIdx = -1;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-p' || args[i] === '--platform' || args[i] === '--pid') { i++; continue; }
  if (args[i].startsWith('-')) continue;
  cmdIdx = i;
  break;
}

const command = cmdIdx >= 0 ? args[cmdIdx] : 'observe';
const restArgs = cmdIdx >= 0 ? args.slice(cmdIdx + 1).filter(a =>
  a !== '-p' && a !== '--platform' && a !== '--pid' &&
  !['macos', 'web', 'ios'].includes(a)
) : [];

// Filter out platform/pid from restArgs
const actionTokens = [];
for (let i = 0; i < restArgs.length; i++) {
  if (restArgs[i] === '-p' || restArgs[i] === '--platform' || restArgs[i] === '--pid') { i++; continue; }
  actionTokens.push(restArgs[i]);
}

switch (command) {
  case 'observe': case 'look': case 'see': {
    const state = observe();
    console.log(JSON.stringify({
      ok: true,
      action: 'observe',
      count: state.count,
      elements: state.summary,
    }, null, 2));
    break;
  }

  case 'act': case 'do': case 'exec': {
    const result = act(actionTokens);
    console.log(result);
    break;
  }

  case 'act-observe': case 'do-look': {
    // Execute action then immediately observe
    const actResult = act(actionTokens);
    spawnSync('sleep', ['0.3']); // Brief pause for UI to update
    const state = observe();
    console.log(JSON.stringify({
      ok: true,
      actionResult: safeParse(actResult),
      observe: {
        count: state.count,
        elements: state.summary,
      },
    }, null, 2));
    break;
  }

  default:
    // Treat as action directly: "click @e3" etc
    const directResult = act([command, ...actionTokens]);
    console.log(directResult);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}
