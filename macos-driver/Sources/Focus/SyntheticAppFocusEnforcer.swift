// SyntheticAppFocusEnforcer.swift
// 在 AX action 之前临时写 AXFocused/AXMain，之后恢复。
//
// 目的：
// - 不调 NSRunningApplication.activate() 和 kAXRaiseAction（它们会抢前台）
// - 通过写 AX 属性骗过 AppKit 状态机，让它以为"我有 focus"
// - action 结束后恢复 prior state，不改变用户可见状态
//
// 使用：
//   let state = enforcer.preventActivation(pid: pid, window: win, element: el)
//   AXUIElementPerformAction(el, kAXPressAction)
//   enforcer.reenableActivation(state)
//
// Reference: Cua SyntheticAppFocusEnforcer

import ApplicationServices
import Foundation

/// 不透明的 focus 状态快照
public struct FocusState {
    fileprivate let pid: pid_t
    fileprivate let window: AXUIElement?
    fileprivate let element: AXUIElement?
    fileprivate let priorWindowFocused: Bool?
    fileprivate let priorWindowMain: Bool?
    fileprivate let priorElementFocused: Bool?
}

public final class SyntheticAppFocusEnforcer {
    public static let shared = SyntheticAppFocusEnforcer()
    private init() {}

    /// action 前：写 AXFocused=true + AXMain=true 到 window 和 element，
    /// 捕获 prior state 以便 action 后恢复。
    public func preventActivation(
        pid: pid_t,
        window: AXUIElement?,
        element: AXUIElement?
    ) -> FocusState {
        let priorWindowFocused = window.flatMap { readBool($0, "AXFocused") }
        let priorWindowMain = window.flatMap { readBool($0, "AXMain") }
        let priorElementFocused = element.flatMap { readBool($0, "AXFocused") }

        if let window {
            _ = writeBool(window, "AXFocused", true)
            _ = writeBool(window, "AXMain", true)
        }
        if let element {
            _ = writeBool(element, "AXFocused", true)
        }

        return FocusState(
            pid: pid,
            window: window,
            element: element,
            priorWindowFocused: priorWindowFocused,
            priorWindowMain: priorWindowMain,
            priorElementFocused: priorElementFocused
        )
    }

    /// action 后：恢复 prior state。
    /// 之前读不到的属性保持当前值（不写假 false 污染状态）
    public func reenableActivation(_ state: FocusState) {
        if let window = state.window {
            if let prior = state.priorWindowFocused {
                _ = writeBool(window, "AXFocused", prior)
            }
            if let prior = state.priorWindowMain {
                _ = writeBool(window, "AXMain", prior)
            }
        }
        if let element = state.element, let prior = state.priorElementFocused {
            _ = writeBool(element, "AXFocused", prior)
        }
    }

    private func readBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(
            element, attribute as CFString, &value
        )
        guard result == .success, let v = value else { return nil }
        if CFGetTypeID(v) == CFBooleanGetTypeID() {
            return CFBooleanGetValue((v as! CFBoolean))
        }
        return nil
    }

    @discardableResult
    private func writeBool(_ element: AXUIElement, _ attribute: String, _ value: Bool) -> Bool {
        let err = AXUIElementSetAttributeValue(
            element,
            attribute as CFString,
            (value ? kCFBooleanTrue : kCFBooleanFalse) as CFTypeRef
        )
        return err == .success
    }
}
