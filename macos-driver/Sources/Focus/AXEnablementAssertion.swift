// AXEnablementAssertion.swift
// 打开 Chromium/Electron app 的 web accessibility tree。
//
// 原理：
// - Chromium-family apps (Slack, Discord, VSCode, Chrome, Edge, Electron shells)
//   默认关闭 web AX tree 省电
// - 写 AXManualAccessibility 或 AXEnhancedUserInterface 为 true 时会触发它们
//   构建完整 AX tree
// - 原生 Cocoa app 写这俩属性会失败（.actionUnsupported），无害但浪费
// - 所以对每个 pid 做 idempotent 缓存：写过一次成功就不再写；两个都失败就记"非 Chromium"
//
// Reference: Cua FocusGuard / AXEnablementAssertion

import ApplicationServices
import Foundation

public final class AXEnablementAssertion {
    private var assertedPids: Set<pid_t> = []
    private var nonAssertablePids: Set<pid_t> = []
    private let lock = NSLock()

    public static let shared = AXEnablementAssertion()

    private init() {}

    /// 对 pid 的 app root element 写 AXManualAccessibility + AXEnhancedUserInterface。
    /// 返回 true 表示至少有一个属性写入成功（或之前已经确认成功）。
    @discardableResult
    public func assert(pid: pid_t) -> Bool {
        lock.lock()
        if assertedPids.contains(pid) {
            lock.unlock()
            return true
        }
        if nonAssertablePids.contains(pid) {
            lock.unlock()
            return false
        }
        lock.unlock()

        let app = AXUIElementCreateApplication(pid)
        // AXError 语义（macOS 26 + Chrome 147 实测发现）：
        //   .success              → 写入成功（旧 Chromium + macOS 15 经典路径）
        //   .illegalArgument      → 属性存在、拒绝新值（已开启）
        //   .notImplemented       → macOS 26 下 AXEnhancedUserInterface 对所有 app 返这个
        //                          （此属性在新 OS 上已事实上失效）
        //   .attributeUnsupported → 原生 Cocoa / 新版 Chromium 移除了该属性
        // 结论：macOS 26 + Chrome 147 组合下 Layer 1 实际上是 no-op，
        // Chrome 自己默认已打开 web AX tree，无需我们 assert。保留逻辑以兼容老版本。
        let manualOk = writeBool(app, "AXManualAccessibility", true)
        let enhancedOk = writeBool(app, "AXEnhancedUserInterface", true)

        lock.lock()
        defer { lock.unlock() }
        if manualOk || enhancedOk {
            assertedPids.insert(pid)
            return true
        } else {
            // macOS 26 下即使 Chromium 也会落到这里，不是 bug——
            // 纯粹代表 “两个属性都写不进去”。
            // 上层 FocusGuard 不会被阻止，Layer 2/3 照跑。
            nonAssertablePids.insert(pid)
            return false
        }
    }

    /// 已确认为非 Chromium 的 pid（两个属性都写失败过）
    public func isKnownNonAssertable(pid: pid_t) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return nonAssertablePids.contains(pid)
    }

    private func writeBool(_ element: AXUIElement, _ attribute: String, _ value: Bool) -> Bool {
        let err = AXUIElementSetAttributeValue(
            element,
            attribute as CFString,
            (value ? kCFBooleanTrue : kCFBooleanFalse) as CFTypeRef
        )
        return err == .success
    }
}
