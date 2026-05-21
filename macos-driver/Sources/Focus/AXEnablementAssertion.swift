// AXEnablementAssertion.swift
// 打开 Chromium/Electron app 的 web accessibility tree。
//
// 原理：
// - Chromium-family apps (Slack, Discord, VSCode, Chrome, Edge, Electron shells)
//   默认关闭 web AX tree 省电
// - 写 AXManualAccessibility 或 AXEnhancedUserInterface 为 true 时会触发它们
//   构建完整 AX tree
// - 直接 AXUIElementSetAttributeValue 在 macOS 26 下对 Electron 不生效
//   （Chromium 只信任 System Events 等系统级 AT client 发来的请求）
// - 所以 fallback 到 NSAppleScript 走 System Events 路径，实测 100% 生效
// - 原生 Cocoa app 写这俩属性会失败（.actionUnsupported），无害但浪费
// - 对每个 pid 做 idempotent 缓存：写过一次成功就不再写
//
// Reference: Cua FocusGuard / AXEnablementAssertion

import ApplicationServices
import AppKit
import Foundation

public final class AXEnablementAssertion {
    private var assertedPids: Set<pid_t> = []
    private var nonAssertablePids: Set<pid_t> = []
    private let lock = NSLock()

    public static let shared = AXEnablementAssertion()

    private init() {}

    /// 对 pid 的 app 打开 AX tree。优先直接写属性，失败则走 System Events AppleScript。
    /// 返回 true 表示至少有一条路径成功（或之前已经确认成功）。
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

        // Path 1: Direct AXUIElementSetAttributeValue（旧 macOS / 旧 Chromium 有效）
        let app = AXUIElementCreateApplication(pid)
        let manualOk = writeBool(app, "AXManualAccessibility", true)
        let enhancedOk = writeBool(app, "AXEnhancedUserInterface", true)

        if manualOk || enhancedOk {
            lock.lock()
            assertedPids.insert(pid)
            lock.unlock()
            return true
        }

        // Path 2: System Events AppleScript（macOS 26 + Electron 必须走这条路）
        // Chromium 只信任 System Events 作为 AT client 发来的 AXManualAccessibility 写入
        let processName = processNameForPid(pid)
        if let name = processName {
            let scriptOk = assertViaSystemEvents(processName: name)
            lock.lock()
            if scriptOk {
                assertedPids.insert(pid)
            } else {
                nonAssertablePids.insert(pid)
            }
            lock.unlock()
            return scriptOk
        }

        lock.lock()
        nonAssertablePids.insert(pid)
        lock.unlock()
        return false
    }

    /// 已确认为非 Chromium 的 pid（所有路径都失败过）
    public func isKnownNonAssertable(pid: pid_t) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return nonAssertablePids.contains(pid)
    }

    /// 检查 pid 是否已经成功 assert 过（用于跳过首次延迟）
    public func isAlreadyAsserted(pid: pid_t) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return assertedPids.contains(pid)
    }

    /// 清除缓存（进程重启后 pid 可能复用）
    public func invalidate(pid: pid_t) {
        lock.lock()
        assertedPids.remove(pid)
        nonAssertablePids.remove(pid)
        lock.unlock()
    }

    // MARK: - Private

    private func writeBool(_ element: AXUIElement, _ attribute: String, _ value: Bool) -> Bool {
        let err = AXUIElementSetAttributeValue(
            element,
            attribute as CFString,
            (value ? kCFBooleanTrue : kCFBooleanFalse) as CFTypeRef
        )
        return err == .success
    }

    private func processNameForPid(_ pid: pid_t) -> String? {
        NSRunningApplication(processIdentifier: pid)?.localizedName
    }

    /// 通过 System Events 设置 AXManualAccessibility。
    /// System Events 是 macOS 系统级 AT 服务，Chromium 信任它发来的属性写入。
    private func assertViaSystemEvents(processName: String) -> Bool {
        // 转义进程名中的引号
        let escaped = processName.replacingOccurrences(of: "\"", with: "\\\"")
        let source = """
        tell application "System Events"
          tell process "\(escaped)"
            set value of attribute "AXManualAccessibility" to true
          end tell
        end tell
        """
        guard let script = NSAppleScript(source: source) else { return false }
        var error: NSDictionary?
        script.executeAndReturnError(&error)
        return error == nil
    }
}
