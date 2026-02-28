import ApplicationServices
import AppKit
import Foundation

// MARK: - Element Model

struct ACElement: Encodable {
    let ref: String
    let role: String
    let label: String
    let value: String?
    let frame: ACFrame
    let interactive: Bool
    let children: [ACElement]?

    struct ACFrame: Encodable {
        let x: Int, y: Int, w: Int, h: Int
    }
}

// MARK: - AX Scanner

enum AXScanner {

    /// Snapshot the frontmost app's UI tree, returning interactive elements with @refs
    static func snapshot(appPID: pid_t? = nil) -> [ACElement] {
        let app: AXUIElement
        if let pid = appPID {
            app = AXUIElementCreateApplication(pid)
        } else {
            guard let frontApp = NSWorkspace.shared.frontmostApplication else {
                fputs("error: no frontmost application\n", stderr)
                return []
            }
            app = AXUIElementCreateApplication(frontApp.processIdentifier)
        }

        var counter = 0
        var elements: [ACElement] = []

        // Scan windows (normal apps + Electron)
        var windows: CFTypeRef?
        AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
        if let winArray = windows as? [AXUIElement], let mainWin = winArray.first {
            elements.append(contentsOf: scanElement(mainWin, depth: 0, maxDepth: 15, counter: &counter))
        }

        // Scan menubar + extras menubar (menubar apps, status items)
        for attr in [kAXMenuBarAttribute, kAXExtrasMenuBarAttribute] {
            var bar: CFTypeRef?
            AXUIElementCopyAttributeValue(app, attr as CFString, &bar)
            if let barEl = bar {
                elements.append(contentsOf: scanElement(barEl as! AXUIElement, depth: 0, maxDepth: 15, counter: &counter))
            }
        }

        if elements.isEmpty {
            fputs("error: no windows or menubar found\n", stderr)
        }
        return elements
    }

    private static func scanElement(
        _ el: AXUIElement,
        depth: Int,
        maxDepth: Int,
        counter: inout Int
    ) -> [ACElement] {
        guard depth < maxDepth else { return [] }

        let role = attr(el, kAXRoleAttribute) ?? "unknown"
        let label = attr(el, kAXTitleAttribute)
            ?? attr(el, kAXDescriptionAttribute)
            ?? attr(el, kAXIdentifierAttribute)
            ?? ""
        let value = attr(el, kAXValueAttribute)
        let frame = getFrame(el)

        let interactiveRoles: Set<String> = [
            "AXButton", "AXTextField", "AXTextArea", "AXCheckBox",
            "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXSlider",
            "AXMenuItem", "AXMenuButton", "AXLink", "AXIncrementor",
            "AXColorWell", "AXDisclosureTriangle", "AXTab", "AXToolbar",
            "AXSegmentedControl", "AXScrollArea", "AXSplitter",
            "AXStaticText", "AXImage", "AXCell", "AXRow", "AXOutline",
            "AXTable", "AXList"
        ]
        let clickableRoles: Set<String> = [
            "AXButton", "AXTextField", "AXTextArea", "AXCheckBox",
            "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXSlider",
            "AXMenuItem", "AXMenuButton", "AXLink", "AXIncrementor",
            "AXColorWell", "AXDisclosureTriangle", "AXTab",
            "AXSegmentedControl", "AXStaticText", "AXImage", "AXCell", "AXRow"
        ]
        let isInteractive = clickableRoles.contains(role)

        // Scan children
        var childElements: [ACElement] = []
        var children: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children)
        if let childArray = children as? [AXUIElement] {
            for child in childArray {
                childElements.append(contentsOf: scanElement(child, depth: depth + 1, maxDepth: maxDepth, counter: &counter))
            }
        }

        // Only include interactive elements or groups with interactive children
        if isInteractive {
            counter += 1
            let ref = "@e\(counter)"
            let element = ACElement(
                ref: ref,
                role: cleanRole(role),
                label: label,
                value: value,
                frame: frame,
                interactive: true,
                children: childElements.isEmpty ? nil : childElements
            )
            return [element]
        }

        // Pass through non-interactive containers
        return childElements
    }

    // MARK: - Helpers

    private static func attr(_ el: AXUIElement, _ key: String) -> String? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(el, key as CFString, &value)
        guard result == .success, let v = value else { return nil }
        if let s = v as? String, !s.isEmpty { return s }
        if CFGetTypeID(v) == CFBooleanGetTypeID() {
            return CFBooleanGetValue(v as! CFBoolean) ? "true" : "false"
        }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    private static func getFrame(_ el: AXUIElement) -> ACElement.ACFrame {
        var posValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posValue)
        AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeValue)

        var pos = CGPoint.zero
        var size = CGSize.zero
        if let pv = posValue {
            AXValueGetValue(pv as! AXValue, .cgPoint, &pos)
        }
        if let sv = sizeValue {
            AXValueGetValue(sv as! AXValue, .cgSize, &size)
        }
        return ACElement.ACFrame(
            x: Int(pos.x), y: Int(pos.y),
            w: Int(size.width), h: Int(size.height)
        )
    }

    private static func cleanRole(_ role: String) -> String {
        role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
    }
}
