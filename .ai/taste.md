# Taste — Agent Control

## 参照物

- **agent-browser** — snapshot + ref 的交互模式，简洁的 CLI 接口
- **Accessibility Inspector** (Xcode) — macOS/iOS 元素树的标杆
- **Playwright** — 稳定、快速、API 设计优雅

## 品味标准

### 1. 极简接口
- 命令数量 ≤ 15 个，覆盖 95% 操作场景
- 学习成本 < 5 分钟（AI 看一遍 help 就能用）
- 零配置启动，不需要写 config 文件

### 2. 响应速度
- snapshot < 500ms
- click/fill 等操作 < 200ms
- screenshot < 1s

### 3. 输出可读性
- snapshot 输出人类和 AI 都能一眼看懂
- 错误信息明确，不需要猜

### 4. 稳定性
- UI 改了不影响操作（ref 基于语义不基于坐标）
- 元素找不到时优雅降级，不崩溃

## 反面教材

- Appium — 太重、启动慢、配置复杂
- XCUITest — 只能 iOS、跟 Xcode 绑死
- Selenium — 过时、不稳定、API 啰嗦
