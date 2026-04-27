// SystemFocusStealPreventer.swift
// 监听 NSWorkspace 的 app 激活通知，发现 target app 自己 activate 时零延迟反弹。
//
// 场景：
// - AppKit 的 NSWorkspace.OpenConfiguration.activates=false 被 LaunchServices 尊重
// - 但 app 启动后自己调 NSApp.activate(ignoringOtherApps:) 会绕过 LaunchServices
// - Calculator、Electron shells、很多 AppKit app 都这么干
//
// 方案：
// 1. 订阅 NSWorkspace.didActivateApplicationNotification
// 2. 若新 active app 的 pid 匹配 suppression，立刻把它 demote 回去
// 3. delay=0：activation 通知是异步的，demote 同步执行
//    → WindowServer 下一帧合成前反弹完成，用户看不到闪烁
//
// Reference: Cua SystemFocusStealPreventer

import AppKit
import Foundation

public struct SuppressionHandle: Hashable {
    fileprivate let id: UUID
    fileprivate init() { self.id = UUID() }
}

public final class SystemFocusStealPreventer {
    public static let shared = SystemFocusStealPreventer()

    private let lock = NSLock()
    private var suppressions: [SuppressionHandle: (targetPid: pid_t, restoreTo: NSRunningApplication)] = [:]
    private var observer: NSObjectProtocol?

    private init() {}

    /// 开始抑制：target pid 自激活时立刻 demote 并 activate restoreTo
    @discardableResult
    public func beginSuppression(
        targetPid: pid_t,
        restoreTo: NSRunningApplication
    ) -> SuppressionHandle {
        let handle = SuppressionHandle()
        lock.lock()
        let wasEmpty = suppressions.isEmpty
        suppressions[handle] = (targetPid, restoreTo)
        lock.unlock()

        if wasEmpty {
            installObserver()
        }
        return handle
    }

    /// 停止抑制
    public func endSuppression(_ handle: SuppressionHandle) {
        lock.lock()
        suppressions.removeValue(forKey: handle)
        let nowEmpty = suppressions.isEmpty
        lock.unlock()

        if nowEmpty {
            removeObserver()
        }
    }

    private func installObserver() {
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: nil
        ) { [weak self] note in
            self?.handleActivation(note)
        }
    }

    private func removeObserver() {
        if let observer {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            self.observer = nil
        }
    }

    private func handleActivation(_ note: Notification) {
        guard let activatedApp = note.userInfo?[NSWorkspace.applicationUserInfoKey]
                as? NSRunningApplication else { return }
        let activatedPid = activatedApp.processIdentifier

        lock.lock()
        let matchingRestores = suppressions.values
            .filter { $0.targetPid == activatedPid }
            .map { $0.restoreTo }
        lock.unlock()

        guard !matchingRestores.isEmpty else { return }

        // 零延迟同步 demote：activation 通知是异步的（app 已经在前台了），
        // 我们同步 activate restoreTo 能在 WindowServer 下一帧合成前完成
        // 用户看不到 flash
        for restoreTo in matchingRestores {
            restoreTo.activate(options: [])
        }
    }
}
