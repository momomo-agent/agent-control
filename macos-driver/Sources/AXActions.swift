import ApplicationServices
import AppKit
import Foundation

// MARK: - Actions

enum AXActions {

    /// Find element by ref from a fresh snapshot
    static func findElement(ref: String, appPID: pid_t? = nil) -> AXUIElement? {
        let app: AXUIElement
        if let pid = appPID {
            app = AXUIElementCreateApplication(pid)
        } else {
            guard let frontApp = NSWorkspace.shared.frontmostApplication else { return nil }
            app = AXUIElementCreateApplication(frontApp.processIdentifier)
        }

        // Extract ref number — accept both "@e3" and "e3"
        let stripped = ref.hasPrefix("@") ? String(ref.dropFirst()) : ref
        guard stripped.hasPrefix("e"), let num = Int(stripped.dropFirst()) else { return nil }

        var counter = 0

        // Search windows first
        var windows: CFTypeRef?
        AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
        if let winArray = windows as? [AXUIElement], let mainWin = winArray.first {
            if let found = findInTree(mainWin, target: num, counter: &counter, depth: 0, maxDepth: 15) {
                return found
            }
        }

        // Search menubar + extras menubar
        for attr in [kAXMenuBarAttribute, kAXExtrasMenuBarAttribute] {
            var bar: CFTypeRef?
            AXUIElementCopyAttributeValue(app, attr as CFString, &bar)
            if let barEl = bar {
                if let found = findInTree(barEl as! AXUIElement, target: num, counter: &counter, depth: 0, maxDepth: 15) {
                    return found
                }
            }
        }

        return nil
    }

    private static func findInTree(
        _ el: AXUIElement, target: Int, counter: inout Int,
        depth: Int, maxDepth: Int
    ) -> AXUIElement? {
        guard depth < maxDepth else { return nil }

        let role = axAttr(el, kAXRoleAttribute) ?? ""
        // Must match clickableRoles in AXScanner exactly
        let interactiveRoles: Set<String> = [
            "AXButton", "AXTextField", "AXTextArea", "AXCheckBox",
            "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXSlider",
            "AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXLink", "AXIncrementor",
            "AXColorWell", "AXDisclosureTriangle", "AXTab",
            "AXSegmentedControl", "AXCell", "AXRow", "AXSwitch", "AXStepper"
        ]

        if interactiveRoles.contains(role) {
            counter += 1
            if counter == target { return el }
        }

        var children: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children)
        if let childArray = children as? [AXUIElement] {
            for child in childArray {
                if let found = findInTree(child, target: target, counter: &counter, depth: depth + 1, maxDepth: maxDepth) {
                    return found
                }
            }
        }
        return nil
    }

    // MARK: - Click

    static func click(ref: String, appPID: pid_t? = nil) -> Bool {
        guard let el = findElement(ref: ref, appPID: appPID) else {
            fputs("error: element \(ref) not found\n", stderr)
            return false
        }
        // Try AXPress first
        let result = AXUIElementPerformAction(el, kAXPressAction as CFString)
        if result == .success { return true }

        // Fallback: CGEvent click at center
        guard let point = centerOf(el) else { return false }
        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
        down?.post(tap: .cghidEventTap)
        usleep(50_000)
        up?.post(tap: .cghidEventTap)
        return true
    }

    /// 后台 click：用 FocusGuard 三层栈包裹。
    /// - Chromium/Electron: 先打开 web AX tree
    /// - 所有 app: action 前后 swap AXFocused/AXMain
    /// - 监听自激活通知，零延迟反弹
    /// 不走 CGEvent fallback（这会移动真实 cursor）
    static func clickBackground(ref: String, appPID: pid_t? = nil) -> Bool {
        guard let el = findElement(ref: ref, appPID: appPID) else {
            fputs("error: element \(ref) not found\n", stderr)
            return false
        }

        // 获取 pid（有 appPID 就用，否则从 el 查）
        var pid: pid_t = appPID ?? 0
        if pid == 0 {
            _ = AXUIElementGetPid(el, &pid)
        }
        guard pid > 0 else {
            fputs("error: cannot resolve pid for element\n", stderr)
            return false
        }

        // 查找所在窗口
        var windowRef: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXWindowAttribute as CFString, &windowRef)
        let window = windowRef as! AXUIElement?

        // FocusGuard 三层栈包裹
        return FocusGuard.withFocusSuppressed(
            pid: pid, window: window, element: el
        ) { () -> Bool in
            let result = AXUIElementPerformAction(el, kAXPressAction as CFString)
            return result == .success
        }
    }

    /// 后台右键：AXShowMenu 不 raise
    static func rightclickBackground(ref: String, appPID: pid_t? = nil) -> Bool {
        guard let el = findElement(ref: ref, appPID: appPID) else {
            fputs("error: element \(ref) not found\n", stderr)
            return false
        }
        var pid: pid_t = appPID ?? 0
        if pid == 0 { _ = AXUIElementGetPid(el, &pid) }
        guard pid > 0 else { return false }

        var windowRef: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXWindowAttribute as CFString, &windowRef)
        let window = windowRef as! AXUIElement?

        return FocusGuard.withFocusSuppressed(
            pid: pid, window: window, element: el
        ) { () -> Bool in
            return AXUIElementPerformAction(el, kAXShowMenuAction as CFString) == .success
        }
    }

    /// 后台双击：AX 原生不支持，降级为两次 press 之间微延时
    static func dblclickBackground(ref: String, appPID: pid_t? = nil) -> Bool {
        guard let el = findElement(ref: ref, appPID: appPID) else {
            fputs("error: element \(ref) not found\n", stderr)
            return false
        }
        var pid: pid_t = appPID ?? 0
        if pid == 0 { _ = AXUIElementGetPid(el, &pid) }
        guard pid > 0 else { return false }

        var windowRef: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXWindowAttribute as CFString, &windowRef)
        let window = windowRef as! AXUIElement?

        return FocusGuard.withFocusSuppressed(
            pid: pid, window: window, element: el
        ) { () -> Bool in
            let r1 = AXUIElementPerformAction(el, kAXPressAction as CFString)
            usleep(80_000)
            let r2 = AXUIElementPerformAction(el, kAXPressAction as CFString)
            return r1 == .success && r2 == .success
        }
    }

    /// 后台文本输入：AXValue 直接写，不做 kAXRaiseAction（会 raise）
    static func fillBackground(ref: String, text: String, appPID: pid_t? = nil) -> Bool {
        guard let el = findElement(ref: ref, appPID: appPID) else {
            fputs("error: element \(ref) not found\n", stderr)
            return false
        }
        var pid: pid_t = appPID ?? 0
        if pid == 0 { _ = AXUIElementGetPid(el, &pid) }
        guard pid > 0 else { return false }

        var windowRef: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXWindowAttribute as CFString, &windowRef)
        let window = windowRef as! AXUIElement?

        return FocusGuard.withFocusSuppressed(
            pid: pid, window: window, element: el
        ) { () -> Bool in
            // 不调 kAXRaiseAction（会抢前台），直接写 value。
            // FocusGuard Layer 2 已经把 AXFocused 置 true 了，AppKit 状态机
            // 通常够用
            let result = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef)
            return result == .success
        }
    }

    // MARK: - Double Click

    static func dblclick(ref: String, appPID: pid_t? = nil) -> Bool {
        guard let el = findElement(ref: ref, appPID: appPID) else {
            fputs("error: element \(ref) not found\n", stderr)
            return false
        }
        // AX doesn't have native dblclick — simulate via CGEvent
        var pos: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &pos)
        guard let pv = pos else { return false }
        var point = CGPoint.zero
        AXValueGetValue(pv as! AXValue, .cgPoint, &point)

        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
        down?.setIntegerValueField(.mouseEventClickState, value: 2)
        up?.setIntegerValueField(.mouseEventClickState, value: 2)
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        return true
    }

    // MARK: - Right Click

    static func rightclick(ref: String, appPID: pid_t? = nil) -> Bool {
        guard let el = findElement(ref: ref, appPID: appPID) else {
            fputs("error: element \(ref) not found\n", stderr)
            return false
        }
        let result = AXUIElementPerformAction(el, kAXShowMenuAction as CFString)
        if result == .success { return true }

        // Fallback: CGEvent right click
        var pos: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &pos)
        guard let pv = pos else { return false }
        var point = CGPoint.zero
        AXValueGetValue(pv as! AXValue, .cgPoint, &point)

        let down = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right)
        let up = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right)
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        return true
    }

    // MARK: - Fill

    static func fill(ref: String, text: String, appPID: pid_t? = nil) -> Bool {
        guard let el = findElement(ref: ref, appPID: appPID) else {
            fputs("error: element \(ref) not found\n", stderr)
            return false
        }
        // Focus the element
        AXUIElementPerformAction(el, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, true as CFTypeRef)
        usleep(50_000)

        // Set value directly
        let result = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef)
        if result == .success { return true }

        // Fallback: Cmd+A then type via CGEvent
        let cmdA = CGEvent(keyboardEventSource: nil, virtualKey: 0x00, keyDown: true)
        let cmdAUp = CGEvent(keyboardEventSource: nil, virtualKey: 0x00, keyDown: false)
        cmdA?.flags = .maskCommand
        cmdAUp?.flags = .maskCommand
        cmdA?.post(tap: .cghidEventTap)
        cmdAUp?.post(tap: .cghidEventTap)
        usleep(50_000)

        for char in text {
            let chars = Array(String(char).utf16)
            let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            down?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            up?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            down?.post(tap: .cghidEventTap)
            up?.post(tap: .cghidEventTap)
            usleep(5_000)
        }
        return true
    }

    // MARK: - Press Key

    /// Parse modifier token → CGEventFlags
    private static func modifierFlag(_ token: String) -> CGEventFlags? {
        switch token.lowercased() {
        case "cmd", "command", "meta", "super": return .maskCommand
        case "shift":                             return .maskShift
        case "alt", "option", "opt":              return .maskAlternate
        case "ctrl", "control":                   return .maskControl
        case "fn":                                return .maskSecondaryFn
        default: return nil
        }
    }

    /// Named keys → virtual keycode. Letters/digits/punct handled separately.
    private static func keyCodeForNamed(_ name: String) -> CGKeyCode? {
        let map: [String: CGKeyCode] = [
            "return": 0x24, "enter": 0x24,
            "tab": 0x30, "escape": 0x35, "esc": 0x35,
            "space": 0x31, "delete": 0x33, "backspace": 0x33,
            "forwarddelete": 0x75, "fwddelete": 0x75,
            "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
            "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
            "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60,
            "f6": 0x61, "f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D,
            "f11": 0x67, "f12": 0x6F,
        ]
        return map[name.lowercased()]
    }

    /// Letters/digits/common punct → virtual keycode (US layout).
    /// Needed so modifiers (Cmd/Ctrl/…) combine with the correct physical key —
    /// keyboardSetUnicodeString ignores flags, so we must use real keycodes.
    private static func keyCodeForChar(_ ch: Character) -> CGKeyCode? {
        let map: [Character: CGKeyCode] = [
            "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04,
            "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
            "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F,
            "y": 0x10, "t": 0x11, "o": 0x1F, "u": 0x20, "i": 0x22,
            "p": 0x23, "l": 0x25, "j": 0x26, "k": 0x28, "n": 0x2D,
            "m": 0x2E,
            "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "5": 0x17,
            "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19, "0": 0x1D,
            "-": 0x1B, "=": 0x18, "[": 0x21, "]": 0x1E, "\\": 0x2A,
            ";": 0x29, "'": 0x27, ",": 0x2B, ".": 0x2F, "/": 0x2C, "`": 0x32,
        ]
        return map[Character(ch.lowercased())]
    }

    static func press(key: String) -> Bool {
        // Parse "cmd+shift+a" — last token is the key, rest are modifiers.
        // Single-plus edge case "+" handled by checking if there's a trailing '+'.
        var flags: CGEventFlags = []
        var mainKey = key

        if key.contains("+") && key != "+" {
            let parts = key.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
            // Everything except the last part is a modifier; the last part is the key.
            for m in parts.dropLast() {
                guard let f = modifierFlag(m) else {
                    fputs("error: unknown modifier '\(m)' in '\(key)'\n", stderr)
                    return false
                }
                flags.insert(f)
            }
            mainKey = parts.last ?? key
        }

        // Resolve main key → virtual keycode
        var keycode: CGKeyCode? = keyCodeForNamed(mainKey)
        if keycode == nil, mainKey.count == 1, let ch = mainKey.first {
            // For letters with Shift, Shift alone produces uppercase — we still want the
            // lowercase keycode + shift flag.
            if ch.isUppercase {
                flags.insert(.maskShift)
            }
            keycode = keyCodeForChar(ch)
        }

        if let code = keycode {
            let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
            let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
            down?.flags = flags
            up?.flags = flags
            down?.post(tap: .cghidEventTap)
            usleep(10_000)
            up?.post(tap: .cghidEventTap)
            return true
        }

        // Last resort: single unicode char without modifiers (e.g. non-ASCII).
        // Modifiers are ignored here because keyboardSetUnicodeString + flags is unreliable.
        if flags.isEmpty && mainKey.count == 1 {
            let chars = Array(mainKey.utf16)
            let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            down?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            up?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            down?.post(tap: .cghidEventTap)
            up?.post(tap: .cghidEventTap)
            return true
        }

        fputs("error: unknown key '\(key)'\n", stderr)
        return false
    }

    // MARK: - Drag

    static func drag(fromRef: String, toRef: String, appPID: pid_t? = nil) -> Bool {
        guard let fromEl = findElement(ref: fromRef, appPID: appPID),
              let toEl = findElement(ref: toRef, appPID: appPID) else {
            fputs("error: element not found for drag\n", stderr)
            return false
        }

        let fromPoint = centerOf(fromEl)
        let toPoint = centerOf(toEl)
        guard let fp = fromPoint, let tp = toPoint else { return false }

        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: fp, mouseButton: .left)
        down?.post(tap: .cghidEventTap)
        usleep(50_000)

        // Interpolate for smooth drag
        let steps = 10
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            let p = CGPoint(x: fp.x + (tp.x - fp.x) * t, y: fp.y + (tp.y - fp.y) * t)
            let move = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)
            move?.post(tap: .cghidEventTap)
            usleep(20_000)
        }

        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: tp, mouseButton: .left)
        up?.post(tap: .cghidEventTap)
        return true
    }

    // MARK: - Coordinate Click

    static func clickAt(x: CGFloat, y: CGFloat, button: String = "left") -> Bool {
        let point = CGPoint(x: x, y: y)
        let isRight = button == "right"
        let downType: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
        let upType: CGEventType = isRight ? .rightMouseUp : .leftMouseUp
        let btn: CGMouseButton = isRight ? .right : .left
        let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: btn)
        let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: btn)
        down?.post(tap: .cghidEventTap)
        usleep(50_000)
        up?.post(tap: .cghidEventTap)
        return true
    }

    // MARK: - Coordinate Drag

    static func dragCoord(x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat) -> Bool {
        let fp = CGPoint(x: x1, y: y1)
        let tp = CGPoint(x: x2, y: y2)
        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: fp, mouseButton: .left)
        down?.post(tap: .cghidEventTap)
        usleep(50_000)
        let steps = 10
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            let p = CGPoint(x: fp.x + (tp.x - fp.x) * t, y: fp.y + (tp.y - fp.y) * t)
            let move = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)
            move?.post(tap: .cghidEventTap)
            usleep(20_000)
        }
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: tp, mouseButton: .left)
        up?.post(tap: .cghidEventTap)
        return true
    }

    // MARK: - Scroll

    static func scroll(direction: String, amount: Int32) -> Bool {
        let dx: Int32
        let dy: Int32
        switch direction.lowercased() {
        case "up": dy = amount; dx = 0
        case "down": dy = -amount; dx = 0
        case "left": dx = amount; dy = 0
        case "right": dx = -amount; dy = 0
        default:
            fputs("error: scroll direction must be up/down/left/right\n", stderr)
            return false
        }
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
        event?.post(tap: .cghidEventTap)
        return true
    }

    // MARK: - Helpers

    private static func centerOf(_ el: AXUIElement) -> CGPoint? {
        var posValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posValue)
        AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeValue)
        guard let pv = posValue, let sv = sizeValue else { return nil }
        var pos = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(pv as! AXValue, .cgPoint, &pos)
        AXValueGetValue(sv as! AXValue, .cgSize, &size)
        return CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
    }

    private static func axAttr(_ el: AXUIElement, _ key: String) -> String? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(el, key as CFString, &value)
        guard result == .success, let s = value as? String else { return nil }
        return s
    }

    static func longpress(ref: String, duration: Double = 1.0, appPID: pid_t? = nil) -> Bool {
        guard let el = findElement(ref: ref, appPID: appPID) else {
            fputs("error: element \(ref) not found\n", stderr)
            return false
        }
        guard let point = centerOf(el) else { return false }
        return longpressAt(x: point.x, y: point.y, duration: duration)
    }

    static func longpressAt(x: CGFloat, y: CGFloat, duration: Double = 1.0) -> Bool {
        let point = CGPoint(x: x, y: y)
        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
        down?.post(tap: .cghidEventTap)
        usleep(UInt32(duration * 1_000_000))
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
        up?.post(tap: .cghidEventTap)
        return true
    }
}
