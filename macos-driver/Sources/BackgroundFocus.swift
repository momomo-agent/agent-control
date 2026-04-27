// BackgroundFocus.swift
// 后台 focus + 后台事件投递：基于 SkyLight 私有 API
//
// 核心方案（从 Cua 的 FocusWithoutRaise 移植，Cua 从 yabai 移植）：
//
// 1. Focus without Raise：
//    - 用 SLPSPostEventRecordTo 发 248 字节 focus/defocus 事件
//    - 目标 app 变 active（NSRunningApplication.isActive = true），但窗口不 raise
//    - 故意跳过 SLPSSetFrontProcessWithOptions（Cua 验证：调了会破坏 Chrome user-activation gate）
//
// 2. Authenticated Event Post（macOS 14+ 必须）：
//    - 键盘：SLEventPostToPid + SLSEventAuthenticationMessage（Chromium 要求）
//    - 鼠标：SLEventPostToPid 不带 auth（带了会绕过 cgAnnotatedSessionEventTap）
//
// 3. Stealth Deminiaturize：
//    - SLSSetWindowAlpha(0) → deminiaturize → action → minimize → alpha(1)
//    - 用户看不到窗口闪现
//
// Reference: https://github.com/trycua/cua/blob/main/libs/cua-driver/Sources/CuaDriverCore/Input/FocusWithoutRaise.swift

import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ObjectiveC

public enum BackgroundFocus {

    // MARK: - SkyLight SPI 动态解析

    private typealias PostToPidFn = @convention(c) (pid_t, CGEvent) -> Void
    private typealias SetAuthMessageFn = @convention(c) (CGEvent, AnyObject) -> Void
    private typealias SetIntFieldFn = @convention(c) (CGEvent, UInt32, Int64) -> Void
    private typealias SetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void
    private typealias FactoryMsgSendFn = @convention(c) (
        AnyObject, Selector, UnsafeMutableRawPointer, Int32, UInt32
    ) -> AnyObject?
    private typealias PostEventRecordToFn = @convention(c) (
        UnsafeRawPointer, UnsafePointer<UInt8>
    ) -> Int32
    private typealias GetFrontProcessFn = @convention(c) (
        UnsafeMutableRawPointer
    ) -> Int32
    private typealias GetProcessForPIDFn = @convention(c) (
        pid_t, UnsafeMutableRawPointer
    ) -> Int32

    private struct Resolved {
        let postToPid: PostToPidFn
        let setAuthMessage: SetAuthMessageFn
        let msgSendFactory: FactoryMsgSendFn
        let messageClass: AnyClass
        let factorySelector: Selector
    }

    private static let resolved: Resolved? = {
        _ = dlopen(
            "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
            RTLD_LAZY
        )

        func fn<T>(_ name: String, as _: T.Type) -> T? {
            guard let p = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else {
                return nil
            }
            return unsafeBitCast(p, to: T.self)
        }

        guard
            let postToPid = fn("SLEventPostToPid", as: PostToPidFn.self),
            let setAuth = fn("SLEventSetAuthenticationMessage", as: SetAuthMessageFn.self),
            let msgSend = fn("objc_msgSend", as: FactoryMsgSendFn.self),
            let messageClass = NSClassFromString("SLSEventAuthenticationMessage")
        else { return nil }

        return Resolved(
            postToPid: postToPid,
            setAuthMessage: setAuth,
            msgSendFactory: msgSend,
            messageClass: messageClass,
            factorySelector: NSSelectorFromString("messageWithEventRecord:pid:version:")
        )
    }()

    private static let setWindowLocationFn: SetWindowLocationFn? = {
        _ = dlopen(
            "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
            RTLD_LAZY
        )
        guard let p = dlsym(
            UnsafeMutableRawPointer(bitPattern: -2),
            "CGEventSetWindowLocation"
        ) else { return nil }
        return unsafeBitCast(p, to: SetWindowLocationFn.self)
    }()

    private static let postEventRecordToFn: PostEventRecordToFn? = {
        _ = dlopen(
            "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
            RTLD_LAZY
        )
        guard let p = dlsym(
            UnsafeMutableRawPointer(bitPattern: -2),
            "SLPSPostEventRecordTo"
        ) else { return nil }
        return unsafeBitCast(p, to: PostEventRecordToFn.self)
    }()

    private static let getFrontProcessFn: GetFrontProcessFn? = {
        _ = dlopen(
            "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
            RTLD_LAZY
        )
        guard let p = dlsym(
            UnsafeMutableRawPointer(bitPattern: -2),
            "_SLPSGetFrontProcess"
        ) else { return nil }
        return unsafeBitCast(p, to: GetFrontProcessFn.self)
    }()

    private static let getProcessForPIDFn: GetProcessForPIDFn? = {
        guard let p = dlsym(
            UnsafeMutableRawPointer(bitPattern: -2),
            "GetProcessForPID"
        ) else { return nil }
        return unsafeBitCast(p, to: GetProcessForPIDFn.self)
    }()

    private static let setIntFieldFn: SetIntFieldFn? = {
        _ = dlopen(
            "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
            RTLD_LAZY
        )
        guard let p = dlsym(
            UnsafeMutableRawPointer(bitPattern: -2),
            "SLEventSetIntegerValueField"
        ) else { return nil }
        return unsafeBitCast(p, to: SetIntFieldFn.self)
    }()

    /// 完整 auth-signed 事件投递路径可用
    public static var isAuthPostAvailable: Bool { resolved != nil }

    /// Focus without Raise 三个 SPI 都可用
    public static var isFocusWithoutRaiseAvailable: Bool {
        getFrontProcessFn != nil
            && getProcessForPIDFn != nil
            && postEventRecordToFn != nil
    }

    // MARK: - Focus without Raise（从 Cua 移植）

    /// 让 targetPid 变 active 但不 raise 窗口、不触发 Space 切换。
    ///
    /// 248 字节 buffer 布局（yabai 源码 + macOS 15/26 验证）：
    /// - bytes[0x04] = 0xF8  — opcode high
    /// - bytes[0x08] = 0x0D  — opcode low
    /// - bytes[0x3C..0x3F]   — little-endian CGWindowID
    /// - bytes[0x8A]         — 0x01 focus / 0x02 defocus
    /// - 其余 0
    /// 调试信息：活跃时填入错误代码
    public static var lastError: String = ""

    @discardableResult
    public static func activateWithoutRaise(
        targetPid: pid_t, targetWid: CGWindowID
    ) -> Bool {
        lastError = ""
        guard isFocusWithoutRaiseAvailable else {
            lastError = "spi_not_available"
            return false
        }

        var prevPSN = [UInt32](repeating: 0, count: 2)
        var targetPSN = [UInt32](repeating: 0, count: 2)

        let prevCode = prevPSN.withUnsafeMutableBytes { raw -> Int32 in
            getFrontProcessFn?(raw.baseAddress!) ?? -1
        }
        guard prevCode == 0 else {
            lastError = "getFrontProcess=\(prevCode)"
            return false
        }

        let targetCode = targetPSN.withUnsafeMutableBytes { raw -> Int32 in
            getProcessForPIDFn?(targetPid, raw.baseAddress!) ?? -1
        }
        guard targetCode == 0 else {
            lastError = "getProcessForPID=\(targetCode) pid=\(targetPid)"
            return false
        }

        var buf = [UInt8](repeating: 0, count: 0xF8)
        buf[0x04] = 0xF8
        buf[0x08] = 0x0D
        let wid = UInt32(targetWid)
        buf[0x3C] = UInt8(wid & 0xFF)
        buf[0x3D] = UInt8((wid >> 8) & 0xFF)
        buf[0x3E] = UInt8((wid >> 16) & 0xFF)
        buf[0x3F] = UInt8((wid >> 24) & 0xFF)

        // Defocus previous front
        buf[0x8A] = 0x02
        let defocusCode = prevPSN.withUnsafeBytes { psnRaw -> Int32 in
            buf.withUnsafeBufferPointer { bp -> Int32 in
                postEventRecordToFn?(psnRaw.baseAddress!, bp.baseAddress!) ?? -1
            }
        }

        // Focus target
        buf[0x8A] = 0x01
        let focusCode = targetPSN.withUnsafeBytes { psnRaw -> Int32 in
            buf.withUnsafeBufferPointer { bp -> Int32 in
                postEventRecordToFn?(psnRaw.baseAddress!, bp.baseAddress!) ?? -1
            }
        }

        // OSStatus: 0 = success
        if defocusCode != 0 || focusCode != 0 {
            lastError = "defocus=\(defocusCode) focus=\(focusCode)"
            return false
        }
        return true
    }

    /// Defocus targetPid without raising any other window.
    /// Sends only the defocus event (0x02) to the target's PSN.
    @discardableResult
    public static func defocusWithoutRaise(targetPid: pid_t) -> Bool {
        lastError = ""
        guard isFocusWithoutRaiseAvailable else {
            lastError = "spi_not_available"
            return false
        }

        var psn = [UInt32](repeating: 0, count: 2)
        let code = psn.withUnsafeMutableBytes { raw -> Int32 in
            getProcessForPIDFn?(targetPid, raw.baseAddress!) ?? -1
        }
        guard code == 0 else {
            lastError = "getProcessForPID=\(code) pid=\(targetPid)"
            return false
        }

        var buf = [UInt8](repeating: 0, count: 0xF8)
        buf[0x04] = 0xF8
        buf[0x08] = 0x0D
        buf[0x8A] = 0x02  // defocus

        let result = psn.withUnsafeBytes { psnRaw -> Int32 in
            buf.withUnsafeBufferPointer { bp -> Int32 in
                postEventRecordToFn?(psnRaw.baseAddress!, bp.baseAddress!) ?? -1
            }
        }
        if result != 0 {
            lastError = "defocus=\(result)"
            return false
        }
        return true
    }

    // MARK: - Event-record 提取

    /// CGEvent 内嵌的 SLSEventRecord * 指针（SkyLight ObjC 类型编码）
    /// 布局：{CFRuntimeBase=16, uint32_t=4, padding=4, SLSEventRecord*}
    /// → 64-bit 上指针在 offset 24
    private static func extractEventRecord(from event: CGEvent)
        -> UnsafeMutableRawPointer?
    {
        let base = Unmanaged.passUnretained(event).toOpaque()
        for offset in [24, 32, 16] {
            let slot = base.advanced(by: offset)
                .assumingMemoryBound(to: UnsafeMutableRawPointer?.self)
            if let p = slot.pointee { return p }
        }
        return nil
    }

    // MARK: - Authenticated Event Post

    /// 后台投递 CGEvent 到 pid。
    ///
    /// - attachAuthMessage=true（键盘）：附加 SLSEventAuthenticationMessage，
    ///   Chromium 把事件当可信输入（macOS 14+ 必须）
    /// - attachAuthMessage=false（鼠标）：不附加，保留 cgAnnotatedSessionEventTap 路径
    @discardableResult
    public static func postToPid(
        _ pid: pid_t, event: CGEvent, attachAuthMessage: Bool = true
    ) -> Bool {
        guard let r = resolved else { return false }
        if attachAuthMessage {
            if let record = extractEventRecord(from: event),
               let msg = r.msgSendFactory(
                   r.messageClass as AnyObject,
                   r.factorySelector,
                   record,
                   pid,
                   0
               ) {
                r.setAuthMessage(event, msg)
            }
        }
        r.postToPid(pid, event)
        return true
    }

    /// 给事件打上 window-local 坐标。
    /// 后台投递时 WindowServer 用这个坐标做 hit-test，不用 screen space。
    @discardableResult
    public static func setWindowLocation(_ event: CGEvent, point: CGPoint) -> Bool {
        guard let fn = setWindowLocationFn else { return false }
        fn(event, point)
        return true
    }

    // MARK: - Layer 2: Background Input (click / type / press)

    /// Background click at screen coordinates, posted to target pid.
    /// Mouse events use NO auth message (would bypass cgAnnotatedSessionEventTap in Chrome).
    @discardableResult
    public static func bgClick(
        pid: pid_t, windowID: CGWindowID? = nil,
        x: CGFloat, y: CGFloat, button: CGMouseButton = .left
    ) -> Bool {
        let screenPoint = CGPoint(x: x, y: y)
        let windowPoint = CGPoint(x: x, y: y)

        let downType: CGEventType = button == .left ? .leftMouseDown : .rightMouseDown
        let upType: CGEventType = button == .left ? .leftMouseUp : .rightMouseUp

        guard let down = CGEvent(mouseEventSource: nil, mouseType: downType,
                                  mouseCursorPosition: screenPoint, mouseButton: button),
              let up = CGEvent(mouseEventSource: nil, mouseType: upType,
                                mouseCursorPosition: screenPoint, mouseButton: button)
        else { return false }

        // Set window-local coordinates for background hit-test
        setWindowLocation(down, point: windowPoint)
        setWindowLocation(up, point: windowPoint)

        // Mouse: NO auth (keeps cgAnnotatedSessionEventTap path for Chrome)
        postToPid(pid, event: down, attachAuthMessage: false)
        usleep(50_000)
        postToPid(pid, event: up, attachAuthMessage: false)
        return true
    }

    /// Background key press. `key` uses same format as AXActions.press ("cmd+shift+a").
    /// Keyboard events use auth message (Chromium user-activation gate on macOS 14+).
    @discardableResult
    public static func bgPress(pid: pid_t, key: String) -> Bool {
        let parts = key.split(separator: "+").map(String.init)
        guard !parts.isEmpty else { return false }

        var flags: CGEventFlags = []
        for mod in parts.dropLast() {
            switch mod.lowercased() {
            case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option", "opt": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            case "fn": flags.insert(.maskSecondaryFn)
            default: break
            }
        }

        let mainKey = parts.last!
        let keyCode = resolveKeyCode(mainKey, flags: &flags)

        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
        else { return false }

        down.flags = flags
        up.flags = flags

        // Keyboard: WITH auth (Chromium requires on macOS 14+)
        postToPid(pid, event: down, attachAuthMessage: true)
        usleep(10_000)
        postToPid(pid, event: up, attachAuthMessage: true)
        return true
    }

    /// Background type string, character by character with auth.
    @discardableResult
    public static func bgType(pid: pid_t, text: String) -> Bool {
        for ch in text {
            let s = String(ch)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            else { return false }
            let utf16 = Array(s.utf16)
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            postToPid(pid, event: down, attachAuthMessage: true)
            usleep(5_000)
            postToPid(pid, event: up, attachAuthMessage: true)
            usleep(5_000)
        }
        return true
    }

    // MARK: - Layer 3: Stealth Deminiaturize

    /// Execute an action on a (possibly minimized) window stealthily.
    /// If minimized: alpha(0) → deminiaturize → action → minimize → alpha(1).
    /// User sees no window flash.
    @discardableResult
    public static func stealthAct(
        pid: pid_t, windowID: UInt32,
        action: () -> Bool
    ) -> Bool {
        let wasMinimized = WindowManager.isMinimized(windowID)

        if wasMinimized {
            // Step 1: Make invisible
            _ = WindowManager.setWindowAlpha(windowID, alpha: 0)
            usleep(50_000)
            // Step 2: Deminiaturize (invisible)
            _ = WindowManager.deminiaturizeWindow(windowID)
            usleep(300_000) // wait for deminiaturize
        }

        // Step 3: Execute the action
        let ok = action()

        if wasMinimized {
            // Step 4: Re-minimize
            _ = WindowManager.minimizeWindow(windowID)
            usleep(100_000)
            // Step 5: Restore alpha
            _ = WindowManager.setWindowAlpha(windowID, alpha: 1)
        }
        return ok
    }

    // MARK: - Keycode Resolution (mirrors AXActions.press)

    private static func resolveKeyCode(_ key: String, flags: inout CGEventFlags) -> CGKeyCode {
        let lower = key.lowercased()

        // Named keys
        let named: [String: CGKeyCode] = [
            "return": 0x24, "enter": 0x24, "tab": 0x30,
            "escape": 0x35, "esc": 0x35, "space": 0x31,
            "delete": 0x33, "backspace": 0x33,
            "forwarddelete": 0x75, "fwddelete": 0x75,
            "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
            "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
            "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
            "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
            "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
        ]
        if let code = named[lower] { return code }

        // Single character — US keyboard layout
        let charMap: [Character: CGKeyCode] = [
            "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04,
            "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
            "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F,
            "y": 0x10, "t": 0x11, "u": 0x20, "i": 0x22, "o": 0x1F,
            "p": 0x23, "l": 0x25, "j": 0x26, "k": 0x28, "n": 0x2D,
            "m": 0x2E,
            "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "5": 0x17,
            "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19, "0": 0x1D,
            "-": 0x1B, "=": 0x18, "[": 0x21, "]": 0x1E, "\\": 0x2A,
            ";": 0x29, "'": 0x27, ",": 0x2B, ".": 0x2F, "/": 0x2C,
            "`": 0x32,
        ]

        if lower.count == 1, let ch = lower.first, let code = charMap[ch] {
            // Uppercase → add shift
            if key.first?.isUppercase == true {
                flags.insert(.maskShift)
            }
            return code
        }

        return 0 // fallback
    }
}
