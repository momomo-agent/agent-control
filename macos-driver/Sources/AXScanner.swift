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

    /// Snapshot the frontmost app's UI tree, returning interactive elements with @refs.
    /// Handles macOS 26 (Tahoe) where AXWindows returns AXApplication instead of AXWindow.
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

        // Scan windows
        var windows: CFTypeRef?
        AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
        if let winArray = windows as? [AXUIElement] {
            for win in winArray {
                let winRole = attr(win, kAXRoleAttribute) ?? ""

                if winRole == "AXWindow" {
                    // Classic macOS: AXWindow with children
                    elements.append(contentsOf: scanElement(win, depth: 0, maxDepth: 15, counter: &counter, seenAppDepth: 0))
                } else if winRole == "AXApplication" {
                    // macOS 26 (Tahoe): windows returned as AXApplication
                    // Skip recursive AXApplication children, scan only content children
                    elements.append(contentsOf: scanWindowContent(win, counter: &counter))
                } else {
                    // Unknown role, try scanning anyway
                    elements.append(contentsOf: scanElement(win, depth: 0, maxDepth: 15, counter: &counter, seenAppDepth: 0))
                }
            }
        }

        // Scan menubar + extras menubar
        for attrKey in [kAXMenuBarAttribute, kAXExtrasMenuBarAttribute] {
            var bar: CFTypeRef?
            AXUIElementCopyAttributeValue(app, attrKey as CFString, &bar)
            if let barEl = bar {
                elements.append(contentsOf: scanElement(barEl as! AXUIElement, depth: 0, maxDepth: 15, counter: &counter, seenAppDepth: 0))
            }
        }

        if elements.isEmpty {
            fputs("error: no windows or menubar found\n", stderr)
        }
        return elements
    }

    // MARK: - macOS 26 Window Content Scanner

    /// On macOS 26 (Tahoe), AXWindows returns nested AXApplication elements
    /// instead of AXWindow. The tree is fractal: content children can contain
    /// AXApplication elements that loop back. We follow the FIRST AXApplication
    /// child at each level (single-path traversal) to find real content.
    private static func scanWindowContent(_ el: AXUIElement, counter: inout Int, appDepth: Int = 0) -> [ACElement] {
        guard appDepth < 12 else { return [] }

        var results: [ACElement] = []
        let children = getChildElements(el)

        var followedApp = false
        for child in children {
            let role = attr(child, kAXRoleAttribute) ?? ""

            if role == "AXApplication" {
                // Follow only the FIRST AXApplication child to prevent exponential blowup.
                // The fractal tree has multiple AXApplication siblings that all lead to the same content.
                if !followedApp {
                    followedApp = true
                    results.append(contentsOf: scanWindowContent(child, counter: &counter, appDepth: appDepth + 1))
                }
            } else if role == "AXMenuBar" || role == "AXMenu" {
                // Skip menubars inside window chain — they're scanned separately
                continue
            } else {
                // This is actual window content! Scan it, but with AXApplication blocking.
                results.append(contentsOf: scanElement(child, depth: 0, maxDepth: 12, counter: &counter, seenAppDepth: 99))
            }
        }

        return results
    }

    // MARK: - Element Scanner

    private static func scanElement(
        _ el: AXUIElement,
        depth: Int,
        maxDepth: Int,
        counter: inout Int,
        seenAppDepth: Int
    ) -> [ACElement] {
        guard depth < maxDepth else { return [] }

        let role = attr(el, kAXRoleAttribute) ?? "unknown"

        // Prevent AXApplication recursion inside the element tree
        if role == "AXApplication" {
            if seenAppDepth >= 2 { return [] }
            // Pass through but track depth
            var childElements: [ACElement] = []
            for child in getChildElements(el) {
                childElements.append(contentsOf: scanElement(child, depth: depth + 1, maxDepth: maxDepth, counter: &counter, seenAppDepth: seenAppDepth + 1))
            }
            return childElements
        }

        let label = attr(el, kAXTitleAttribute)
            ?? attr(el, kAXDescriptionAttribute)
            ?? attr(el, kAXIdentifierAttribute)
            ?? ""
        let value = attr(el, kAXValueAttribute)
        let frame = getFrame(el)

        let isInteractive = Self.clickableRoles.contains(role)

        // Scan children
        var childElements: [ACElement] = []
        for child in getChildElements(el) {
            childElements.append(contentsOf: scanElement(child, depth: depth + 1, maxDepth: maxDepth, counter: &counter, seenAppDepth: seenAppDepth))
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

    // MARK: - Role Sets

    private static let clickableRoles: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXCheckBox",
        "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXSlider",
        "AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXLink", "AXIncrementor",
        "AXColorWell", "AXDisclosureTriangle", "AXTab",
        "AXSegmentedControl", "AXStaticText", "AXImage", "AXCell", "AXRow"
    ]

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

    private static func getChildElements(_ el: AXUIElement) -> [AXUIElement] {
        var children: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children)
        return (children as? [AXUIElement]) ?? []
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
