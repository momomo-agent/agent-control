import Foundation
import ApplicationServices
import ScreenCaptureKit

// MARK: - Screenshot

enum AXScreenshot {

    /// Full screen screenshot (or window if PID provided)
    static func fullScreen(output: String, appPID: pid_t? = nil) async -> Bool {
        // If PID given, capture that app's window
        if let pid = appPID, let wid = windowID(for: pid) {
            return capture(["-x", "-o", "-l", String(wid), output])
        }
        // Fallback: full screen
        return capture(["-x", output])
    }

    /// Get the CGWindowID for an app's main window
    private static func windowID(for pid: pid_t) -> CGWindowID? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for win in list {
            guard let ownerPID = win[kCGWindowOwnerPID as String] as? pid_t,
                  let wid = win[kCGWindowNumber as String] as? CGWindowID,
                  ownerPID == pid,
                  let layer = win[kCGWindowLayer as String] as? Int, layer == 0
            else { continue }
            return wid
        }
        return nil
    }

    private static func capture(_ args: [String]) -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        task.arguments = args
        do {
            try task.run()
            task.waitUntilExit()
            return task.terminationStatus == 0
        } catch {
            fputs("error: screenshot failed: \(error)\n", stderr)
            return false
        }
    }

    /// Element region screenshot.
    ///
    /// Uses `AXScanner.findUIElement` which mirrors `snapshot(...)` numbering,
    /// so refs like `@e730` resolve correctly. The previous walker had its own
    /// predicate that only counted `clickableRoles`, drifting from snapshot refs
    /// that also include content roles (StaticText / Image / Heading / Group).
    static func element(ref: String, output: String, appPID: pid_t? = nil) async -> Bool {
        guard let el = AXScanner.findUIElement(ref: ref, appPID: appPID) else {
            fputs("error: element \(ref) not found\n", stderr)
            return false
        }

        var posValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posValue)
        AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeValue)
        guard let pv = posValue, let sv = sizeValue else {
            fputs("error: cannot get element frame\n", stderr)
            return false
        }
        var pos = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(pv as! AXValue, .cgPoint, &pos)
        AXValueGetValue(sv as! AXValue, .cgSize, &size)

        if size.width < 1 || size.height < 1 {
            fputs("error: element \(ref) has zero frame (pos=\(pos) size=\(size))\n", stderr)
            return false
        }

        // screencapture -R uses global display points, same unit AX returns.
        let rect = "\(Int(pos.x)),\(Int(pos.y)),\(Int(size.width)),\(Int(size.height))"
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        task.arguments = ["-x", "-R", rect, output]
        do {
            try task.run()
            task.waitUntilExit()
            return task.terminationStatus == 0
        } catch {
            fputs("error: screenshot failed: \(error)\n", stderr)
            return false
        }
    }
}
