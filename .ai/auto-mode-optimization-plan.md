# agent-control Auto Mode — 核心优化方案

**分析者:** Kiro (Product Designer + Tech Architect)  
**日期:** 2026-03-01  
**目标:** 提升成功率 70% → 90%，优化用户体验

---

## 优先级排序

| # | 问题 | 优先级 | 影响 | 预计工作量 |
|---|------|--------|------|-----------|
| 2 | LLM 响应解析脆弱 | P0 🔴 | 20-30% 失败率 | 1 天 |
| 3 | 无实时反馈 | P0 🔴 | 用户焦虑 | 0.5 天 |
| 4 | 错误恢复弱 | P1 🟡 | 成功率 -15% | 1 天 |
| 5 | 无上下文记忆 | P1 🟡 | Token +30% | 1.5 天 |
| 6 | 无人工干预 | P2 🟢 | 灵活性差 | 1 天 |

---

## 问题 2: LLM 响应解析脆弱 (P0)

### 为什么失败？

**当前代码:**
```javascript
let raw = data.choices[0].message.content;
raw = raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
const m = raw.match(/\{[\s\S]*\}/);
if (m) return JSON.parse(m[0]);
```

**失败场景:**

1. **Markdown 包裹**
```
LLM 输出:
```json
{"done": false, "action": "click", "ref": "@e5"}
```

正则匹配到整个 block，JSON.parse 失败
```

2. **多个 JSON 对象**
```
{"done": false, "action": "click", "ref": "@e5"}
{"reason": "clicked button"}

正则匹配到混合内容，格式错误
```

3. **前置解释**
```
I'll click the login button.
{"done": false, "action": "click", "ref": "@e5"}

正则包含解释文本，JSON 无效
```

### 解决方案: 多层解析器

```javascript
// parsers/json-parser.js
class JSONParser {
  parse(raw) {
    // 1. 直接 parse
    try { return JSON.parse(raw); } catch {}
    
    // 2. Markdown code block
    const md = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (md) {
      try { return JSON.parse(md[1]); } catch {}
    }
    
    // 3. 括号匹配（贪心）
    let depth = 0, start = -1;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (raw[i] === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          try {
            return JSON.parse(raw.slice(start, i + 1));
          } catch {}
        }
      }
    }
    
    return null;
  }
}

// parsers/text-parser.js
class TextParser {
  parse(raw) {
    const upper = raw.toUpperCase();
    
    // Done 检测（容错）
    if (upper.includes('DONE') || upper.includes('GOAL ACHIEVED') ||
        upper.includes('FINISHED') || upper.includes('COMPLETE')) {
      return { done: true, reason: raw };
    }
    
    // 命令检测
    const patterns = [
      { regex: /CLICK\s+@?e?(\d+)/i, action: 'click' },
      { regex: /FILL\s+@?e?(\d+)\s+["'](.+?)["']/i, action: 'fill' },
      { regex: /SELECT\s+@?e?(\d+)\s+["'](.+?)["']/i, action: 'select' }
    ];
    
    for (const { regex, action } of patterns) {
      const m = raw.match(regex);
      if (m) {
        return {
          done: false,
          action,
          ref: `@e${m[1]}`,
          text: m[2] || undefined
        };
      }
    }
    
    return null;
  }
}

// parsers/chain.js
class ParserChain {
  parse(raw) {
    const parsers = [
      new JSONParser(),
      new TextParser()
    ];
    
    for (const parser of parsers) {
      try {
        const result = parser.parse(raw);
        if (result && this.validate(result)) {
          return result;
        }
      } catch {}
    }
    
    throw new Error(`Parse failed. Raw: ${raw.slice(0, 200)}`);
  }
  
  validate(result) {
    if (result.done === true) return true;
    if (result.done === false && result.action && result.ref) return true;
    return false;
  }
}
```

**预期效果:** 解析成功率 70% → 95%

---

## 问题 3: 无实时反馈 (P0)

### 用户痛点

```bash
# 当前体验
$ node auto.js -p web --goal "登录"

🎯 Goal: 登录
🖥  Platform: web

[等待 30 秒...]  ← 用户焦虑：卡住了？

  1. click @e3 — ...
  2. fill @e5 — ...
```

### 解决方案: 流式日志

```javascript
// reporters/stream-reporter.js
class StreamReporter {
  constructor() {
    this.startTime = Date.now();
  }
  
  elapsed() {
    return ((Date.now() - this.startTime) / 1000).toFixed(1);
  }
  
  phase(step, name, detail = '') {
    const icons = {
      'snapshot': '👀',
      'thinking': '🧠',
      'parsing': '📝',
      'executing': '⚡'
    };
    console.log(`[${this.elapsed()}s] Step ${step}: ${icons[name]} ${name} ${detail}`);
  }
  
  decision(action, ref, text) {
    console.log(`         → ${action.toUpperCase()} ${ref} ${text ? `"${text}"` : ''}`);
  }
  
  result(ok, msg) {
    console.log(`         ${ok ? '✅' : '❌'} ${msg}`);
  }
}

// 使用
const reporter = new StreamReporter();

reporter.phase(1, 'snapshot');
// [0.2s] Step 1: 👀 snapshot

reporter.phase(1, 'thinking', '(Claude analyzing...)');
// [1.5s] Step 1: 🧠 thinking (Claude analyzing...)

reporter.decision('fill', '@e3', 'user@example.com');
// [2.0s] Step 1: → FILL @e3 "user@example.com"

reporter.result(true, 'Filled email');
// [2.1s] Step 1: ✅ Filled email
```

**预期效果:**
- 用户知道当前状态
- 焦虑感降低
- 调试更容易

---

## 问题 4: 错误恢复弱 (P1)

### 当前问题

```javascript
try {
  decision = await callLLM(messages);
} catch (e) {
  console.error(`❌ LLM error: ${e.message}`);
  break; // 直接终止！
}
```

**影响:**
- 网络抖动 → 任务失败
- 偶尔格式错误 → 任务失败
- 成功率 < 70%

### 解决方案: 自动重试

```javascript
// retry.js
async function retry(fn, options = {}) {
  const maxAttempts = options.maxAttempts || 3;
  const delayMs = options.delayMs || 1000;
  const backoff = options.backoff || 2;
  
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (error) {
      // 不可重试的错误
      if (!isRetryable(error)) throw error;
      
      // 最后一次尝试
      if (i === maxAttempts - 1) throw error;
      
      // 等待后重试
      const delay = delayMs * Math.pow(backoff, i);
      console.log(`⚠️  Retry ${i + 1}/${maxAttempts} in ${delay}ms: ${error.message}`);
      await sleep(delay);
    }
  }
}

function isRetryable(error) {
  const msg = error.message.toLowerCase();
  return msg.includes('timeout') ||
         msg.includes('econnrefused') ||
         msg.includes('429') ||
         msg.includes('503');
}

// 使用
const decision = await retry(
  () => callLLM(messages),
  { maxAttempts: 3, delayMs: 1000 }
);
```

**预期效果:** 成功率 70% → 85%

---

## 问题 5: 无上下文记忆 (P1)

### Token 浪费

```
Step 1: 发送 5KB snapshot
Step 2: UI 没变，又发送 5KB snapshot (重复!)
Step 3: UI 没变，又发送 5KB snapshot (重复!)

总浪费: 10KB
```

### 解决方案: 智能缓存

```javascript
// cache.js
class SnapshotCache {
  constructor() {
    this.cache = new Map();
  }
  
  hash(snapshot) {
    return snapshot.elements
      .map(e => `${e.ref}:${e.label}`)
      .join('|');
  }
  
  similarity(snap1, snap2) {
    const set1 = new Set(snap1.elements.map(e => e.ref));
    const set2 = new Set(snap2.elements.map(e => e.ref));
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
  }
  
  shouldSend(snapshot) {
    const hash = this.hash(snapshot);
    
    // 完全相同
    if (this.cache.has(hash)) {
      return { send: false, reason: 'identical' };
    }
    
    // 检查相似度
    for (const [cachedHash, cachedSnap] of this.cache.entries()) {
      const sim = this.similarity(snapshot, cachedSnap);
      if (sim > 0.95) {
        return { send: false, reason: `similar (${(sim * 100).toFixed(0)}%)` };
      }
    }
    
    // 需要发送
    this.cache.set(hash, snapshot);
    return { send: true };
  }
}

// 使用
const cache = new SnapshotCache();

const snap = await snapshot();
const decision = cache.shouldSend(snap);

if (decision.send) {
  messages.push({ role: 'user', content: snap.text });
} else {
  messages.push({ role: 'user', content: `UI unchanged (${decision.reason})` });
}
```

**预期效果:** Token 消耗 -30%

---

## 问题 6: 无人工干预 (P2)

### 用户痛点

- LLM 走错路无法纠正
- 无法跳过某些步骤
- 无法提供额外提示

### 解决方案: 交互模式

```javascript
// interactive.js
async function interactiveStep(step, snapshot, decision) {
  console.log(`\n[Step ${step}] LLM suggests:`);
  console.log(`  ${decision.action} ${decision.ref} ${decision.text || ''}`);
  console.log(`  Reason: ${decision.reason}`);
  
  const answer = await prompt('\nContinue? [y/n/s(kip)/e(dit)]: ');
  
  switch (answer.toLowerCase()) {
    case 'y':
    case '':
      return { action: 'continue', decision };
    
    case 'n':
      return { action: 'abort' };
    
    case 's':
      return { action: 'skip' };
    
    case 'e':
      const newAction = await prompt('Action: ');
      const newRef = await prompt('Ref: ');
      const newText = await prompt('Text (optional): ');
      return {
        action: 'continue',
        decision: { action: newAction, ref: newRef, text: newText || undefined }
      };
    
    default:
      return { action: 'continue', decision };
  }
}

// 使用
if (config.interactive) {
  const result = await interactiveStep(i, snapshot, decision);
  if (result.action === 'abort') break;
  if (result.action === 'skip') continue;
  decision = result.decision;
}
```

**使用:**
```bash
node auto.js -p web --goal "登录" --interactive

[Step 1] LLM suggests:
  fill @e3 user@example.com
  Reason: Fill email field

Continue? [y/n/s(kip)/e(dit)]: y

[Step 2] LLM suggests:
  fill @e5 wrong-password
  Reason: Fill password

Continue? [y/n/s(kip)/e(dit)]: e
Action: fill
Ref: @e5
Text: correct-password

✅ Edited and executed
```

---

## 实施计划

### Week 1: 核心稳定性 (P0)

**Day 1-2:**
- [ ] 实现多层解析器（JSONParser + TextParser + Chain）
- [ ] 测试 20+ 种 LLM 输出格式
- [ ] 集成到 auto.js

**Day 3:**
- [ ] 实现流式日志（StreamReporter）
- [ ] 添加 phase/decision/result 输出
- [ ] 添加 --verbose 模式

**预期:** 解析成功率 95%，用户体验显著提升

---

### Week 2: 可靠性 (P1)

**Day 1-2:**
- [ ] 实现 retry 机制
- [ ] 区分可重试/不可重试错误
- [ ] 指数退避策略

**Day 3-4:**
- [ ] 实现 SnapshotCache
- [ ] 相似度计算（Jaccard）
- [ ] 智能决策是否发送

**预期:** 成功率 85%，Token -30%

---

### Week 3: 高级特性 (P2)

**Day 1-2:**
- [ ] 实现交互模式
- [ ] 支持 y/n/skip/edit
- [ ] 添加 --interactive 参数

**Day 3:**
- [ ] 文档更新
- [ ] 示例补充
- [ ] 发布 v0.2.0

---

## 成功指标

| 指标 | 当前 | 目标 | 测量方法 |
|------|------|------|----------|
| 解析成功率 | 70% | 95% | 100 次测试 |
| 任务完成率 | 60% | 85% | 20 个真实任务 |
| 平均步数 | 5.2 | 4.0 | 缓存优化 |
| Token 消耗 | 100% | 70% | 相同任务对比 |
| 用户满意度 | N/A | 4.5/5 | 问卷调查 |

---

## 风险与缓解

**风险 1: 解析器过于复杂**
- 缓解: 单元测试覆盖 95%+

**风险 2: 缓存误判**
- 缓解: 相似度阈值可配置，默认保守（0.95）

**风险 3: 交互模式打断流程**
- 缓解: 默认关闭，仅在 --interactive 时启用

---

## 下一步

1. **立即开始:** 实现多层解析器（最高优先级）
2. **本周完成:** P0 问题（解析 + 反馈）
3. **下周开始:** P1 问题（重试 + 缓存）

要现在开始实施吗？
