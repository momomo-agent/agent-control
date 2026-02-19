# Methodology — Agent Control

## 架构

```
┌─────────────────────────────────┐
│         统一协议层 (CLI)          │
│  snapshot / click / fill / drag  │
│  rightclick / scroll / screenshot│
└──────────┬──────────────────────┘
           │
     ┌─────┴─────┐
     │  Driver    │
     │  Router    │
     └─────┬─────┘
           │
    ┌──────┼──────────┐
    │      │          │
    v      v          v
┌──────┐┌──────┐┌──────────┐┌─────────┐
│ Web  ││macOS ││   iOS    ││ Android │
│Playw.││ AX   ││ Sim AX   ││adb+uia. │
└──────┘└──────┘└──────────┘└─────────┘
```

## 统一协议

所有 driver 必须实现这些命令：

| 命令 | 说明 |
|------|------|
| `snapshot` | 返回可交互元素列表，每个元素有 @ref |
| `click @ref` | 点击 |
| `dblclick @ref` | 双击 |
| `rightclick @ref` | 右键 / 长按 |
| `fill @ref "text"` | 清空并输入 |
| `type @ref "text"` | 追加输入 |
| `press Key` | 按键 |
| `hover @ref` | 悬停 |
| `drag @ref1 @ref2` | 拖拽（ref 到 ref） |
| `drag @ref dx,dy` | 拖拽（ref + 偏移） |
| `scroll @ref down 200` | 滚动 |
| `screenshot` | 全屏截图 |
| `screenshot @ref` | 元素截图 |

## Ref 系统

- 每次 snapshot 生成临时 ref（@e1, @e2...）
- ref 包含：标签、角色、值、位置
- 操作后 ref 可能失效，需要重新 snapshot

## MVP 路线

### Phase 0: macOS Driver（先打通一条链路）
- Swift CLI，通过 Accessibility API 操作
- 目标：能对 BrainDown 跑 snapshot + click + fill + screenshot
- 输出：JSON 格式的元素列表

### Phase 1: 协议层 + Web Driver
- Node CLI 作为统一入口
- Web driver 包装 Playwright（复用 agent-browser 思路）
- `agent-control --platform web snapshot`
- `agent-control --platform macos click @e1`

### Phase 2: iOS Driver
- macOS AX API 操作 Simulator 进程（idb tap 在 iOS 26 失效）
- 模拟器 only

### Phase 2.5: Android Driver (Experimental)
- adb + uiautomator dump，坐标点击
- emulator 或真机，snapshot ~4s（uiautomator 瓶颈）

### Phase 3: DBB 集成
- 与开发方法论的 DBB 流程打通
- scenario → 自动执行 → 截图 → 审查 → report

## 技术选型

- macOS driver: Swift CLI（直接调 AX API，零依赖）
- Web driver: Node + Playwright
- iOS driver: macOS AX API 操作 Simulator 进程（idb tap 在 iOS 26 不可用）
- Android driver: Node + adb + uiautomator dump（Experimental，snapshot ~4s）
- 协议层: Node CLI（路由到各 driver）
- 通信: stdout JSON（简单、可管道）
