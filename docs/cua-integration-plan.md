# agent-control ← Cua 能力整合方案

**背景**：Cua（trycua/cua）是 21339 行 Swift 的成熟 computer-use agent 框架，专注 **后台操作**（agents 操作 app 不抢光标/focus/space）。本文档是 agent-control 吸收 Cua 核心能力的完整计划。

**研究日期**：2026-04-28
**Cua 源码**：`~/LOCAL/momo-agent/studies/cua/libs/cua-driver/Sources/CuaDriverCore/`（96 文件）

---

## Cua 的核心洞察（按重要性排序）

### 1. AX 模拟焦点 > SPI 真焦点（macOS 26 仍可用）⭐️⭐️⭐️

**不需要让 app 真的变 active**。只要在 AX action 前后**临时**写 `AXFocused`/`AXMain`，让 AppKit 状态机以为"我有 focus"就够了。

三层栈（`Focus/FocusGuard.withFocusSuppressed`）：

| Layer | 文件 | 作用 | 依赖 |
|-------|------|------|------|
| 1 | `AXEnablementAssertion.swift` | 对 Chromium/Electron 写 `AXManualAccessibility`+`AXEnhancedUserInterface` 打开 web AX tree | 纯 AX |
| 2 | `SyntheticAppFocusEnforcer.swift` | action **之前** 写 `AXFocused`/`AXMain`，**之后** 恢复 prior state | 纯 AX |
| 3 | `SystemFocusStealPreventer.swift` | 监听 `NSWorkspace.didActivateApplicationNotification`，app 自己 activate 时零延迟反弹 | 公开 AppKit |

**零延迟反弹的魔法**：`suppressionDelayNs = 0`，activation 通知异步，demote 同步——WindowServer 下一帧合成前已经反弹完，用户看不到闪烁。

**优先级**：这是**最实用**的方案，不依赖 SPI，macOS 26 仍可用，先做这个。

### 2. 虚拟光标（不移动真实 cursor）⭐️⭐️⭐️

`Cursor/AgentCursorOverlayWindow.swift` + `AgentCursorRenderer.swift`（1414 行总）

- **透明、穿透点击、不抢 key、borderless NSWindow** 盖在整屏
- 用 `CALayer` + `CAShapeLayer` 画 lavender 渐变箭头 + bloom 光晕
- 光标动画（贝塞尔曲线）用 `CursorMotionPath`/`Bezier.swift`
- **真实 cursor 完全不动**——用户看电影时，agent 在一旁干活，互不干扰

这是"不偷光标"的真相——不是"假装不偷"，是**根本不碰真光标**。

### 3. 后台点击 5-event 配方 ⭐️⭐️

`Input/MouseInput.swift`（复杂，~1000 行）

单次 click 需要 5 个合成事件：
1. `mouseMoved` 到目标（cursor-state primer）
2. `leftMouseDown`/`leftMouseUp` at (-1, -1)（off-screen primer，触发 Chromium user-activation gate）
3-5. 真实 click pair（`clickState` 从 1 升到 N 支持双击，约 80ms 间隔）

每个 event 需要 stamp：
- `CGEventSetWindowLocation(event, windowLocalPt)` — window-local 坐标
- `mouseEventWindowUnderMousePointer` = windowID
- `SLEventSetIntegerValueField(event, 40, pid)` — 私有字段 40 存 pid
- **不带 auth message**（保持 cgAnnotatedSessionEventTap 路径）
- 投递路径：`SLEventPostToPid` (auth=false) → fallback `CGEvent.postToPid`

### 4. 非 AX 表面的兜底矩阵 ⭐️⭐️

`Browser/` 模块（1177 行，6 个文件）

按优先级尝试：

| 方案 | 文件 | 适用 | 要求 |
|------|------|------|------|
| AX tree | `AXPageReader.swift` | Chromium AX tree | `AXManualAccessibility` 已开 |
| AppleScript JS | `BrowserJS.swift` | Chrome / Safari | 用户启用"Allow JavaScript from Apple Events" |
| CDP SIGUSR1 | `ElectronJS.swift` + `CDPClient.swift` | Electron apps (VSCode, Cursor) | `EnableNodeCliInspectArguments` fuse |
| WebKit 环境变量 | `WebKitJS.swift` | WebKit app 启动时带 `WEBKIT_INSPECTOR_SERVER` | 启动时注入 |
| Mach IPC XPC | `WebInspectorXPC.swift`（stub）| WKWebView | 需要 Apple 私有 entitlement |

我们已经在 Paw 用过 CDP + Electron（agent-control `-p electron --port 9223`），可直接参考。

### 5. Keyboard 后台输入（简单） ⭐️

`Input/KeyboardInput.swift`

键盘比鼠标简单：
- `SLEventPostToPid(pid, event)` **带 auth message**（macOS 14+ Chromium 要求）
- fallback `CGEvent.postToPid(pid)`
- 文本注入用 `CGEvent.keyboardSetUnicodeString`（支持组合字符 + emoji）

### 6. SkyLight SPI（macOS 26 部分失效）⚠️

`Input/SkyLightEventPost.swift`

`SLPSPostEventRecordTo` 做 focus-without-raise（yabai 方案）——我已经移植了，**但在 macOS 26 不生效**（ok=true 但 isActive=false）。

建议：优先用 AX 模拟焦点方案（Layer 1-3），SLPS 作为 nice-to-have 的 fallback（老版本 macOS）。

### 7. 其它辅助能力

- **Apps/AppLauncher.swift** — `NSWorkspace.openApplication(at:)` + `activates: false`（后台启动）
- **Capture/WindowCapture.swift** — `SCScreenshotManager` 单窗口截图（已有类似能力）
- **Recording/RecordingSession.swift**（3001 行）— 完整 trajectory 录制 + 视频 + 点击标记
- **Permissions/PermissionsGate.swift** — AX / 屏幕录制 / 输入监控权限集中管理
- **AppState/AppState.swift**（731 行）— agent-driver 进程的状态机

---

## 整合 Roadmap（按优先级）

### Phase 1: AX 模拟焦点（最优先）
实现三层 focus 栈到 `macos-driver`：
- `Sources/FocusGuard.swift` — 入口 `withFocusSuppressed { ... }`
- `Sources/AXEnablementAssertion.swift` — Chromium/Electron 打开 AX tree
- `Sources/SyntheticAppFocusEnforcer.swift` — action 前后 AX 属性 swap
- `Sources/SystemFocusStealPreventer.swift` — NSWorkspace 监听反弹
- CLI: `agent-control -p macos --app X click @e3 --background` → 自动走 FocusGuard

**预期效果**：agent click/type Chrome 时，Chrome 不抢前台，也不抢 focus。

### Phase 2: 虚拟光标
- `Sources/AgentCursorOverlayWindow.swift`
- `Sources/AgentCursorRenderer.swift`（简化版）
- CLI: `agent-control -p macos cursor start/move/click`
- 选项：允许关闭（某些场景需要真光标 feedback）

**预期效果**：agent 工作时屏幕上有个 lavender 箭头飞来飞去，真光标不动。

### Phase 3: 后台点击 5-event（macOS 26 验证）
- `Sources/MouseInput.swift` — 5-event recipe
- `Sources/KeyboardInput.swift` — auth-signed 键盘
- **先验证 macOS 26 上是否仍生效**（SLEventPostToPid 可能跟 SLPSPostEventRecordTo 一起失效）

### Phase 4: Electron/CDP 集成
我们 Paw 已经有 `-p electron`，补齐：
- SIGUSR1 + 端口自动发现（Electron 不预开 port 的情况）
- 对齐 Cua 的 CDPClient 封装

### Phase 5: 录制回放（可选）
- `Sources/RecordingSession.swift` 简化版
- trajectory JSON schema 对齐 Cua（方便互操作）
- `agent-control record start/stop`

---

## 已完成

- ✅ 阅读 Cua 源码（21339 行，96 文件）
- ✅ 移植 FocusWithoutRaise → `BackgroundFocus.swift`（但 macOS 26 失效，保留代码待验证老版本）
- ✅ 修复 `pidForWindow`：deprecated `SLPSGetWindowOwner` → `CGWindowListCopyWindowInfo`
- ✅ 扩展 `printResult` 支持 extra metadata

## 判断

Cua 给我们的最大启示**不是 SPI**，而是 **分层防御**：

> 不要赌单个技术路径，每层都有 fallback。focus 失败？AX 属性凑合。AX 不行？CDP。CDP 不行？AppleScript。全都不行？让用户启用权限。

这对 agent-control 的架构也适用——应该从"一个 driver 一套实现"升级为"一个 driver 多路径 + 自动 fallback + 健康度检测"。

## 版本兼容性

| macOS | FocusGuard (AX) | FocusWithoutRaise (SLPS) | SLEventPostToPid | 备注 |
|-------|----------------|--------------------------|------------------|------|
| 13-14 | ✅ 预期可用 | ✅ 预期可用 | ✅ 预期可用 | 未亲测 |
| 15 Sequoia | ✅ Cua 验证 | ✅ Cua 验证 | ✅ Cua 验证 | Cua 主战场 |
| 26 | ⚠️ 待验证 | ❌ 本机实测 ok=true 但 isActive=false | ⚠️ 待验证 | 优先做 AX 方案 |

---

## 附：代码对照 (Cua path → agent-control 目标 path)

```
cua/libs/cua-driver/Sources/CuaDriverCore/Focus/         → macos-driver/Sources/Focus/
cua/libs/cua-driver/Sources/CuaDriverCore/Input/         → macos-driver/Sources/Input/
cua/libs/cua-driver/Sources/CuaDriverCore/Cursor/        → macos-driver/Sources/Cursor/
cua/libs/cua-driver/Sources/CuaDriverCore/Browser/       → macos-driver/Sources/Browser/ (Phase 4)
cua/libs/cua-driver/Sources/CuaDriverCore/Recording/     → macos-driver/Sources/Recording/ (Phase 5)
```
