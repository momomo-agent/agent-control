/**
 * RunRecord — 每次 agent-control 执行的完整记录
 * 
 * 用法：
 *   const run = new RunRecord('web', 'signup-flow');
 *   const step = run.step('open', { url: 'http://...' });
 *   step.succeed({ url: 'http://...' });
 *   // or step.fail('TIMEOUT', 'page load exceeded 15s');
 *   run.finish();
 *   run.save();  // → runs/<runId>/record.json + artifacts/
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUNS_DIR = path.join(__dirname, 'runs');

// Failure taxonomy
const FAILURE_TAGS = [
  'TIMEOUT',      // 操作超时
  'NOT_FOUND',    // 元素找不到
  'NOT_READY',    // 元素存在但不可交互
  'FOCUS',        // 窗口/焦点问题
  'PERMISSION',   // 权限不足
  'DIALOG',       // 意外弹窗/对话框
  'COORD_DRIFT',  // 坐标漂移
  'ASSERT_FAIL',  // 验证失败
  'DRIVER_ERROR', // driver 内部错误
  'UNKNOWN',
];

class RunRecord {
  constructor(platform, name) {
    const ts = Date.now();
    this.runId = `${new Date(ts).toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${crypto.randomBytes(3).toString('hex')}`;
    this.platform = platform;
    this.name = name || 'unnamed';
    this.startMs = ts;
    this.endMs = null;
    this.status = 'running'; // running | passed | failed
    this.steps = [];
    this.dir = path.join(RUNS_DIR, this.runId);
    this.artifactsDir = path.join(this.dir, 'artifacts');
    fs.mkdirSync(this.artifactsDir, { recursive: true });
  }

  step(action, params = {}) {
    const idx = this.steps.length;
    const s = {
      idx,
      action,
      params,
      startMs: Date.now(),
      endMs: null,
      status: 'running',
      failureTag: null,
      failureMsg: null,
      artifacts: [],
      retries: 0,
    };
    this.steps.push(s);

    return {
      artifact: (name, data) => {
        const file = `step-${idx}-${name}`;
        const full = path.join(this.artifactsDir, file);
        if (Buffer.isBuffer(data)) fs.writeFileSync(full, data);
        else fs.writeFileSync(full, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        s.artifacts.push(file);
        return full;
      },
      succeed: (result) => {
        s.endMs = Date.now();
        s.status = 'passed';
        s.result = result;
      },
      fail: (tag, msg) => {
        s.endMs = Date.now();
        s.status = 'failed';
        s.failureTag = FAILURE_TAGS.includes(tag) ? tag : 'UNKNOWN';
        s.failureMsg = msg;
      },
      retry: () => { s.retries++; },
      raw: s,
    };
  }

  finish() {
    this.endMs = Date.now();
    const failed = this.steps.some(s => s.status === 'failed');
    this.status = failed ? 'failed' : 'passed';
  }

  toJSON() {
    return {
      runId: this.runId,
      platform: this.platform,
      name: this.name,
      status: this.status,
      resumedFrom: this.resumedFrom || null,
      startMs: this.startMs,
      endMs: this.endMs,
      durationMs: this.endMs ? this.endMs - this.startMs : null,
      steps: this.steps,
      summary: this._summary(),
    };
  }

  _summary() {
    const total = this.steps.length;
    const passed = this.steps.filter(s => s.status === 'passed').length;
    const failed = this.steps.filter(s => s.status === 'failed').length;
    const tags = {};
    for (const s of this.steps) {
      if (s.failureTag) tags[s.failureTag] = (tags[s.failureTag] || 0) + 1;
    }
    const totalMs = this.endMs ? this.endMs - this.startMs : null;
    return { total, passed, failed, failureTags: tags, totalMs };
  }

  save() {
    const file = path.join(this.dir, 'record.json');
    fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 2));
    return file;
  }

  /** 人类可读摘要 */
  printSummary() {
    const s = this._summary();
    const lines = [
      `Run: ${this.runId}`,
      `Platform: ${this.platform} | Name: ${this.name}`,
      `Status: ${this.status.toUpperCase()} (${s.passed}/${s.total} steps passed)`,
    ];
    if (s.totalMs) lines.push(`Duration: ${(s.totalMs / 1000).toFixed(1)}s`);
    if (s.failed > 0) {
      lines.push(`Failures: ${Object.entries(s.failureTags).map(([k, v]) => `${k}×${v}`).join(', ')}`);
    }
    return lines.join('\n');
  }
}

module.exports = { RunRecord, FAILURE_TAGS };
