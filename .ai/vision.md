# Vision — agent-control

**让 AI agent 像人一样操作任何 GUI。**

## WHY

AI agent 有脑子但没有手。能推理、能规划、能决策，但看不到按钮也点不了。
agent-control 是通用的 GUI 操作协议：看到 → 操作 → 验证，一套接口跑四个平台。

## 核心价值

1. **统一协议** — Web/macOS/iOS/Android，同一套 snapshot + click + fill
2. **语义优先** — ref 优先（accessibility label、text content），坐标兜底
3. **agent 无关** — 不绑定任何 LLM，你带脑子，我给手和眼
4. **goal-based** — 从脚本驱动走向目标驱动：agent 看屏幕状态自主决策下一步

## 不做什么

- 不做 agent（不内置 LLM 决策）
- 不做测试框架（不是 Selenium/Appium 替代品）
- 不做 RPA（不录制回放固定流程）
