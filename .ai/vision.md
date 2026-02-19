# Vision — Agent Control

> AI agent 的眼睛和手。看一步，决策一步，做一步。

## 一句话

跨平台 UI 操作层。AI agent 通过统一协议操作 Web/macOS/iOS 应用，每一步都能看到 UI 状态、做出决策、验证结果。

## 核心竞争力

**Goal-based observe→decide→act 循环。**

不是录制回放，不是预定义脚本。agent 看到当前 UI 状态后自己决定下一步：

1. **看** — snapshot 拿到当前可交互元素
2. **想** — 基于目标判断下一步操作
3. **做** — click/fill/select 执行操作
4. **验** — before/after diff 确认操作效果
5. **循环** — 直到目标达成

这是 agent-control 区别于 Selenium/Playwright/Appium 的根本差异。那些是自动化测试工具，agent-control 是 **agent 的感知-行动接口**。

## 两层架构

```
Goal Runner（核心）— 看→想→做→验 循环，agent 自主决策
    ↓
DSL Runner（保障）— 已知好路径固化为 JSON，回归验证 driver 没退化
    ↓
Driver 层 — Web(Playwright) / macOS(AX API) / iOS(Simulator AX)
```

## 不做什么

- 不做重型测试框架
- 不做 GUI 录制回放
- 不做通用 RPA
- 只服务 AI agent

## 成功标准

给 agent 一个自然语言目标，它能在三个平台上自主完成任务并产出可验证的执行报告。
