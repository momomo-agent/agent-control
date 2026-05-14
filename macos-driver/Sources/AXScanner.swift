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

        // Include interactive elements
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

        // Also include visible content elements (StaticText, Image) for verification/inspection
        // They get refs but are marked interactive: false
        let contentRoles: Set<String> = ["AXStaticText", "AXImage", "AXHeading", "AXGroup"]
        if contentRoles.contains(role) && !(label.isEmpty && (value ?? "").isEmpty) {
            counter += 1
            let ref = "@e\(counter)"
            let element = ACElement(
                ref: ref,
                role: cleanRole(role),
                label: label,
                value: value,
                frame: frame,
                interactive: false,
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
        "AXSegmentedControl", "AXCell", "AXRow", "AXSwitch", "AXStepper"
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

    // MARK: - Full Screen Scan

    /// Scan the entire visible screen: menu bar, dock, all visible windows.
    /// Returns sections with elements, each section has a label and elements.
    struct ScreenSection {
        let label: String
        let elements: [ACElement]
        var displayIndex: Int = 0  // which display this section belongs to
    }

    struct DisplayInfo {
        let index: Int
        let name: String
        let frame: CGRect
        let isMain: Bool
    }

    static func getDisplays() -> [DisplayInfo] {
        var displays: [DisplayInfo] = []
        for (i, screen) in NSScreen.screens.enumerated() {
            let name = screen.localizedName
            let isMain = (screen == NSScreen.main)
            displays.append(DisplayInfo(index: i, name: name, frame: screen.frame, isMain: isMain))
        }
        return displays
    }

    /// Determine which display a window belongs to based on its frame
    private static func displayForWindow(windowFrame: CGRect, displays: [DisplayInfo]) -> Int {
        // Find which display contains the window's center
        let center = CGPoint(x: windowFrame.midX, y: windowFrame.midY)
        for disp in displays {
            if disp.frame.contains(center) {
                return disp.index
            }
        }
        // Fallback: find display with most overlap
        var bestOverlap: CGFloat = 0
        var bestIdx = 0
        for disp in displays {
            let intersection = disp.frame.intersection(windowFrame)
            if !intersection.isNull {
                let area = intersection.width * intersection.height
                if area > bestOverlap {
                    bestOverlap = area
                    bestIdx = disp.index
                }
            }
        }
        return bestIdx
    }

    static func screenSnapshot(maxDepthPerWindow: Int = 3) -> ([DisplayInfo], [ScreenSection]) {
        let displays = getDisplays()
        var sections: [ScreenSection] = []
        var counter = 0

        // 1. Menu Bar (frontmost app)
        if let frontApp = NSWorkspace.shared.frontmostApplication {
            let app = AXUIElementCreateApplication(frontApp.processIdentifier)
            var menuBarElements: [ACElement] = []
            var bar: CFTypeRef?
            AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &bar)
            if let barEl = bar {
                menuBarElements.append(contentsOf: scanElement(barEl as! AXUIElement, depth: 0, maxDepth: 2, counter: &counter, seenAppDepth: 0))
            }
            if !menuBarElements.isEmpty {
                sections.append(ScreenSection(label: "Menu Bar", elements: menuBarElements))
            }
        }

        // 2. Menu Extras (right side: ControlCenter + SystemUIServer)
        let extraBundles = ["com.apple.controlcenter", "com.apple.systemuiserver"]
        var extraElements: [ACElement] = []
        for bundleID in extraBundles {
            guard let serverApp = NSWorkspace.shared.runningApplications.first(where: {
                $0.bundleIdentifier == bundleID
            }) else { continue }
            let app = AXUIElementCreateApplication(serverApp.processIdentifier)
            var menuBar: CFTypeRef?
            AXUIElementCopyAttributeValue(app, "AXExtrasMenuBar" as CFString, &menuBar)
            if menuBar == nil {
                AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &menuBar)
            }
            guard let bar = menuBar else { continue }
            let children = getChildElements(bar as! AXUIElement)
            for child in children {
                let role = attr(child, kAXRoleAttribute) ?? ""
                let label = attr(child, kAXTitleAttribute) ?? attr(child, kAXDescriptionAttribute) ?? ""
                if label.isEmpty { continue }
                counter += 1
                extraElements.append(ACElement(
                    ref: "@e\(counter)",
                    role: cleanRole(role),
                    label: label,
                    value: attr(child, kAXValueAttribute),
                    frame: getFrame(child),
                    interactive: true,
                    children: nil
                ))
            }
        }
        if !extraElements.isEmpty {
            sections.append(ScreenSection(label: "Menu Extras", elements: extraElements))
        }

        // 3. Dock
        if let dockApp = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == "com.apple.dock"
        }) {
            let app = AXUIElementCreateApplication(dockApp.processIdentifier)
            var dockElements: [ACElement] = []
            // Dock has AXChildren with AXList items
            let children = getChildElements(app)
            for child in children {
                let role = attr(child, kAXRoleAttribute) ?? ""
                if role == "AXList" {
                    // Dock items are inside AXList
                    let items = getChildElements(child)
                    for item in items {
                        let itemRole = attr(item, kAXRoleAttribute) ?? ""
                        let itemLabel = attr(item, kAXTitleAttribute) ?? attr(item, kAXDescriptionAttribute) ?? ""
                        if itemLabel.isEmpty { continue }
                        counter += 1
                        dockElements.append(ACElement(
                            ref: "@e\(counter)",
                            role: cleanRole(itemRole),
                            label: itemLabel,
                            value: nil,
                            frame: getFrame(item),
                            interactive: true,
                            children: nil
                        ))
                    }
                }
            }
            if !dockElements.isEmpty {
                sections.append(ScreenSection(label: "Dock", elements: dockElements))
            }
        }

        // 4. Visible Windows (all on-screen apps, shallow scan)
        let visibleApps = NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy == .regular && !$0.isHidden
        }
        for visApp in visibleApps {
            let app = AXUIElementCreateApplication(visApp.processIdentifier)
            var windows: CFTypeRef?
            AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
            guard let winArray = windows as? [AXUIElement], !winArray.isEmpty else { continue }

            let appName = visApp.localizedName ?? "unknown"
            for win in winArray {
                // Get window title
                let winTitle = attr(win, kAXTitleAttribute) ?? ""
                let sectionLabel = winTitle.isEmpty ? appName : "\(appName) \"\(winTitle)\""

                // Get window frame to determine display
                let winFrame = getFrame(win)
                let cgFrame = CGRect(x: CGFloat(winFrame.x), y: CGFloat(winFrame.y),
                                     width: CGFloat(winFrame.w), height: CGFloat(winFrame.h))
                let dispIdx = displayForWindow(windowFrame: cgFrame, displays: displays)

                // Shallow scan: only top-level interactive elements
                var winElements: [ACElement] = []
                let winRole = attr(win, kAXRoleAttribute) ?? ""
                if winRole == "AXWindow" {
                    winElements = scanElement(win, depth: 0, maxDepth: maxDepthPerWindow, counter: &counter, seenAppDepth: 0)
                } else if winRole == "AXApplication" {
                    winElements = scanWindowContent(win, counter: &counter, appDepth: 0)
                } else {
                    winElements = scanElement(win, depth: 0, maxDepth: maxDepthPerWindow, counter: &counter, seenAppDepth: 0)
                }

                if !winElements.isEmpty {
                    var section = ScreenSection(label: sectionLabel, elements: winElements)
                    section.displayIndex = dispIdx
                    sections.append(section)
                }
            }
        }

        return (displays, sections)
    }

    // MARK: - Ref → AXUIElement lookup
    //
    // Find the native AXUIElement behind a `@eN` ref using the SAME traversal
    // and ref-numbering as `snapshot(...)`. This avoids the drift that happens
    // when actions re-walk the tree with different predicates (observed: actions
    // only enumerated `clickableRoles`, while snapshot also numbers `contentRoles`,
    // so refs >700 never resolved via the old simplified walker).
    static func findUIElement(ref: String, appPID: pid_t? = nil) -> AXUIElement? {
        let stripped = ref.hasPrefix("@") ? String(ref.dropFirst()) : ref
        guard stripped.hasPrefix("e"), let target = Int(stripped.dropFirst()) else { return nil }

        let app: AXUIElement
        if let pid = appPID {
            app = AXUIElementCreateApplication(pid)
        } else {
            guard let frontApp = NSWorkspace.shared.frontmostApplication else { return nil }
            app = AXUIElementCreateApplication(frontApp.processIdentifier)
        }

        var counter = 0
        var found: AXUIElement? = nil

        // Mirror snapshot() window traversal
        var windows: CFTypeRef?
        AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
        if let winArray = windows as? [AXUIElement] {
            for win in winArray {
                if found != nil { break }
                let winRole = attr(win, kAXRoleAttribute) ?? ""
                if winRole == "AXWindow" {
                    scanForRef(win, depth: 0, maxDepth: 15, counter: &counter, seenAppDepth: 0, target: target, found: &found)
                } else if winRole == "AXApplication" {
                    scanWindowContentForRef(win, counter: &counter, target: target, found: &found, appDepth: 0)
                } else {
                    scanForRef(win, depth: 0, maxDepth: 15, counter: &counter, seenAppDepth: 0, target: target, found: &found)
                }
            }
        }

        if found == nil {
            for attrKey in [kAXMenuBarAttribute, kAXExtrasMenuBarAttribute] {
                if found != nil { break }
                var bar: CFTypeRef?
                AXUIElementCopyAttributeValue(app, attrKey as CFString, &bar)
                if let barEl = bar {
                    scanForRef(barEl as! AXUIElement, depth: 0, maxDepth: 15, counter: &counter, seenAppDepth: 0, target: target, found: &found)
                }
            }
        }

        return found
    }

    // Mirrors scanWindowContent()
    private static func scanWindowContentForRef(
        _ el: AXUIElement, counter: inout Int,
        target: Int, found: inout AXUIElement?,
        appDepth: Int
    ) {
        if found != nil || appDepth >= 12 { return }
        var followedApp = false
        for child in getChildElements(el) {
            if found != nil { return }
            let role = attr(child, kAXRoleAttribute) ?? ""
            if role == "AXApplication" {
                if !followedApp {
                    followedApp = true
                    scanWindowContentForRef(child, counter: &counter, target: target, found: &found, appDepth: appDepth + 1)
                }
            } else if role == "AXMenuBar" || role == "AXMenu" {
                continue
            } else {
                scanForRef(child, depth: 0, maxDepth: 12, counter: &counter, seenAppDepth: 99, target: target, found: &found)
            }
        }
    }

    // Mirrors scanElement() ref-numbering exactly
    private static func scanForRef(
        _ el: AXUIElement, depth: Int, maxDepth: Int,
        counter: inout Int, seenAppDepth: Int,
        target: Int, found: inout AXUIElement?
    ) {
        if found != nil || depth >= maxDepth { return }
        let role = attr(el, kAXRoleAttribute) ?? "unknown"

        if role == "AXApplication" {
            if seenAppDepth >= 2 { return }
            for child in getChildElements(el) {
                if found != nil { return }
                scanForRef(child, depth: depth + 1, maxDepth: maxDepth, counter: &counter, seenAppDepth: seenAppDepth + 1, target: target, found: &found)
            }
            return
        }

        let label = attr(el, kAXTitleAttribute) ?? attr(el, kAXDescriptionAttribute) ?? attr(el, kAXIdentifierAttribute) ?? ""
        let value = attr(el, kAXValueAttribute) ?? ""
        let isInteractive = Self.clickableRoles.contains(role)

        // Recurse children first? In scanElement children are scanned BEFORE numbering self.
        // Wait: scanElement numbers self AFTER scanning children but the returned order puts self first.
        // For ref numbering we must mirror the ORDER counter is incremented, which is:
        //   1) recurse children (they number themselves first)
        //   2) then parent increments counter.
        // Do the same here.
        for child in getChildElements(el) {
            if found != nil { return }
            scanForRef(child, depth: depth + 1, maxDepth: maxDepth, counter: &counter, seenAppDepth: seenAppDepth, target: target, found: &found)
        }
        if found != nil { return }

        if isInteractive {
            counter += 1
            if counter == target { found = el; return }
        } else {
            let contentRoles: Set<String> = ["AXStaticText", "AXImage", "AXHeading", "AXGroup"]
            if contentRoles.contains(role) && !(label.isEmpty && value.isEmpty) {
                counter += 1
                if counter == target { found = el; return }
            }
        }
    }
}
