import Foundation
import AppKit
import CoreGraphics

// MARK: - CGS/SLS Private API Declarations

private typealias CGSConnectionID = Int32

@_silgen_name("CGSMainConnectionID")
private func CGSMainConnectionID() -> CGSConnectionID

@_silgen_name("CGSCopyManagedDisplaySpaces")
private func CGSCopyManagedDisplaySpaces(_ cid: CGSConnectionID) -> CFArray?

@_silgen_name("CGSManagedDisplayGetCurrentSpace")
private func CGSManagedDisplayGetCurrentSpace(_ cid: CGSConnectionID, _ display: CFString) -> UInt64

@_silgen_name("CGSCopySpaces")
private func CGSCopySpaces(_ cid: CGSConnectionID, _ type: Int32) -> CFArray?

@_silgen_name("CGSAddWindowsToSpaces")
private func CGSAddWindowsToSpaces(_ cid: CGSConnectionID, _ windows: CFArray, _ spaces: CFArray) -> CGError

@_silgen_name("CGSRemoveWindowsFromSpaces")
private func CGSRemoveWindowsFromSpaces(_ cid: CGSConnectionID, _ windows: CFArray, _ spaces: CFArray) -> CGError

@_silgen_name("CGSMoveWindowsToManagedSpace")
private func CGSMoveWindowsToManagedSpace(_ cid: CGSConnectionID, _ windows: CFArray, _ space: UInt64) -> CGError

@_silgen_name("CGSSetWindowAlpha")
private func CGSSetWindowAlpha(_ cid: CGSConnectionID, _ wid: UInt32, _ alpha: Float) -> CGError

@_silgen_name("CGSGetWindowAlpha")
private func CGSGetWindowAlpha(_ cid: CGSConnectionID, _ wid: UInt32, _ alpha: UnsafeMutablePointer<Float>) -> CGError

@_silgen_name("CGSSetWindowLevel")
private func CGSSetWindowLevel(_ cid: CGSConnectionID, _ wid: UInt32, _ level: Int32) -> CGError

@_silgen_name("CGSGetWindowLevel")
private func CGSGetWindowLevel(_ cid: CGSConnectionID, _ wid: UInt32, _ level: UnsafeMutablePointer<Int32>) -> CGError

@_silgen_name("CGSSetWindowBackgroundBlurRadius")
private func CGSSetWindowBackgroundBlurRadius(_ cid: CGSConnectionID, _ wid: UInt32, _ radius: Int32) -> CGError

@_silgen_name("CGSOrderWindow")
private func CGSOrderWindow(_ cid: CGSConnectionID, _ wid: UInt32, _ order: Int32, _ relativeToWid: UInt32) -> CGError

@_silgen_name("CGSSetWindowTransform")
private func CGSSetWindowTransform(_ cid: CGSConnectionID, _ wid: UInt32, _ transform: CGAffineTransform) -> CGError

@_silgen_name("CGSGetWindowTransform")
private func CGSGetWindowTransform(_ cid: CGSConnectionID, _ wid: UInt32, _ transform: UnsafeMutablePointer<CGAffineTransform>) -> CGError

@_silgen_name("CGSConnectionGetPID")
private func CGSConnectionGetPID(_ cid: CGSConnectionID, _ pid: UnsafeMutablePointer<pid_t>) -> CGError

@_silgen_name("CGSManagedDisplaySetCurrentSpace")
private func CGSManagedDisplaySetCurrentSpace(_ cid: CGSConnectionID, _ display: CFString, _ space: UInt64) -> CGError

// SLS functions — use @_silgen_name for stability (dlsym + unsafeBitCast can cause SIGBUS)

@_silgen_name("SLSGetOnScreenWindowCount")
private func SLSGetOnScreenWindowCount(_ cid: CGSConnectionID, _ owner: CGSConnectionID, _ count: UnsafeMutablePointer<Int32>) -> Int32

@_silgen_name("SLSGetOnScreenWindowList")
private func SLSGetOnScreenWindowList(_ cid: CGSConnectionID, _ owner: CGSConnectionID, _ max: Int32, _ list: UnsafeMutablePointer<UInt32>, _ count: UnsafeMutablePointer<Int32>) -> Int32

@_silgen_name("SLSGetWindowCount")
private func SLSGetWindowCount(_ cid: CGSConnectionID, _ owner: CGSConnectionID, _ count: UnsafeMutablePointer<Int32>) -> Int32

@_silgen_name("SLSGetWindowList")
private func SLSGetWindowList(_ cid: CGSConnectionID, _ owner: CGSConnectionID, _ max: Int32, _ list: UnsafeMutablePointer<UInt32>, _ count: UnsafeMutablePointer<Int32>) -> Int32

@_silgen_name("SLSGetWindowBounds")
private func SLSGetWindowBounds(_ cid: CGSConnectionID, _ wid: UInt32, _ bounds: UnsafeMutablePointer<CGRect>) -> Int32

@_silgen_name("SLSGetWindowType")
private func SLSGetWindowType(_ cid: CGSConnectionID, _ wid: UInt32, _ type: UnsafeMutablePointer<Int32>) -> Int32

@_silgen_name("SLSGetWindowOwner")
private func SLSGetWindowOwner(_ cid: CGSConnectionID, _ wid: UInt32, _ ownerCid: UnsafeMutablePointer<CGSConnectionID>) -> Int32

@_silgen_name("SLPSGetWindowOwner")
private func SLPSGetWindowOwner(_ wid: UInt32, _ psn: UnsafeMutableRawPointer) -> Int32

@_silgen_name("GetProcessPID")
private func GetProcessPID(_ psn: UnsafeRawPointer, _ pid: UnsafeMutablePointer<pid_t>) -> Int32

@_silgen_name("SLSWindowIsVisible")
private func SLSWindowIsVisible(_ cid: CGSConnectionID, _ wid: UInt32) -> Bool

@_silgen_name("SLSWindowIsOnCurrentSpace")
private func SLSWindowIsOnCurrentSpace(_ cid: CGSConnectionID, _ wid: UInt32) -> Bool

@_silgen_name("SLSGetWindowEventMask")
private func SLSGetWindowEventMask(_ cid: CGSConnectionID, _ wid: UInt32, _ mask: UnsafeMutablePointer<UInt64>) -> Int32

@_silgen_name("SLSSetWindowEventMask")
private func SLSSetWindowEventMask(_ cid: CGSConnectionID, _ wid: UInt32, _ mask: UInt64) -> Int32

@_silgen_name("SLSCopyManagedDisplayForWindow")
private func SLSCopyManagedDisplayForWindow(_ cid: CGSConnectionID, _ wid: UInt32) -> CFString?

@_silgen_name("SLSMoveWindow")
private func SLSMoveWindow(_ cid: CGSConnectionID, _ wid: UInt32, _ point: UnsafeMutablePointer<CGPoint>) -> Int32

@_silgen_name("SLSGetActiveSpace")
private func SLSGetActiveSpace(_ cid: CGSConnectionID) -> UInt64

// MARK: - Window Info Model

struct WindowInfo: Encodable {
    let windowID: UInt32
    let ownerName: String
    let ownerPID: Int32
    let name: String?
    let frame: ACElement.ACFrame
    let layer: Int
    let alpha: Float
    let spaceIDs: [UInt64]
    let isOnScreen: Bool
    let windowType: Int?
    let eventMask: UInt64?
    let displayID: String?
}

struct SpaceInfo: Encodable {
    let spaceID: UInt64
    let type: String
    let displayID: String
    let isCurrent: Bool
    let uuid: String?
}

struct ProcessInfo_AC: Encodable {
    let pid: Int32
    let name: String
    let bundleID: String?
    let isActive: Bool
    let isHidden: Bool
    let windowCount: Int
}

struct TCCStatus: Encodable {
    let service: String
    let displayName: String
    let status: String
    let required: Bool
}

// MARK: - TCC Private API

private let tccHandle: UnsafeMutableRawPointer? = dlopen("/System/Library/PrivateFrameworks/TCC.framework/TCC", RTLD_LAZY)

private func tccAccessPreflight(_ service: String) -> Int32 {
    guard let handle = tccHandle,
          let sym = dlsym(handle, "TCCAccessPreflight") else { return -1 }
    typealias Fn = @convention(c) (CFString) -> Int32
    let fn = unsafeBitCast(sym, to: Fn.self)
    return fn(service as CFString)
}

// MARK: - PID → App Name Cache

private var pidNameCache: [pid_t: String] = [:]
private var pidNameCacheTime: Date = .distantPast

private func appName(for pid: pid_t) -> String {
    if Date().timeIntervalSince(pidNameCacheTime) > 5 {
        pidNameCache.removeAll()
        pidNameCacheTime = Date()
        for app in NSWorkspace.shared.runningApplications {
            if let name = app.localizedName {
                pidNameCache[app.processIdentifier] = name
            }
        }
    }
    return pidNameCache[pid] ?? "pid:\(pid)"
}

// MARK: - _AXUIElementGetWindow

private let _axGetWindow: ((_ el: AXUIElement, _ wid: UnsafeMutablePointer<UInt32>) -> Int32)? = {
    guard let sym = dlsym(dlopen(nil, RTLD_LAZY), "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(sym, to: (@convention(c) (AXUIElement, UnsafeMutablePointer<UInt32>) -> Int32).self)
}()

// MARK: - Window Manager

enum WindowManager {

    private static var cid: CGSConnectionID { CGSMainConnectionID() }

    // MARK: - SLS Window Enumeration

    static func pidForWindow(_ wid: UInt32) -> pid_t {
        // Use CGWindowListCopyWindowInfo (public API, stable)
        // SLPSGetWindowOwner + GetProcessPID are deprecated Carbon APIs
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionIncludingWindow], CGWindowID(wid)
        ) as? [[String: Any]] else { return -1 }
        
        for info in windowList {
            if let windowID = info[kCGWindowNumber as String] as? UInt32,
               windowID == wid,
               let pid = info[kCGWindowOwnerPID as String] as? pid_t {
                return pid
            }
        }
        return -1
    }

    private static func onScreenWindowIDs() -> [UInt32] {
        var count: Int32 = 0
        guard SLSGetOnScreenWindowCount(cid, 0, &count) == 0, count > 0 else { return [] }
        var wids = [UInt32](repeating: 0, count: Int(count))
        var actual: Int32 = 0
        guard SLSGetOnScreenWindowList(cid, 0, count, &wids, &actual) == 0 else { return [] }
        return Array(wids.prefix(Int(actual)))
    }

    private static func allWindowIDs() -> [UInt32] {
        var count: Int32 = 0
        guard SLSGetWindowCount(cid, 0, &count) == 0, count > 0 else { return [] }
        var wids = [UInt32](repeating: 0, count: Int(count))
        var actual: Int32 = 0
        guard SLSGetWindowList(cid, 0, count, &wids, &actual) == 0 else { return [] }
        return Array(wids.prefix(Int(actual)))
    }

    // MARK: - Windows

    static func listWindows(forPID: pid_t? = nil) -> [WindowInfo] {
        let wids = forPID != nil ? allWindowIDs() : onScreenWindowIDs()
        let spaceMap = buildWindowSpaceMap()

        var windows: [WindowInfo] = []
        for wid in wids {
            let pid = pidForWindow(wid)
            if pid <= 0 { continue }
            if let filterPID = forPID, pid != filterPID { continue }

            var bounds = CGRect.zero
            var level: Int32 = 0
            var type: Int32 = 0
            var alpha: Float = 1.0
            var eventMask: UInt64 = 0

            _ = SLSGetWindowBounds(cid, wid, &bounds)
            _ = CGSGetWindowLevel(cid, wid, &level)
            _ = SLSGetWindowType(cid, wid, &type)
            _ = CGSGetWindowAlpha(cid, wid, &alpha)
            _ = SLSGetWindowEventMask(cid, wid, &eventMask)

            // SLSWindowIsVisible SIGBUS on some windows (macOS 26 beta)
            // All on-screen windows are visible by definition
            let visible = true

            // Skip system-level windows unless filtering by PID
            if forPID == nil && level != 0 { continue }

            let ownerName = appName(for: pid)

            var displayID: String? = nil
            if let disp = SLSCopyManagedDisplayForWindow(cid, wid) {
                displayID = disp as String
            }

            let frame = ACElement.ACFrame(
                x: Int(bounds.origin.x),
                y: Int(bounds.origin.y),
                w: Int(bounds.size.width),
                h: Int(bounds.size.height)
            )

            let name = axWindowTitle(wid: wid, pid: pid)

            windows.append(WindowInfo(
                windowID: wid,
                ownerName: ownerName,
                ownerPID: pid,
                name: name,
                frame: frame,
                layer: Int(level),
                alpha: alpha,
                spaceIDs: spaceMap[wid] ?? [],
                isOnScreen: visible,
                windowType: Int(type),
                eventMask: eventMask,
                displayID: displayID
            ))
        }
        return windows
    }

    private static func axWindowTitle(wid: UInt32, pid: pid_t) -> String? {
        let app = AXUIElementCreateApplication(pid)
        var windows: CFTypeRef?
        AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
        guard let winArray = windows as? [AXUIElement] else { return nil }

        // Exact match via _AXUIElementGetWindow
        if let getWindow = _axGetWindow {
            for axWin in winArray {
                var axWid: UInt32 = 0
                if getWindow(axWin, &axWid) == 0 && axWid == wid {
                    var title: CFTypeRef?
                    AXUIElementCopyAttributeValue(axWin, kAXTitleAttribute as CFString, &title)
                    return title as? String
                }
            }
        }

        // Fallback: match by position
        var slsBounds = CGRect.zero
        SLSGetWindowBounds(cid, wid, &slsBounds)
        for axWin in winArray {
            var posValue: CFTypeRef?
            AXUIElementCopyAttributeValue(axWin, kAXPositionAttribute as CFString, &posValue)
            if let pv = posValue {
                var pos = CGPoint.zero
                AXValueGetValue(pv as! AXValue, .cgPoint, &pos)
                if abs(pos.x - slsBounds.origin.x) < 2 && abs(pos.y - slsBounds.origin.y) < 2 {
                    var title: CFTypeRef?
                    AXUIElementCopyAttributeValue(axWin, kAXTitleAttribute as CFString, &title)
                    return title as? String
                }
            }
        }
        return nil
    }

    private static func buildWindowSpaceMap() -> [UInt32: [UInt64]] {
        var map: [UInt32: [UInt64]] = [:]
        guard let displays = CGSCopyManagedDisplaySpaces(cid) as? [[String: Any]] else { return map }
        for display in displays {
            guard let spaces = display["Spaces"] as? [[String: Any]] else { continue }
            for space in spaces {
                guard let spaceID = space["id64"] as? UInt64 else { continue }
                if let windows = space["windows"] as? [UInt32] {
                    for wid in windows { map[wid, default: []].append(spaceID) }
                }
            }
        }
        return map
    }

    // MARK: - Spaces

    static func listSpaces() -> [SpaceInfo] {
        guard let displays = CGSCopyManagedDisplaySpaces(cid) as? [[String: Any]] else { return [] }
        var spaces: [SpaceInfo] = []
        for display in displays {
            let displayID = display["Display Identifier"] as? String ?? ""
            let currentSpaceDict = display["Current Space"] as? [String: Any]
            let currentSpaceID = currentSpaceDict?["id64"] as? UInt64 ?? 0
            guard let spaceList = display["Spaces"] as? [[String: Any]] else { continue }
            for space in spaceList {
                guard let spaceID = space["id64"] as? UInt64 else { continue }
                let typeNum = space["type"] as? Int ?? 0
                let type: String
                switch typeNum {
                case 0: type = "desktop"
                case 4: type = "fullscreen"
                default: type = "system"
                }
                spaces.append(SpaceInfo(
                    spaceID: spaceID, type: type, displayID: displayID,
                    isCurrent: spaceID == currentSpaceID,
                    uuid: space["uuid"] as? String
                ))
            }
        }
        return spaces
    }

    // MARK: - Window Actions

    static func focusWindow(_ wid: UInt32) -> Bool {
        let pid = pidForWindow(wid)
        guard pid > 0 else { return false }
        if let app = NSRunningApplication(processIdentifier: pid) { app.activate() }
        CGSOrderWindow(cid, wid, 1, 0)
        if let axWin = axWindowForID(wid, pid: pid) {
            AXUIElementPerformAction(axWin, kAXRaiseAction as CFString)
        }
        return true
    }

    /// 后台 focus：app 变 active 但窗口不 raise、不触发 Space 切换。
    /// 用 yabai 的 SkyLight SPI 方案（SLPSPostEventRecordTo 248 字节事件）。
    static func focusWindowBackground(_ wid: UInt32) -> Bool {
        let pid = pidForWindow(wid)
        guard pid > 0 else {
            BackgroundFocus.lastError = "pidForWindow=0 for wid=\(wid)"
            return false
        }
        return BackgroundFocus.activateWithoutRaise(
            targetPid: pid, targetWid: CGWindowID(wid)
        )
    }

    static func minimizeWindow(_ wid: UInt32) -> Bool {
        let pid = pidForWindow(wid)
        guard pid > 0, let axWin = axWindowForID(wid, pid: pid) else { return false }
        return AXUIElementSetAttributeValue(axWin, kAXMinimizedAttribute as CFString, true as CFBoolean) == .success
    }

    static func closeWindow(_ wid: UInt32) -> Bool {
        let pid = pidForWindow(wid)
        guard pid > 0, let axWin = axWindowForID(wid, pid: pid) else { return false }
        var closeButton: CFTypeRef?
        AXUIElementCopyAttributeValue(axWin, kAXCloseButtonAttribute as CFString, &closeButton)
        guard let button = closeButton else { return false }
        return AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString) == .success
    }

    static func setWindowAlpha(_ wid: UInt32, alpha: Float) -> Bool {
        CGSSetWindowAlpha(cid, wid, alpha) == .success
    }

    static func moveWindow(_ wid: UInt32, x: Int, y: Int) -> Bool {
        let pid = pidForWindow(wid)
        if pid > 0, let axWin = axWindowForID(wid, pid: pid) {
            var point = CGPoint(x: CGFloat(x), y: CGFloat(y))
            let value = AXValueCreate(.cgPoint, &point)!
            if AXUIElementSetAttributeValue(axWin, kAXPositionAttribute as CFString, value) == .success {
                return true
            }
        }
        var point = CGPoint(x: CGFloat(x), y: CGFloat(y))
        return SLSMoveWindow(cid, wid, &point) == 0
    }

    static func resizeWindow(_ wid: UInt32, w: Int, h: Int) -> Bool {
        let pid = pidForWindow(wid)
        guard pid > 0, let axWin = axWindowForID(wid, pid: pid) else { return false }
        var size = CGSize(width: CGFloat(w), height: CGFloat(h))
        let value = AXValueCreate(.cgSize, &size)!
        return AXUIElementSetAttributeValue(axWin, kAXSizeAttribute as CFString, value) == .success
    }

    static func moveWindowToSpace(_ wid: UInt32, spaceID: UInt64) -> Bool {
        CGSMoveWindowsToManagedSpace(cid, [wid] as CFArray, spaceID) == .success
    }

    static func pinToAllSpaces(_ wid: UInt32) -> Bool {
        guard let displays = CGSCopyManagedDisplaySpaces(cid) as? [[String: Any]] else { return false }
        var allSpaceIDs: [UInt64] = []
        for display in displays {
            guard let spaces = display["Spaces"] as? [[String: Any]] else { continue }
            for space in spaces {
                if let sid = space["id64"] as? UInt64 { allSpaceIDs.append(sid) }
            }
        }
        guard !allSpaceIDs.isEmpty else { return false }
        let windows = [wid] as CFArray
        let spaces = allSpaceIDs as CFArray
        return CGSAddWindowsToSpaces(cid, windows, spaces) == .success
    }

    static func unpinFromAllSpaces(_ wid: UInt32) -> Bool {
        guard let displays = CGSCopyManagedDisplaySpaces(cid) as? [[String: Any]] else { return false }
        var allSpaceIDs: [UInt64] = []
        for display in displays {
            guard let spaces = display["Spaces"] as? [[String: Any]] else { continue }
            for space in spaces {
                if let sid = space["id64"] as? UInt64 { allSpaceIDs.append(sid) }
            }
        }
        let windows = [wid] as CFArray
        // Remove from all, then add to current
        let currentSpace = SLSGetActiveSpace(cid)
        CGSRemoveWindowsFromSpaces(cid, windows, allSpaceIDs as CFArray)
        return CGSAddWindowsToSpaces(cid, windows, [currentSpace] as CFArray) == .success
    }

    static func switchToSpace(_ spaceID: UInt64) -> Bool {
        guard let displays = CGSCopyManagedDisplaySpaces(cid) as? [[String: Any]] else { return false }
        for display in displays {
            guard let spaces = display["Spaces"] as? [[String: Any]],
                  let displayID = display["Display Identifier"] as? String else { continue }
            for space in spaces {
                if space["id64"] as? UInt64 == spaceID {
                    return CGSManagedDisplaySetCurrentSpace(cid, displayID as CFString, spaceID) == .success
                }
            }
        }
        return false
    }

    // MARK: - SLS-Exclusive Operations

    static func setWindowTransform(_ wid: UInt32, transform: CGAffineTransform) -> Bool {
        CGSSetWindowTransform(cid, wid, transform) == .success
    }

    static func getWindowTransform(_ wid: UInt32) -> CGAffineTransform? {
        var t = CGAffineTransform.identity
        guard CGSGetWindowTransform(cid, wid, &t) == .success else { return nil }
        return t
    }

    /// Set event mask. mask=0 makes window click-through.
    static func setWindowEventMask(_ wid: UInt32, mask: UInt64) -> Bool {
        SLSSetWindowEventMask(cid, wid, mask) == 0
    }

    static func getWindowEventMask(_ wid: UInt32) -> UInt64? {
        var mask: UInt64 = 0
        guard SLSGetWindowEventMask(cid, wid, &mask) == 0 else { return nil }
        return mask
    }

    static func setWindowLevel(_ wid: UInt32, level: Int32) -> Bool {
        CGSSetWindowLevel(cid, wid, level) == .success
    }

    static func setWindowBlur(_ wid: UInt32, radius: Int32) -> Bool {
        CGSSetWindowBackgroundBlurRadius(cid, wid, radius) == .success
    }

    static func orderWindow(_ wid: UInt32, place: Int32, relativeTo: UInt32 = 0) -> Bool {
        CGSOrderWindow(cid, wid, place, relativeTo) == .success
    }

    // MARK: - Processes

    static func listProcesses(filter: String? = nil) -> [ProcessInfo_AC] {
        let apps = NSWorkspace.shared.runningApplications
        let windowCounts = countWindowsByPID()
        return apps.compactMap { app -> ProcessInfo_AC? in
            guard app.activationPolicy == .regular else { return nil }
            let name = app.localizedName ?? app.bundleURL?.lastPathComponent.replacingOccurrences(of: ".app", with: "") ?? "unknown"
            if let f = filter?.lowercased() {
                let matchName = name.lowercased().contains(f)
                let matchBundle = app.bundleIdentifier?.lowercased().contains(f) ?? false
                guard matchName || matchBundle else { return nil }
            }
            return ProcessInfo_AC(
                pid: app.processIdentifier, name: name,
                bundleID: app.bundleIdentifier, isActive: app.isActive,
                isHidden: app.isHidden, windowCount: windowCounts[app.processIdentifier] ?? 0
            )
        }
    }

    static func processInfo(pid: pid_t) -> ProcessInfo_AC? {
        let apps = NSWorkspace.shared.runningApplications
        guard let app = apps.first(where: { $0.processIdentifier == pid }) else { return nil }
        let windowCounts = countWindowsByPID()
        return ProcessInfo_AC(
            pid: app.processIdentifier, name: app.localizedName ?? "unknown",
            bundleID: app.bundleIdentifier, isActive: app.isActive,
            isHidden: app.isHidden, windowCount: windowCounts[pid] ?? 0
        )
    }

    private static func countWindowsByPID() -> [pid_t: Int] {
        var counts: [pid_t: Int] = [:]
        for wid in onScreenWindowIDs() {
            let pid = pidForWindow(wid)
            guard pid > 0 else { continue }
            var level: Int32 = 0
            CGSGetWindowLevel(cid, wid, &level)
            if level == 0 { counts[pid, default: 0] += 1 }
        }
        return counts
    }

    // MARK: - TCC / Doctor

    static func checkPermissions() -> [TCCStatus] {
        let checks: [(service: String, display: String, required: Bool)] = [
            ("kTCCServiceAccessibility", "Accessibility", true),
            ("kTCCServiceScreenCapture", "Screen Recording", true),
            ("kTCCServiceSystemPolicyAllFiles", "Full Disk Access", false),
            ("kTCCServiceListenEvent", "Input Monitoring", false),
            ("kTCCServicePostEvent", "Automation (PostEvent)", false),
        ]
        return checks.map { check in
            let result = tccAccessPreflight(check.service)
            let status: String
            switch result {
            case 0: status = "authorized"
            case 1: status = "limited"
            case 2: status = "denied"
            default: status = "not_determined"
            }
            return TCCStatus(service: check.service, displayName: check.display, status: status, required: check.required)
        }
    }

    // MARK: - AX Fallback

    static func fallbackSnapshot(appPID: pid_t? = nil) -> [ACElement] {
        let windows = listWindows(forPID: appPID)
        var counter = 0
        return windows.compactMap { win -> ACElement? in
            guard win.isOnScreen, win.layer == 0 else { return nil }
            counter += 1
            return ACElement(
                ref: "@e\(counter)", role: "Window",
                label: "\(win.ownerName) — \(win.name ?? "")",
                value: "windowID:\(win.windowID)",
                frame: win.frame, interactive: true, children: nil
            )
        }
    }

    // MARK: - Window Lookup Helpers

    /// Get the first layer-0 (content) window ID for a given PID.
    static func firstWindowID(forPID pid: pid_t) -> UInt32? {
        let wins = listWindows(forPID: pid)
        return wins.first(where: { $0.layer == 0 })?.windowID
    }

    /// Check if a window is minimized via AX.
    static func isMinimized(_ wid: UInt32) -> Bool {
        let pid = pidForWindow(wid)
        guard pid > 0, let axWin = axWindowForID(wid, pid: pid) else { return false }
        var value: CFTypeRef?
        AXUIElementCopyAttributeValue(axWin, kAXMinimizedAttribute as CFString, &value)
        return (value as? Bool) == true
    }

    /// Deminiaturize (un-minimize) a window via AX.
    static func deminiaturizeWindow(_ wid: UInt32) -> Bool {
        let pid = pidForWindow(wid)
        guard pid > 0, let axWin = axWindowForID(wid, pid: pid) else { return false }
        return AXUIElementSetAttributeValue(axWin, kAXMinimizedAttribute as CFString, false as CFBoolean) == .success
    }

    // MARK: - Desktop Overview

    struct DesktopOverview: Encodable {
        let frontmostApp: String?
        let frontmostPID: Int32?
        let runningApps: [RunningAppInfo]
        let windows: [WindowSummary]
        let menuExtras: [String]
        let spaces: [SpaceInfo]
        let currentSpaceID: UInt64?
    }

    struct RunningAppInfo: Encodable {
        let name: String
        let bundleID: String?
        let pid: Int32
        let isActive: Bool
        let isHidden: Bool
        let windowCount: Int
        let ownsMenuBar: Bool
    }

    struct WindowSummary: Encodable {
        let windowID: UInt32
        let app: String
        let title: String?
        let frame: ACElement.ACFrame
        let isActive: Bool
        let spaceID: UInt64?
    }

    /// One-shot desktop state: frontmost app, all windows, running apps, menu extras, spaces.
    static func desktopOverview() -> DesktopOverview {
        let frontApp = NSWorkspace.shared.frontmostApplication
        let windowCounts = countWindowsByPID()

        // Running apps (Dock-visible = activationPolicy .regular)
        let apps = NSWorkspace.shared.runningApplications
        let runningApps: [RunningAppInfo] = apps.compactMap { app in
            guard app.activationPolicy == .regular else { return nil }
            let name = app.localizedName ?? app.bundleURL?.lastPathComponent.replacingOccurrences(of: ".app", with: "") ?? "unknown"
            return RunningAppInfo(
                name: name,
                bundleID: app.bundleIdentifier,
                pid: app.processIdentifier,
                isActive: app.isActive,
                isHidden: app.isHidden,
                windowCount: windowCounts[app.processIdentifier] ?? 0,
                ownsMenuBar: app.ownsMenuBar
            )
        }

        // Visible windows (layer 0, on screen)
        let allWindows = listWindows()
        let windowSummaries: [WindowSummary] = allWindows.map { w in
            WindowSummary(
                windowID: w.windowID,
                app: w.ownerName,
                title: w.name,
                frame: w.frame,
                isActive: w.ownerPID == (frontApp?.processIdentifier ?? -1),
                spaceID: w.spaceIDs.first
            )
        }

        // Menu bar extras (right side icons)
        let menuExtras = getMenuExtras()

        // Spaces
        let spaces = listSpaces()
        let currentSpace = spaces.first(where: { $0.isCurrent })?.spaceID

        return DesktopOverview(
            frontmostApp: frontApp?.localizedName,
            frontmostPID: frontApp?.processIdentifier,
            runningApps: runningApps,
            windows: windowSummaries,
            menuExtras: menuExtras,
            spaces: spaces,
            currentSpaceID: currentSpace
        )
    }

    /// Read menu bar extras via AX — scans ControlCenter + SystemUIServer processes
    private static func getMenuExtras() -> [String] {
        let targetBundles = ["com.apple.controlcenter", "com.apple.systemuiserver"]
        var names: [String] = []

        for bundleID in targetBundles {
            guard let serverApp = NSWorkspace.shared.runningApplications.first(where: {
                $0.bundleIdentifier == bundleID
            }) else { continue }

            let app = AXUIElementCreateApplication(serverApp.processIdentifier)

            // Try AXExtrasMenuBar first (macOS 13+), then regular menu bar
            var menuBar: CFTypeRef?
            AXUIElementCopyAttributeValue(app, "AXExtrasMenuBar" as CFString, &menuBar)
            if menuBar == nil {
                AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &menuBar)
            }
            guard let bar = menuBar else { continue }

            var children: CFTypeRef?
            AXUIElementCopyAttributeValue(bar as! AXUIElement, kAXChildrenAttribute as CFString, &children)
            guard let items = children as? [AXUIElement] else { continue }

            for item in items {
                // Try title first, then description (AXDescription), then role description
                var title: CFTypeRef?
                AXUIElementCopyAttributeValue(item, kAXTitleAttribute as CFString, &title)
                if let t = title as? String, !t.isEmpty {
                    names.append(t)
                    continue
                }
                var desc: CFTypeRef?
                AXUIElementCopyAttributeValue(item, kAXDescriptionAttribute as CFString, &desc)
                if let d = desc as? String, !d.isEmpty {
                    names.append(d)
                    continue
                }
                // Last resort: check value (e.g. clock shows time as value)
                var value: CFTypeRef?
                AXUIElementCopyAttributeValue(item, kAXValueAttribute as CFString, &value)
                if let v = value as? String, !v.isEmpty {
                    names.append(v)
                }
            }
        }
        return names
    }

    // MARK: - Helpers

    private static func axWindowForID(_ targetWID: UInt32, pid: pid_t? = nil) -> AXUIElement? {
        let resolvedPID = pid ?? pidForWindow(targetWID)
        guard resolvedPID > 0 else { return nil }

        let app = AXUIElementCreateApplication(resolvedPID)
        var windows: CFTypeRef?
        AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
        guard let winArray = windows as? [AXUIElement] else { return nil }

        if let getWindow = _axGetWindow {
            for axWin in winArray {
                var axWid: UInt32 = 0
                if getWindow(axWin, &axWid) == 0 && axWid == targetWID { return axWin }
            }
        }

        var slsBounds = CGRect.zero
        SLSGetWindowBounds(cid, targetWID, &slsBounds)
        for axWin in winArray {
            var posValue: CFTypeRef?
            AXUIElementCopyAttributeValue(axWin, kAXPositionAttribute as CFString, &posValue)
            if let pv = posValue {
                var pos = CGPoint.zero
                AXValueGetValue(pv as! AXValue, .cgPoint, &pos)
                if abs(pos.x - slsBounds.origin.x) < 2 && abs(pos.y - slsBounds.origin.y) < 2 { return axWin }
            }
        }
        return winArray.first
    }
}
