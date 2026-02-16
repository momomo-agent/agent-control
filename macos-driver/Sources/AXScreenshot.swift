import Foundation
import ApplicationServices
import ScreenCaptureKit

// MARK: - Screenshot

enum AXScreenshot {

    /// Full screen screenshot
    static func fullScreen(output: String) async -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        task.arguments = ["-x", output]
        do {
            try task.run()
            task.waitUntilExit()
            return task.terminationStatus == 0
        } catch {
            fputs("error: screenshot failed: \(error)\n", stderr)
            return false
        }
    }

    /// Element region screenshot
    static func element(ref: String, output: String, appPID: pid_t? = nil) async -> Bool {
        guard let el = AXActions.findElement(ref: ref, appPID: appPID) else {
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
