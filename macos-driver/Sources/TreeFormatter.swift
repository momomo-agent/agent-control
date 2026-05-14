import Foundation

/// Formats ACElement trees as human-readable indented text (like Playwright aria snapshots).
/// Interactive elements get @ref inline. Non-interactive containers show as structure.
enum TreeFormatter {

    /// Format a flat/nested element array into indented tree text.
    /// Returns (text, interactiveCount, totalCount)
    static func format(_ elements: [ACElement], interactive interactiveOnly: Bool = false) -> (text: String, interactive: Int, total: Int) {
        var lines: [String] = []
        var stats = (interactive: 0, total: 0)
        for el in elements {
            buildTree(el, depth: 0, lines: &lines, stats: &stats, interactiveOnly: interactiveOnly)
        }
        return (lines.joined(separator: "\n"), stats.interactive, stats.total)
    }

    /// Format desktop overview as indented text
    static func formatDesktop(
        frontmostApp: String?,
        runningApps: [(name: String, isActive: Bool, isHidden: Bool, windowCount: Int)],
        windows: [(windowID: UInt32, app: String, title: String?, frameW: Int, frameH: Int, frameX: Int, frameY: Int, isActive: Bool)],
        menuExtras: [String],
        spaceCount: Int,
        currentSpaceID: UInt64?
    ) -> String {
        var lines: [String] = []
        lines.append("Desktop [space:\(currentSpaceID ?? 0), \(spaceCount) space\(spaceCount == 1 ? "" : "s")]")
        lines.append("")

        // Running apps
        if !runningApps.isEmpty {
            lines.append("  Apps:")
            for app in runningApps {
                var flags: [String] = []
                if app.isActive { flags.append("active") }
                if app.isHidden { flags.append("hidden") }
                if app.windowCount > 0 { flags.append("\(app.windowCount) win") }
                let flagStr = flags.isEmpty ? "" : " [\(flags.joined(separator: ", "))]"
                lines.append("    \(app.name)\(flagStr)")
            }
        }

        // Windows
        if !windows.isEmpty {
            lines.append("")
            lines.append("  Windows:")
            for win in windows {
                let title = win.title ?? ""
                let titlePart = title.isEmpty ? "" : " \"\(String(title.prefix(50)))\""
                let frame = "\(win.frameW)×\(win.frameH) at \(win.frameX),\(win.frameY)"
                var flags: [String] = ["wid:\(win.windowID)", frame]
                if win.isActive { flags.insert("active", at: 0) }
                lines.append("    \(win.app)\(titlePart) [\(flags.joined(separator: ", "))]")
            }
        }

        // Menu extras
        if !menuExtras.isEmpty {
            lines.append("")
            lines.append("  Menu Bar: \(menuExtras.joined(separator: ", "))")
        }

        return lines.joined(separator: "\n")
    }

    /// Format full screen snapshot grouped by display
    /// How many foreground windows to fully expand (rest are collapsed to title only)
    private static let expandLimit = 3

    static func formatScreen(_ sections: [AXScanner.ScreenSection], displays: [AXScanner.DisplayInfo], frontmostApp: String?, frontmostPID: Int32?) -> String {
        var lines: [String] = []
        var totalInteractive = 0

        let focusInfo = frontmostApp ?? "none"
        let displayCount = displays.count
        
        // Separate global sections (menu bar, dock, extras) from window sections
        let globalSections = sections.filter { $0.isGlobal }
        var windowSections = sections.filter { !$0.isGlobal }.sorted { $0.zOrder < $1.zOrder }

        // Assign @w refs in z-order (w1 = frontmost)
        for i in 0..<windowSections.count {
            windowSections[i].windowRef = "@w\(i + 1)"
        }

        // Group window sections by display
        var windowsByDisplay: [Int: [AXScanner.ScreenSection]] = [:]
        for section in windowSections {
            windowsByDisplay[section.displayIndex, default: []].append(section)
        }

        // Helper: render a section fully expanded
                // Helper: render a section fully expanded
        func renderExpanded(_ section: AXScanner.ScreenSection, indent: String) {
            let isActive = frontmostApp != nil && section.label.lowercased().hasPrefix(frontmostApp!.lowercased())
            let activeTag = isActive ? " [active]" : ""
            let ref = section.windowRef.isEmpty ? "" : "\(section.windowRef) "
            lines.append("\(indent)\(ref)\(section.label):\(activeTag)")
            let (text, intCount, _) = format(section.elements, interactive: false)
            totalInteractive += intCount
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                lines.append("\(indent)  \(line)")
            }
        }

        // Helper: render a section collapsed (title only)
        func renderCollapsed(_ section: AXScanner.ScreenSection, indent: String) {
            let isActive = frontmostApp != nil && section.label.lowercased().hasPrefix(frontmostApp!.lowercased())
            let activeTag = isActive ? " [active]" : ""
            // Count interactive elements without rendering
            let (_, intCount, _) = format(section.elements, interactive: false)
            totalInteractive += intCount
            let ref = section.windowRef.isEmpty ? "" : "\(section.windowRef) "
            lines.append("\(indent)\(ref)\(section.label)\(activeTag) [\(intCount) elements]")
        }

        // Single display
        if displayCount <= 1 {
            lines.append("Screen [active: \(focusInfo)]")

            // Global sections always expanded
            for section in globalSections {
                lines.append("")
                renderExpanded(section, indent: "  ")
            }

            // Window sections: expand top N, collapse rest
            if !windowSections.isEmpty {
                lines.append("")
                lines.append("  Windows:")
                for (i, section) in windowSections.enumerated() {
                    lines.append("")
                    if i < expandLimit {
                        renderExpanded(section, indent: "    ")
                    } else {
                        renderCollapsed(section, indent: "    ")
                    }
                }
            }

            lines[0] = "Screen [active: \(focusInfo), \(totalInteractive) interactive]"
            return lines.joined(separator: "\n")
        }

        // Multiple displays
        lines.append("Screen [active: \(focusInfo), \(displayCount) displays]")

        // Global sections (on main display header)
        for section in globalSections {
            lines.append("")
            lines.append("  \(section.label):")
            let (text, intCount, _) = format(section.elements, interactive: false)
            totalInteractive += intCount
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                lines.append("    \(line)")
            }
        }

        // Per-display window sections
        for disp in displays {
            let mainTag = disp.isMain ? ", main" : ""
            let res = "\(Int(disp.frame.width))×\(Int(disp.frame.height))"
            lines.append("")
            lines.append("  ┌ Display \(disp.index + 1): \(disp.name) [\(res)\(mainTag)]")

            let dispWindows = windowsByDisplay[disp.index] ?? []
            for (i, section) in dispWindows.enumerated() {
                lines.append("  │")
                if i < expandLimit {
                    renderExpanded(section, indent: "  │ ")
                } else {
                    renderCollapsed(section, indent: "  │ ")
                }
            }
            if dispWindows.isEmpty {
                lines.append("  │ (no windows)")
            }
            lines.append("  └")
        }

        lines[0] = "Screen [active: \(focusInfo), \(displayCount) displays, \(totalInteractive) interactive]"
        return lines.joined(separator: "\n")
    }
    static func formatApp(name: String, elements: [ACElement], interactive interactiveOnly: Bool = false) -> String {
        let (tree, interactiveCount, total) = format(elements, interactive: interactiveOnly)
        var header = "App \"\(name)\" [\(interactiveCount) interactive, \(total) total]"
        if tree.isEmpty {
            header += "\n  (no elements)"
        }
        return header + "\n" + tree
    }

    // MARK: - Private

    private static let containerRoles: Set<String> = [
        "Group", "Window", "Sheet", "Dialog", "Popover", "Menu", "MenuBar",
        "Toolbar", "TabGroup", "ScrollArea", "SplitGroup", "List", "Table",
        "Outline", "Browser", "NavigationBar", "Drawer", "LayoutArea",
    ]

    private static func buildTree(
        _ el: ACElement,
        depth: Int,
        lines: inout [String],
        stats: inout (interactive: Int, total: Int),
        interactiveOnly: Bool
    ) {
        stats.total += 1
        let indent = String(repeating: "  ", count: depth)

        if el.interactive {
            stats.interactive += 1
            lines.append("\(indent)\(el.ref) \(formatElement(el))")
            // Recurse children
            if let children = el.children {
                for child in children {
                    buildTree(child, depth: depth + 1, lines: &lines, stats: &stats, interactiveOnly: interactiveOnly)
                }
            }
        } else if !interactiveOnly {
            // Non-interactive: show if it's a container with label, or has content
            let isContainer = containerRoles.contains(el.role)
            let hasLabel = !el.label.isEmpty
            let hasValue = el.value != nil && !(el.value?.isEmpty ?? true)
            let hasChildren = el.children != nil && !(el.children?.isEmpty ?? true)

            if isContainer && (hasLabel || hasChildren) {
                // Show container with label
                let labelPart = hasLabel ? " \"\(el.label.prefix(50))\"" : ""
                lines.append("\(indent)- \(el.role)\(labelPart)")
                if let children = el.children {
                    for child in children {
                        buildTree(child, depth: depth + 1, lines: &lines, stats: &stats, interactiveOnly: interactiveOnly)
                    }
                }
            } else if (el.role == "StaticText" || el.role == "Heading" || el.role == "Image") && (hasLabel || hasValue) {
                // Show content elements with ref for context
                let text = el.label.isEmpty ? (el.value ?? "") : el.label
                lines.append("\(indent)\(el.ref) \(el.role) \"\(text.prefix(60))\"")
            } else if hasChildren {
                // Container without label but has children:
                // Keep structure if multiple children, pass-through if single child
                let children = el.children!
                if children.count > 1 {
                    // Show as anonymous container to preserve structure
                    lines.append("\(indent)- \(el.role)")
                    for child in children {
                        buildTree(child, depth: depth + 1, lines: &lines, stats: &stats, interactiveOnly: interactiveOnly)
                    }
                } else {
                    // Single child: pass-through (don't add noise)
                    for child in children {
                        buildTree(child, depth: depth, lines: &lines, stats: &stats, interactiveOnly: interactiveOnly)
                    }
                }
            }
        } else {
            // interactiveOnly mode: skip non-interactive but recurse children
            if let children = el.children {
                for child in children {
                    buildTree(child, depth: depth, lines: &lines, stats: &stats, interactiveOnly: interactiveOnly)
                }
            }
        }
    }

    private static func formatElement(_ el: ACElement) -> String {
        var parts: [String] = [el.role]

        if !el.label.isEmpty {
            parts.append("\"\(el.label.prefix(60))\"")
        }

        if let val = el.value, !val.isEmpty, val != el.label {
            // TextArea (terminals, editors): show more content
            let limit = el.role == "AXTextArea" ? 500 : 80
            let display = val.count > limit ? String(val.suffix(limit)) : val
            // Replace newlines for single-line display
            let cleaned = display.replacingOccurrences(of: "\n", with: "↵")
            parts.append("val=\"\(cleaned)\"")
        }

        return parts.joined(separator: " ")
    }
}
