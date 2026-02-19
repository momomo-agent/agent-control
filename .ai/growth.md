# Growth Log — Agent Control

## Round 0 — 项目启动 (2026-02-16)

- 创建 .ai/ 目录：vision.md, methodology.md, taste.md, features.json
- 确定 MVP 路线：macOS driver 先行
- 11 个 feature，Phase 0 聚焦 F001-F005（snapshot/click/fill/screenshot）
- 下一步：开始写 macOS driver Swift CLI

## Round 1 — 三平台 Driver 打通 (2026-02-18)

### macOS Driver
- Swift CLI 通过 AX API 操作任意 app
- `snapshot --pid` 返回元素列表，`click @ref` / `fill @ref` / `screenshot`
- 验证：TextEdit CRUD 9/9 全过

### Web Driver
- Playwright daemon 模式（端口 3901），HTTP 通信避免 SIGKILL
- 支持 open/snapshot/click/fill/select/screenshot
- 验证：FlowLab signup 16/16 全过
- FlowLab（`flowlab/`）作为 Web 测试靶场

### iOS Driver
- **关键突破**：`idb ui tap` 在 iOS 26 Simulator 上完全不工作
- **解决方案**：用 macOS AX API 直接操作 Simulator 进程的 accessibility tree
- `osascript activate` 激活 Simulator 窗口（`open -a` 在子进程中不可靠）
- `App-prefs:root` 强制 Settings 回到主页（terminate+launch 会恢复上次页面状态）
- 验证：Settings nav 8/8 全过

## Round 2 — 工程基础设施 (2026-02-18)

### F1 Run Record
- `run-record.js` — 每次执行产出 `runs/<runId>/record.json` + `artifacts/`
- 记录每步状态、耗时、失败原因、截图

### F2 Retry/Resume
- `withRetry()` 包装函数，按 failureTag 分策略重试
- NOT_READY 2次/1s，NOT_FOUND 1次/500ms，TIMEOUT 2次/2s
- `--resume <runId>` 从失败的 run 恢复

### F3 Doctor
- `doctor.js` — 环境检查（Node/Playwright/Swift/Simulator/cliclick）

### F4 Flow DSL
- JSON 声明式 flow 定义（`flows/*.json`）
- `dsl-runner.js` 解释器，支持 open/snapshot/click/fill/select/verify/wait
- 三平台 golden flow 全部迁移到 JSON

### F5 run-all + Viewer 增强
- `run-all.js` — 一个命令跑三平台（Web→iOS→macOS 串行避免焦点冲突）
- `viewer.js` — 生成 `runs/index.html`，暗色主题，点击行展开 step 详情
- 平台色：Web 蓝 `#60a5fa`、macOS 粉 `#f472b6`、iOS 黄 `#fbbf24`

## Round 3 — 品味打磨 (2026-02-18)

### Snapshot 增强
- `snapshot-enhance.js` 统一增强层，`-e` flag 过滤非交互元素 + 语义摘要
- Web role 优化：`button[submit] "Log out"` 替代裸 `submit`
- iOS 自动过滤 Simulator chrome（Action/Volume/Home/Save Screen/Rotate）

### 操作可靠性
- iOS driver 加 `osascript activate`（每次 snapshot 前激活窗口）
- iOS snapshot 自动 retry（元素 <3 时等 500ms 重试）
- ASSERT_FAIL 改为可重试（解决焦点竞争导致的 verify 失败）
- `--pid` 参数顺序修复（CLI 提取后追加到 command 之后）

### 体验打磨
- Web daemon 自动启动（agent 不需要手动启动）
- macOS driver 缺失时给友好提示
- 空 snapshot / 错误 PID 返回 hint 而非空数组
- help 重写（清晰的 examples/options/commands）
- 冗余文件清理（6 个归档到 `_archive/`，核心 9 个 JS）
- README 重写（30 秒上手体验）
- Skill 文档全面更新

### 稳定性验证
- `node run-all.js` 连跑 3 次，9/9 flows 全过，零 flake
- 累计 90+ runs

## 支持范围 & 已知限制

### 已验证场景
| 平台 | 场景 | 步数 | 稳定性 |
|------|------|------|--------|
| Web | FlowLab signup（表单填写+验证） | 18 | 3/3 连过 |
| macOS | TextEdit CRUD（创建+编辑+保存） | 11 | 3/3 连过 |
| iOS | Settings 导航（进入通用→关于本机） | 14 | 3/3 连过 |
| Android | Settings About（深链接+验证） | 6 | 3/3 连过 [Experimental] |

### 支持范围
- Web: 任意 URL，Playwright headless Chromium
- macOS: 任意 app（需 Accessibility 权限），通过 `--pid` 指定
- iOS: Simulator only（自动检测 booted device）
- Android: Experimental — emulator 或真机（通过 adb），uiautomator dump ~4s

### 已知限制
- iOS 真机未支持（只做了 Simulator）
- Web 强反爬/验证码不保证
- macOS 需要用户手动授予 Accessibility 权限
- 三平台串行执行（焦点互斥，不能并行操作 macOS + iOS）
- macOS driver 需要 `swift build`（无预编译 binary）

### 两层设计
1. **Goal Runner（核心竞争力）** — observe→decide→act 循环，agent 看到 UI 后自己决策下一步
2. **DSL Runner（回归保障）** — 把已知好路径固化成 JSON，验证 driver 没退化

### 关键教训
- `open -a` 在 Node 子进程中不能可靠激活窗口，必须用 `osascript activate`
- iOS Simulator 的 `terminate + launch` 会恢复上次页面状态，用 `openurl App-prefs:root` 强制回主页
- macOS/iOS 都需要窗口焦点，并行执行时必须串行
- Playwright 浏览器也会抢焦点，全部串行最稳定
- Android `uiautomator dump` 写 `/sdcard/` 会 Permission denied，改用 `/proc/self/fd/1` 直接输出到 stdout
- Android 跨进程 ref 查找需要文件级 snapshot cache（`/tmp/agent-control-android-snap.json`）
- iOS flow 的 setup exec 不能塞太多 shell 命令，拆成 dsl-runner 原生步骤更稳定

## Round 4 — Android 四端对外 (2026-02-19)

### Android Driver 从空壳到可用
- `android-driver/index.js` 修复 dump 路径（`/sdcard/` → `/proc/self/fd/1` exec-out 直接输出）
- 跨进程 ref 查找：文件级 snapshot cache，click 从 4s → 0.4s
- `snapshot-enhance.js` 支持 Android（`clickable` + `text` 标签）
- swipe 默认距离 500 → 900，减少滚动次数

### dsl-runner Android 快速路径
- 所有 Android 操作（open/click/swipe/press/screenshot/snapshot/verify）绕过 `node cli.js` 进程 spawn
- 直接调 `adb shell` / `adb exec-out`，单次操作从 3s → 0.4s
- `verifyActivity` 用 `dumpsys window` 验证当前 Activity（轮询等待，最多 6s）
- `shell` action 支持所有平台（Android 走 adb，其他走 execSync）

### iOS 稳定性修复
- setup exec 拆成 dsl-runner 原生步骤（shell + wait），避免一串 shell 被 SIGTERM
- verify 加 retry（snap < 3 元素时等 2s 重试）
- flow 从 8 步扩展到 14 步（含 setup 步骤）

### 四端 run-all 验证
- `node run-all.js` 四端全过：Web 18/18 (5s) · iOS 14/14 (24s) · macOS 11/11 (9s) · Android 6/6 (23s)
- Android 单独连跑 3/3 零 flake

### 对外发布更新
- README: "One CLI, four platforms"，加 Android quickstart + limitations
- 官网 site/index.html: 加 Android badge（lime `#a3e635`）+ arch card（Experimental 标签）
- features.json: F016-F025 Android 基础命令全部验证通过

## Round 5 — iOS 切回 idb (2026-02-19)

### 背景
- 重新测试发现 idb tap 在 iOS 26 Simulator 上正常工作，之前"不工作"是误判（坐标/焦点问题）
- macOS AX hack（focusSim + cliclick + Simulator AX tree）是不必要的复杂度

### 改动
- `ios-driver/index.js` 重写：纯 idb（describe-all/tap/text/swipe/button），去掉所有 macOS AX 代码
- `dsl-runner.js` 清理：删除 iosSnap/iosClick/iosSS/focusSim/simPID/MAC_BIN，iOS 走统一 `ac()` 路径
- `flows/settings-nav.json` 简化：去掉 `open -a Simulator` 步骤，12 步（原 14 步）
- 文件级 snapshot cache（`/tmp/agent-control-ios-snap.json`）避免跨进程 ref 丢失

### 验证
- iOS 单独连跑 3/3 零 flake（32-40s）
- run-all 4/4：Web 18/18 (4.5s) · iOS 12/12 (31s) · macOS 11/11 (9s) · Android 6/6 (22s)

### 教训
- 之前 idb tap "不工作"是误判，应该多测几次再下结论
- macOS AX hack 引入了 focusSim/cliclick 等脆弱依赖，idb 方案更干净
