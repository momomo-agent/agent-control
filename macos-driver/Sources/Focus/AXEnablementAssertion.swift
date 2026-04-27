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
        let manualOk = writeBool(app, "AXManualAccessibility", true)
        let enhancedOk = writeBool(app, "AXEnhancedUserInterface", true)

        lock.lock()
        defer { lock.unlock() }
        if manualOk || enhancedOk {
            assertedPids.insert(pid)
            return true
        } else {
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
