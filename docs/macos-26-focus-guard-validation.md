# FocusGuard on macOS 26 — Empirical Validation (2026-04-28)

**环境**: macOS 26.3 / Chrome 147.0.7727.116 / Cursor (Electron) / Paw (Electron) / TextEdit (native Cocoa)

**结论**: Cua 三层 focus 栈在 macOS 26 上**Layer 1 和 Layer 2 均已失效**，但**系统默认行为已经不抢前台了**，FocusGuard 成了 redundant 的"保险带"——无害，但也不做额外的事。

---

## 实测矩阵

### Layer 1: `AXEnablementAssertion` (打开 Chromium/Electron web AX tree)

写入 `AXManualAccessibility` + `AXEnhancedUserInterface` 的 AXError：

| App | AXManualAccessibility | AXEnhancedUserInterface | 效果 |
|-----|----------------------|------------------------|------|
| Chrome 147 | `-25205` attributeUnsupported | `-25208` notImplemented | ❌ 属性都废了 |
| Paw (Electron) | `.success` | `-25208` notImplemented | ⚠️ manual 写入成功但 web AX tree 仍未暴露 |
| Cursor (Electron) | `.success` | `-25208` notImplemented | ⚠️ 同上 |
| TextEdit (native) | `-25205` attributeUnsupported | `-25208` notImplemented | ❌ 正常非 Chromium |
| Finder | `-25205` attributeUnsupported | `-25208` notImplemented | ❌ 正常非 Chromium |

**关键发现**：
- `AXEnhancedUserInterface` 在 macOS 26 对**所有 app** 返回 `.notImplemented (-25208)` —— 这个属性在新 OS 上整体失效。
- Chrome 147 移除了 `AXManualAccessibility`（属性不再存在）。
- Electron app 的 `AXManualAccessibility` 写入虽然成功，但**没有让 web content 出现在 AX tree 里**（snapshot 结果 before/after 一致）。

### Layer 2: `SyntheticAppFocusEnforcer` (写 AXFocused/AXMain swap)

TextEdit 在后台，读写 window 的 AXFocused：

```
BEFORE swap:  AXFocused=false, AXMain=false
write AXFocused=true err=0  AXMain=true err=0    ← API 返回成功
AFTER swap:   AXFocused=false, AXMain=false       ← 但值没变！
frontmost:    RemoteClaw
```

**AXError=0 说明"写入"成功**，但**读回来还是 false**——macOS 26 AppKit 静默 drop 了通过 AX 修改 focus 状态的尝试。

### Layer 3: `SystemFocusStealPreventer` (监听 activation 反弹)

代码路径上跑了，但因为 **macOS 26 默认 AX action 已经不抢前台**（下面实验证实），Layer 3 也没什么可反弹的。

### 系统默认行为：macOS 26 的 AX action 已经不抢前台

对后台 TextEdit 跑 `fill @e1 "..."`（该方法内部调 `kAXRaiseAction` + `kAXFocused=true` + `kAXValueAttribute=text`）：

| 情况 | 前台变化 | 内容写入 |
|------|---------|---------|
| **无** `--focus-guard` | RemoteClaw → RemoteClaw（不变） | ✅ TextEdit buffer 显示更新 |
| **有** `--focus-guard` | RemoteClaw → RemoteClaw（不变） | ✅ 同上 |

**kAXRaiseAction 在 macOS 26 对非前台 app 不再自动 raise**——这是 OS 层面的新行为，不是 FocusGuard 的功劳。

---

## 对代码的影响

1. **FocusGuard 保留**——在老 macOS（13-15）上仍然需要，也可能对某些特殊 app 仍有作用（未全面测试）。
2. **`--focus-guard` flag 保留语义**——用户明确表达"后台操作意图"的信号。未来如果 OS 又变回抢前台的行为（或 Apple 出新 API），我们的路径已经准备好。
3. **Layer 1 不要短路 Layer 2/3**——`AXEnablementAssertion.assert()` 返回 false 时，上层 `FocusGuard.withFocusSuppressed` **必须继续执行**（当前代码已经是这样）。
4. **`ax-enable` 诊断子命令保留**——是发现这些 macOS 26 变化的关键工具。

---

## 与 Cua 源码对比

Cua 源码注释写 "macOS 15 Cua 验证"——没针对 macOS 26 做适配。我们是 Cua 的 macOS 26 首批"受害者"。这些发现值得回馈 Cua 社区。

**建议**（给 Cua）：
- `AXEnablementAssertion` 的 `.notImplemented` 和 `.illegalArgument` 不应该被当作失败 —— 当成"已经启用/无需启用"更合理。
- macOS 26 上整个 FocusGuard 的必要性需要重新评估。
- Layer 2 的写入"成功"但值没变的陷阱值得记录。

---

## TL;DR

**现状**: macOS 26 已经在系统层面改了游戏规则，AX actions 默认不抢前台了。FocusGuard 三层栈的机制在 macOS 26 上大部分失效，但**恰好**因为系统默认行为变了，失效也没导致观察到的问题。

**代码**: 保留，不改默认逻辑。`--focus-guard` 作为声明性 flag 标记"用户要求后台操作"——macOS 26 上 OS 免费提供，旧版 macOS 上 FocusGuard 保底。
