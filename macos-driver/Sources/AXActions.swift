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

    static func press(key: String) -> Bool {
        let keyMap: [String: (CGKeyCode, CGEventFlags)] = [
            "return": (0x24, []), "enter": (0x24, []),
            "tab": (0x30, []), "escape": (0x35, []), "esc": (0x35, []),
            "space": (0x31, []), "delete": (0x33, []), "backspace": (0x33, []),
            "up": (0x7E, []), "down": (0x7D, []), "left": (0x7B, []), "right": (0x7C, []),
        ]

        if let (code, flags) = keyMap[key.lowercased()] {
            let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
            let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
            down?.flags = flags
            up?.flags = flags
            down?.post(tap: .cghidEventTap)
            up?.post(tap: .cghidEventTap)
            return true
        }

        // Single character
        if key.count == 1 {
            let chars = Array(key.utf16)
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
