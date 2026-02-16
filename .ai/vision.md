# Vision — Agent Control

> AI 生产流程的"手"。让 AI 能看、能操作任何平台的应用。

## 一句话

一套协议，多个 driver。AI 用同一套 `snapshot / click / drag / fill` 操作 Web、macOS、iOS 应用，不需要知道底层是 Playwright 还是 Accessibility API。

## 为什么做

- 开发方法论里 DBB（体验审查）需要 AI 能操作应用、截图、验证
- 现在每个项目单独搞操作方案，碎片化
- 市面上没有轻量的、AI-first 的跨平台操作层
- 我们的项目覆盖三个平台（Web/macOS/iOS），刚好需要

## 不做什么

- 不做 Appium 那样的重型测试框架
- 不做 GUI 录制回放工具
- 不做通用 RPA
- 只服务 AI agent，不考虑人类手动使用

## 成功标准

AI 能用同一套命令，对 BrainDown（macOS）跑一轮 DBB 体验审查，输出截图 + 报告。
