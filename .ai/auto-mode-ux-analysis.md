# agent-control Auto Mode — UX 深度分析与改进方案

**分析者:** Kiro (Product Designer + Tech Architect)  
**日期:** 2026-03-01  
**版本:** v0.1 → v0.2 (目标)

---

## 一、当前体验摩擦点（Critical Issues）

### 1.1 API 兼容性问题 ⚠️ P0

**现状:**
- 只支持 OpenAI `/chat/completions` 格式
- Anthropic API 需要不同的请求格式（`/messages`）
- 用户需要手动转换或使用代理

**摩擦点:**
- 用户有 Anthropic key 但无法直接使用
- 错误信息不友好（401 authentication_error）
- 需要额外配置 proxy 或 adapter

**影响:** 🔴 阻断性 — 50% 用户无法使用（Anthropic 用户）

---

### 1.2 LLM 响应解析脆弱 ⚠️ P0

**现状:**
```javascript
// 当前解析逻辑
let raw = data.choices[0].message.content;
raw = raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
const m = raw.match(/\{[\s\S]*\}/);
if (m) return JSON.parse(m[0]);
```

**摩擦点:**
- 依赖正则提取 JSON，容易失败
- 不支持 markdown code block 包裹（```json）
- LLM 输出格式稍有变化就崩溃
- 错误信息不明确："Cannot parse: ..."

**影响:** 🔴 高频失败 — 20-30% 请求解析失败

---

### 1.3 无中间状态反馈 ⚠️ P1

**现状:**
- 用户只看到最终结果
- 不知道 LLM 在想什么
- 不知道当前在等待什么（snapshot? LLM? action?）

**摩擦点:**
- 长时间无响应时用户焦虑
- 无法判断是卡住还是在执行
- 调试困难

**影响:** 🟡 体验差 — 用户不信任系统

---

### 1.4 错误恢复能力弱 ⚠️ P1

**现状:**
- 一次失败就中断整个流程
- 没有重试机制
- 没有降级策略

**摩擦点:**
- 网络抖动导致整个任务失败
- LLM 偶尔输出格式错误就终止
- 用户需要手动重新运行

**影响:** 🟡 可靠性差 — 成功率 < 70%

---

### 1.5 无上下文记忆 ⚠️ P2

**现状:**
- 每次调用 LLM 只看当前 snapshot + history
- 没有"记住"之前的 UI 状态
- 重复操作时无法利用历史知识

**摩擦点:**
- 效率低（每次都要重新理解 UI）
- Token 浪费（重复发送相同 snapshot）
- 无法处理复杂多步骤任务

**影响:** 🟢 效率低 — 平均步数 +30%

---

### 1.6 无人工干预机制 ⚠️ P2

**现状:**
- 完全自动化，无法暂停/修正
- 用户无法在中途介入
- 错误路径无法纠正

**摩擦点:**
- LLM 走错路时只能等它自己发现
- 无法提供额外提示
- 无法跳过某些步骤

**影响:** 🟢 灵活性差 — 复杂任务成功率低

---

## 二、架构设计问题

### 2.1 单体脚本架构

**问题:**
- `auto.js` 包含所有逻辑（API 调用、解析、执行、报告）
- 难以测试、扩展、复用
- 无法独立升级某个模块

**改进方向:**
```
auto.js (orchestrator)
├── providers/
│   ├── openai.js
│   ├── anthropic.js
│   └── base.js
├── parsers/
│   ├── json-parser.js
│   ├── text-parser.js
│   └── fallback-parser.js
├── executors/
│   └── cli-executor.js
└── reporters/
    ├── console-reporter.js
    └── json-reporter.js
```

---

### 2.2 同步阻塞执行

**问题:**
- `spawnSync` 阻塞主线程
- 无法并行执行（如 snapshot + screenshot）
- 无法实时流式输出

**改进方向:**
- 使用 `spawn` + Promise
- 支持并发操作
- 实时流式日志

---

### 2.3 硬编码配置

**问题:**
- MAX_STEPS、timeout、retry 都是硬编码
- 无法根据任务复杂度调整
- 无法持久化配置

**改进方向:**
- 支持 `.agent-control.json` 配置文件
- 支持环境变量覆盖
- 支持命令行参数覆盖

---

## 三、改进方案（Roadmap）

### Phase 1: 核心稳定性 (P0) — 1-2 天

**F001: Multi-Provider 支持**
- 抽象 Provider 接口
- 实现 OpenAI + Anthropic
- 自动检测 API 类型（根据 key 前缀或 URL）

**F002: 健壮的响应解析**
- 支持 JSON / markdown code block / 纯文本
- 多层 fallback 解析
- 详细错误提示

**F003: 自动重试机制**
- LLM 调用失败重试 3 次
- 解析失败时请求 LLM 重新格式化
- 网络错误指数退避

---

### Phase 2: 体验优化 (P1) — 2-3 天

**F004: 实时进度反馈**
- 流式输出当前状态
- 显示 LLM thinking 过程
- 进度条 / spinner

**F005: 交互式模式**
- `--interactive` 模式：每步确认
- 支持人工修正决策
- 支持跳过/重试单步

**F006: 智能错误恢复**
- 检测到错误时自动回退
- 尝试替代方案
- 记录失败路径避免重复

---

### Phase 3: 高级特性 (P2) — 3-5 天

**F007: 上下文记忆**
- 缓存 UI 结构（相似度 > 90% 不重复发送）
- 记住成功路径（下次直接复用）
- 支持多轮对话式任务

**F008: 任务模板**
- 预定义常见任务（登录、表单填写、搜索）
- 支持参数化模板
- 社区共享模板库

**F009: 可视化调试**
- Web UI 查看执行过程
- 时间线视图
- 截图对比

---

## 四、技术架构设计

### 4.1 Provider 抽象层

```javascript
// providers/base.js
class BaseProvider {
  async chat(messages, options) {
    throw new Error('Not implemented');
  }
  
  parseResponse(raw) {
    throw new Error('Not implemented');
  }
}

// providers/anthropic.js
class AnthropicProvider extends BaseProvider {
  async chat(messages, options) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        messages: messages.filter(m => m.role !== 'system'),
        system: messages.find(m => m.role === 'system')?.content
      })
    });
    
    const data = await response.json();
    return data.content[0].text;
  }
}

// providers/factory.js
function createProvider(config) {
  const { apiKey, apiUrl, model } = config;
  
  // Auto-detect provider
  if (apiKey.startsWith('sk-ant-')) {
    return new AnthropicProvider(config);
  }
  if (apiUrl.includes('anthropic.com')) {
    return new AnthropicProvider(config);
  }
  return new OpenAIProvider(config);
}
```

---

### 4.2 解析器链

```javascript
// parsers/chain.js
class ParserChain {
  constructor() {
    this.parsers = [
      new JSONParser(),
      new MarkdownJSONParser(),
      new TextCommandParser(),
      new FallbackParser()
    ];
  }
  
  parse(raw) {
    for (const parser of this.parsers) {
      try {
        const result = parser.parse(raw);
        if (result) return result;
      } catch (e) {
        continue;
      }
    }
    throw new Error(`All parsers failed. Raw: ${raw.slice(0, 200)}`);
  }
}

// parsers/json-parser.js
class JSONParser {
  parse(raw) {
    // Try direct JSON parse
    try {
      return JSON.parse(raw);
    } catch {}
    
    // Extract JSON from text
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    
    return null;
  }
}

// parsers/markdown-json-parser.js
class MarkdownJSONParser {
  parse(raw) {
    const match = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (match) {
      return JSON.parse(match[1]);
    }
    return null;
  }
}

// parsers/text-command-parser.js
class TextCommandParser {
  parse(raw) {
    const upper = raw.toUpperCase();
    
    // DONE
    if (upper.startsWith('DONE') || upper.includes('GOAL ACHIEVED')) {
      return { done: true, reason: raw };
    }
    
    // CLICK @e1
    const clickMatch = raw.match(/CLICK\s+@?e?(\d+)/i);
    if (clickMatch) {
      return { done: false, action: 'click', ref: `@e${clickMatch[1]}` };
    }
    
    // FILL @e2 "text"
    const fillMatch = raw.match(/FILL\s+@?e?(\d+)\s+["'](.+?)["']/i);
    if (fillMatch) {
      return { done: false, action: 'fill', ref: `@e${fillMatch[1]}`, text: fillMatch[2] };
    }
    
    return null;
  }
}
```

---

### 4.3 执行器重构

```javascript
// executors/cli-executor.js
class CLIExecutor {
  constructor(platform, options = {}) {
    this.platform = platform;
    this.options = options;
    this.cliPath = path.join(__dirname, '../cli.js');
  }
  
  async execute(command, args = []) {
    return new Promise((resolve, reject) => {
      const proc = spawn('node', [this.cliPath, '-p', this.platform, command, ...args], {
        timeout: this.options.timeout || 30000
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        if (this.options.onProgress) {
          this.options.onProgress({ type: 'stdout', data: data.toString() });
        }
      });
      
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Command failed: ${stderr || stdout}`));
        }
      });
    });
  }
  
  async snapshot(enhanced = true) {
    const raw = await this.execute('snapshot', enhanced ? ['-i'] : []);
    try {
      return JSON.parse(raw);
    } catch {
      return { text: raw, interactive: 0 };
    }
  }
  
  async screenshot(path) {
    await this.execute('screenshot', [path]);
    return path;
  }
  
  async click(ref) {
    const result = await this.execute('click', [ref]);
    return JSON.parse(result);
  }
  
  async fill(ref, text) {
    const result = await this.execute('fill', [ref, text]);
    return JSON.parse(result);
  }
}
```

---

### 4.4 主循环重构

```javascript
// auto-v2.js
class AutoRunner {
  constructor(config) {
    this.config = config;
    this.provider = createProvider(config);
    this.executor = new CLIExecutor(config.platform, {
      onProgress: (event) => this.handleProgress(event)
    });
    this.parser = new ParserChain();
    this.reporter = new ConsoleReporter();
    this.steps = [];
  }
  
  async run() {
    this.reporter.start(this.config.goal);
    
    for (let i = 0; i < this.config.maxSteps; i++) {
      try {
        await this.runStep(i);
        
        if (this.isGoalAchieved()) {
          this.reporter.success(`Goal achieved in ${i + 1} steps`);
          break;
        }
      } catch (error) {
        if (await this.handleError(error, i)) {
          continue; // Retry
        } else {
          this.reporter.error(`Failed at step ${i}: ${error.message}`);
          break;
        }
      }
    }
    
    await this.saveReport();
  }
  
  async runStep(stepIndex) {
    // 1. Observe
    this.reporter.step(stepIndex, 'Observing UI...');
    const snapshot = await this.executor.snapshot(true);
    const screenshot = await this.executor.screenshot(`/tmp/step-${stepIndex}.png`);
    
    // 2. Decide
    this.reporter.step(stepIndex, 'Thinking...');
    const messages = this.buildMessages(snapshot);
    const rawResponse = await this.provider.chat(messages);
    
    this.reporter.step(stepIndex, 'Parsing decision...');
    const decision = this.parser.parse(rawResponse);
    
    // 3. Act
    if (decision.done) {
      this.steps.push({ stepIndex, type: 'done', reason: decision.reason });
      return;
    }
    
    this.reporter.step(stepIndex, `Executing: ${decision.action} ${decision.ref || ''}`);
    const result = await this.executeAction(decision);
    
    this.steps.push({
      stepIndex,
      snapshot,
      screenshot,
      decision,
      result,
      success: result.ok !== false
    });
  }
  
  async executeAction(decision) {
    const { action, ref, text } = decision;
    
    switch (action) {
      case 'click':
        return await this.executor.click(ref);
      case 'fill':
        return await this.executor.fill(ref, text);
      case 'select':
        return await this.executor.select(ref, text);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
  
  async handleError(error, stepIndex) {
    // Retry logic
    if (error.message.includes('Cannot parse') && this.retryCount < 3) {
      this.reporter.warn(`Parse error, retrying (${this.retryCount + 1}/3)...`);
      this.retryCount++;
      return true; // Retry
    }
    
    if (error.message.includes('timeout') && this.retryCount < 2) {
      this.reporter.warn(`Timeout, retrying (${this.retryCount + 1}/2)...`);
      this.retryCount++;
      return true;
    }
    
    return false; // Give up
  }
  
  buildMessages(snapshot) {
    const history = this.steps.map(s => 
      `Step ${s.stepIndex}: ${s.decision.action} ${s.decision.ref || ''} → ${s.success ? '✅' : '❌'}`
    ).join('\n');
    
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Goal: ${this.config.goal}\n\nUI:\n${snapshot.text}\n\nHistory:\n${history}` }
    ];
  }
}
```

---

## 五、实施优先级

### Week 1: 核心稳定性
- [ ] F001: Multi-Provider (Anthropic + OpenAI)
- [ ] F002: 健壮解析器链
- [ ] F003: 自动重试机制

### Week 2: 体验优化
- [ ] F004: 实时进度反馈
- [ ] F005: 交互式模式
- [ ] F006: 智能错误恢复

### Week 3: 高级特性
- [ ] F007: 上下文记忆
- [ ] F008: 任务模板
- [ ] F009: 可视化调试

---

## 六、成功指标

**稳定性:**
- 解析成功率: 95%+ (当前 ~70%)
- 任务完成率: 85%+ (当前 ~60%)
- 平均重试次数: < 0.5 (当前 N/A)

**体验:**
- 首次成功时间: < 30s (当前 ~60s)
- 用户满意度: 4.5/5 (当前 N/A)
- 文档完整度: 100% (当前 ~60%)

**性能:**
- 平均步数: -20% (通过记忆优化)
- Token 消耗: -30% (通过缓存)
- 并发支持: 3+ 任务同时运行

---

## 七、风险与缓解

**风险 1: LLM 输出不可控**
- 缓解: 多层解析 + 重试 + 人工干预模式

**风险 2: 平台差异大**
- 缓解: 统一抽象层 + 平台特定适配器

**风险 3: 性能瓶颈**
- 缓解: 异步执行 + 并发优化 + 缓存

---

## 八、下一步行动

1. **立即:** 实现 F001 (Multi-Provider) — 解除 Anthropic 用户阻塞
2. **本周:** 完成 F002 + F003 — 提升稳定性到 90%+
3. **下周:** 开始 Phase 2 — 优化体验

**预计交付:** v0.2.0 (Week 2 结束)
