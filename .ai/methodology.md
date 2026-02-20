# Methodology — agent-control

## 架构

```
Agent (任意 LLM)
  ↓ CLI / JSON
agent-control
  ├── cli.js          ← 统一入口，路由到 driver
  ├── snapshot-enhance.js ← 过滤交互元素 + 语义摘要
  ├── goal-runner.js  ← goal-based: observe → decide → act 循环
  ├── dsl-runner.js   ← script-based: JSON flow 声明式执行
  ├── run-record.js   ← 执行记录 + artifact 收集
  ├── run-all.js      ← 多平台串行回归
  └── drivers/
      ├── web-driver/     (Playwright, HTTP daemon :3901)
      ├── macos-driver/   (Swift, Accessibility API)
      ├── ios-driver/     (idb + simctl)
      └── android-driver/ (adb + uiautomator)
```

## 技术决策

| 决策 | 选择 | WHY |
|------|------|-----|
| 语言 | Node.js (driver层) + Swift (macOS) | Node 跨平台快，macOS AX 必须 Swift |
| Web 方案 | Playwright daemon | 常驻进程避免每次启动浏览器的 3s 开销 |
| iOS 方案 | idb 原生命令 | 比 macOS AX 操作 Simulator 更稳定直接 |
| Android | uiautomator dump | 唯一免 root 方案，但慢 (~4s) |
| ref 系统 | @e{N} 语义引用 | agent 不需要知道坐标，用语义标签操作 |
| 增强快照 | -e flag 过滤 | 原始 snapshot 太多噪音，LLM 需要精简输入 |

## 两条路径

1. **Script-based (dsl-runner)** — JSON 定义步骤，确定性执行，适合回归测试
2. **Goal-based (goal-runner)** — agent 看状态决策下一步，适合探索性任务

当前重心从 script-based 转向 goal-based。

## 代码规范

- 单文件 ≤ 400 行（goal-runner 已 336，接近上限）
- 无 TypeScript（轻量 CLI 工具，JS 够用）
- driver 之间零耦合，通过 cli.js 统一路由
- 所有 driver 输出 JSON，enhance 层统一后处理
