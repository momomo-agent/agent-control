# Growth — agent-control

## 2026-02-20 — 方法论初始化

**做了什么：** 建立 `.ai/` 目录，梳理现有代码，定义 vision/methodology/taste/features

**现状评估：**
- 核心代码 ~1970 行，精简够用
- 13 个 feature 已完成（四平台 driver + CLI + 增强快照 + DSL + goal-runner 骨架）
- goal-runner.js 已有 observe/act/act-observe + HTML report，但缺 LLM 集成
- 工程卫生差：无 .gitignore、runs/ 堆积、macos .build/ 未忽略

**下一步：** F015 工程清理 → F014 goal-runner LLM 集成
