# Driver Interface 设计文档

## 背景

agent-control 五个 driver（web/electron/macOS/iOS/android）各自实现，无统一抽象。
导致：ref 格式不一致、Element schema 不统一、interactiveRoles 各写各的、错误返回格式不同。

本文档基于现有代码的完整审计，定义统一的 Driver Interface，作为重构的 spec。

---

## 1. 统一 Element Schema

所有 driver 的 snapshot 必须返回相同结构的元素：

```ts
interface Element {
  ref: string           // "e1", "e2"... 不带 @（@ 是 CLI 层的用户输入前缀）
  role: string          // 语义角色，不带平台前缀（Button 不是 AXButton）
  label: string         // 主要可读文本（aria-label / AXLabel / text / content-desc）
  value?: string        // 当前值（输入框内容、开关状态等）
  frame: {              // 屏幕坐标
    x: number
    y: number
    w: number
    h: number
  }
  interactive: boolean  // 是否可交互

  // 可选扩展字段（driver 按能力提供，不强制）
  tag?: string          // HTML tag（web/electron）
  name?: string         // form name（web）
  placeholder?: string  // placeholder（web）
  type?: string         // input type（web）/ element type
  href?: string         // 链接地址（web）
  disabled?: boolean
  checked?: boolean
  selected?: boolean
  scrollable?: boolean  // android
  children?: Element[]  // macOS 树结构
}
```

### 当前差异与对齐方案

| 问题 | 现状 | 对齐 |
|------|------|------|
| ref 格式 | 各平台不一致 | 统一返回 `@e1`（对齐 agent-browser 约定），findElement 兼容接受 `@e3` 和 `e3` |
| role 前缀 | macOS 返回去掉 AX 的 role，iOS 保留 AX 前缀 | 统一去掉 AX 前缀 |
| 文本字段 | web 用 label，android 用 text，iOS 用 AXLabel | 统一用 label 字段 |
| 交互标记 | android 用 clickable，其他用 interactive | 统一用 interactive |
| 坐标 | android 用 bounds 字符串 "[x1,y1][x2,y2]" | 统一用 frame {x,y,w,h} |
| electron 无坐标 | 普通 snapshot 不返回坐标 | 必须返回 getBoundingClientRect |

---

## 2. Driver Interface

```ts
interface Driver {
  /** 平台标识 */
  readonly platform: 'web' | 'electron' | 'macos' | 'ios' | 'android'

  // ── 生命周期 ──
  start(opts?: StartOpts): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean

  // ── 感知（必须实现）──
  snapshot(opts?: SnapshotOpts): Promise<Element[]>
  screenshot(path: string, opts?: ScreenshotOpts): Promise<Result>

  // ── 操作（必须实现）──
  click(target: Target, opts?: ClickOpts): Promise<Result>
  fill(target: Target, text: string): Promise<Result>
  press(key: string, opts?: PressOpts): Promise<Result>

  // ── 操作（按平台能力实现，不支持则返回 { ok: false, error: 'not supported' }）──
  dblclick?(target: Target): Promise<Result>
  rightclick?(target: Target): Promise<Result>
  longpress?(target: Target, opts?: LongpressOpts): Promise<Result>
  scroll?(direction: Direction, opts?: ScrollOpts): Promise<Result>
  drag?(from: Target, to: Target, opts?: DragOpts): Promise<Result>
  swipe?(direction: Direction): Promise<Result>
  select?(target: Target, value: string): Promise<Result>
  find?(text: string): Promise<Element[]>

  // ── 导航（按平台能力）──
  open?(urlOrTarget: string): Promise<Result>
  back?(): Promise<Result>
  forward?(): Promise<Result>
  reload?(): Promise<Result>
  close?(): Promise<Result>

  // ── 等待（按平台能力）──
  wait?(condition: WaitCondition): Promise<Result>

  // ── 执行（按平台能力）──
  eval?(expression: string): Promise<Result>
}
```

### 类型定义

```ts
type Target = string | { x: number, y: number }
// string = "@e3" 或 "e3"，driver 内部统一处理 @ 前缀

type Direction = 'up' | 'down' | 'left' | 'right'

interface StartOpts {
  headed?: boolean        // web: 有头模式
  cdp?: string            // web/electron: CDP endpoint
  app?: string            // macOS: app name 或 bundleId
  pid?: number            // macOS: 目标 PID
  serial?: string         // android: device serial
}

interface SnapshotOpts {
  interactive?: boolean   // 只返回可交互元素（对应 -i）
}

interface ScreenshotOpts {
  target?: Target         // 元素截图（web/macOS 支持）
  fullPage?: boolean      // web: 全页截图
}

interface ClickOpts {
  button?: 'left' | 'right'  // 默认 left
}

interface PressOpts {
  modifiers?: string[]    // macOS: ['cmd', 'shift'] 等
}

interface LongpressOpts {
  duration?: number       // 统一用毫秒（ms），默认 1000
}

interface ScrollOpts {
  amount?: number         // 滚动量，默认 300（像素或行，driver 内部转换）
}

interface DragOpts {
  steps?: number          // web: 拖拽步数，默认 10
  duration?: number       // iOS: 拖拽时长 ms
}

interface WaitCondition =
  | { type: 'idle', timeout?: number }
  | { type: 'ref', ref: string, timeout?: number }
  | { type: 'text', text: string, timeout?: number }
  | { type: 'gone', text: string, timeout?: number }
  | { type: 'url', pattern: string, timeout?: number }

interface Result {
  ok: boolean
  action?: string
  error?: string
  [key: string]: any     // 允许额外字段（path, url, value 等）
}
```

---

## 3. InteractiveRoles 统一

所有平台共用一份 interactive 判断逻辑，在 snapshot-enhance.js 中维护。
Driver 返回原始 role，enhance 层统一判断 interactive。

### 统一 interactiveRoles（合并所有平台）

```
Button, TextField, TextArea, CheckBox, RadioButton, ComboBox,
PopUpButton, Slider, Link, Tab, MenuItem, MenuBarItem, MenuButton,
Switch, Stepper, Incrementor, IncrementArrow, DecrementArrow,
DisclosureTriangle, ColorWell, SegmentedControl,
Cell, Row,
// Web HTML tags
button, input, select, textarea, a, option, label,
// Web ARIA roles
textbox, checkbox, radio, combobox, listbox, link, menuitem
```

StaticText 和 Image 从 interactive 列表移除（macOS 当前包含但不应该算交互元素）。
如果 StaticText/Image 确实可点击，由 driver 标记 `interactive: true` 覆盖。

---

## 4. 各平台对齐任务

### Web Driver
- [ ] snapshot 返回 frame（已有 x/y/w/h）✅
- [ ] ref 格式确认是 `e1` ✅
- [ ] longpress duration 单位已是 ms ✅
- [ ] 无需改动，作为参考实现

### Electron Driver
- [ ] snapshot 必须返回 frame（getBoundingClientRect）
- [ ] ref 格式确认是 `e1` ✅
- [ ] 返回统一 JSON Result 格式（当前直接 console.log/exit）
- [ ] 补充 longpress 支持
- [ ] 补充 drag 支持

### macOS Driver
- [ ] ref 格式从 `@e1` 改为 `e1`
- [ ] AXScanner 移除 StaticText/Image 从默认 interactive（改为条件判断）
- [ ] longpress duration 从秒改为毫秒（内部转换）
- [ ] 考虑 daemon 模式（Swift binary 常驻 HTTP server）

### iOS Driver
- [ ] ref 格式从 `@e1` 改为 `e1`
- [ ] role 去掉 AX 前缀（当前 `.replace(/^AX/, '')`）确认 ✅
- [ ] longpress duration 从秒改为毫秒（内部转换）
- [ ] scroll 支持 amount 参数（当前固定 300）
- [ ] 补充 dblclick 支持（两次快速 tap）

### Android Driver
- [ ] ref 格式从 `@e1` 改为 `e1`
- [ ] `clickable` 字段改为 `interactive`
- [ ] `text` 字段映射到 `label`
- [ ] `bounds` 字符串解析为 `frame {x,y,w,h}`
- [ ] longpress duration 单位已是 ms ✅
- [ ] 补充 drag 支持（adb input swipe）

### CLI 层 (cli.js)
- [ ] 统一 @ 前缀处理：用户输入 `@e3`，传给 driver 时去掉 @ 变成 `e3`
- [ ] 路由改为 `driver[command](args)` 模式
- [ ] `--json` / `-e` / `-c` 在 CLI 层处理，driver 只返回原始 Element[]

### snapshot-enhance.js
- [ ] interactiveRoles 合并更新（见第 3 节）
- [ ] 输入统一为 Element[]（标准 schema）
- [ ] 不再需要平台特殊处理（android text→label 等由 driver 完成）

---

## 5. 参数统一规范

| 参数 | 统一规范 | 备注 |
|------|----------|------|
| duration | 毫秒 (ms) | macOS/iOS 内部转换为秒 |
| amount (scroll) | 像素 | macOS 内部转换为行数 |
| timeout | 毫秒 (ms) | |
| ref | `@e1` 格式（对齐 agent-browser） | CLI 层补 @ 前缀，driver 内部兼容 @e3 和 e3 |
| screenshot 默认路径 | `/tmp/agent-control-<platform>.png` | |
| open 参数 | URL（web/iOS）或 package（android） | 语义不同，保留差异 |

---

## 6. 错误处理统一

所有 driver 的所有命令必须返回 `Result` 格式：

```json
{ "ok": true, "action": "click", "ref": "e3" }
{ "ok": false, "error": "element e3 not found" }
{ "ok": false, "error": "not supported" }
```

不支持的命令返回 `{ ok: false, error: "not supported" }`，不是 throw 或 exit(1)。

---

## 7. Daemon 模式统一（中期）

当前只有 web driver 是 daemon 模式（HTTP :3901）。

目标：所有 driver 统一 daemon 模式。

| 平台 | 当前 | 目标 |
|------|------|------|
| web | HTTP daemon :3901 | 保持 |
| electron | 每次连 CDP | daemon 模式，保持 CDP 连接 |
| macOS | 每次 spawn Swift binary | daemon 模式（Swift HTTP server 或 Node wrapper） |
| iOS | 每次 spawn | daemon 模式 |
| android | 每次 spawn | daemon 模式 |

daemon 统一端口分配：
- web: 3901
- electron: 3902
- macOS: 3903
- iOS: 3904
- android: 3905
