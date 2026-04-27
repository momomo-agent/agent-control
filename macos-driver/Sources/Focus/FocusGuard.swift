// FocusGuard.swift
// 三层 focus 栈统一入口。在 AX action 外面包一层，让后台 app 不抢前台、不抢 focus。
//
// 使用：
//   let result = FocusGuard.withFocusSuppressed(pid: pid, window: win, element: el) {
//       AXUIElementPerformAction(el, kAXPressAction as CFString)
//   }
//
// 三层栈：
// 1. AXEnablementAssertion — 对 Chromium/Electron 打开 web AX tree
// 2. SyntheticAppFocusEnforcer — 临时写 AXFocused/AXMain 骗 AppKit
// 3. SystemFocusStealPreventer — 监听激活通知，app 自激活时反弹
//
// Reference: Cua FocusGuard

import AppKit
import ApplicationServices
import Foundation

public enum FocusGuard {
    /// 在 focus 抑制保护下执行 action。
    ///
    /// - Parameters:
    ///   - pid: 目标 app pid
    ///   - window: 目标窗口 AX element（可为 nil）
    ///   - element: 目标 UI 元素 AX element（可为 nil）
    ///   - enableSystemPreventer: 是否启动 NSWorkspace 监听反弹（默认 true）
    ///   - action: 要保护执行的闭包
    @discardableResult
    public static func withFocusSuppressed<T>(
        pid: pid_t,
        window: AXUIElement? = nil,
        element: AXUIElement? = nil,
        enableSystemPreventer: Bool = true,
        action: () throws -> T
    ) rethrows -> T {
        // Layer 1: Chromium/Electron AX tree enablement (idempotent per pid)
        _ = AXEnablementAssertion.shared.assert(pid: pid)

        // Layer 3: 准备 system activation reverter（先注册好再跑 action）
        var handle: SuppressionHandle?
        if enableSystemPreventer {
            let restoreTo = NSWorkspace.shared.frontmostApplication ?? NSRunningApplication.current
            handle = SystemFocusStealPreventer.shared.beginSuppression(
                targetPid: pid, restoreTo: restoreTo
            )
        }
        defer {
            if let h = handle {
                SystemFocusStealPreventer.shared.endSuppression(h)
            }
        }

        // Layer 2: 在 action 前后写/恢复 AXFocused+AXMain
        let state = SyntheticAppFocusEnforcer.shared.preventActivation(
            pid: pid, window: window, element: element
        )
        defer { SyntheticAppFocusEnforcer.shared.reenableActivation(state) }

        return try action()
    }
}
