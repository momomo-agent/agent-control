import Foundation
import AppKit

// MARK: - Helpers

/// Check if a string is a ref (either "@e3" or "e3")
func isRef(_ s: String) -> Bool {
    if s.hasPrefix("@e") { return Int(s.dropFirst(2)) != nil }
    if s.hasPrefix("e") { return Int(s.dropFirst(1)) != nil }
    return false
}

// MARK: - CLI Entry Point

@main
struct AgentControl {
    static func main() async {
        let rawArgs = Array(CommandLine.arguments.dropFirst())

        // Special：daemon 内部入口（由 spawnDaemon() 自己调自己）。
        // 不能正常走 command 分发 —— 需要运行 NSApp。
        if rawArgs.first == "cursor-daemon-run" {
            CursorDaemon.runServer()  // never returns
        }

        let args = rawArgs

        // Extract command: skip flags (--pid X, --app X, -i)
        let flagsWithValue: Set<String> = ["--pid", "--app"]
        let flagsNoValue: Set<String> = ["-i"]
        var command: String? = nil
        var commandIdx = 0
        var idx = 0
        while idx < args.count {
            if flagsWithValue.contains(args[idx]) {
                idx += 2 // skip flag + value
            } else if flagsNoValue.contains(args[idx]) {
                idx += 1
            } else {
                command = args[idx]
                commandIdx = idx
                break
            }
        }

        // cmdArgs: arguments after the command, with flags stripped
        var cmdArgs: [String] = []
        var j = commandIdx + 1
        while j < args.count {
            if flagsWithValue.contains(args[j]) {
                j += 2
            } else if flagsNoValue.contains(args[j]) {
                j += 1
            } else {
                cmdArgs.append(args[j])
                j += 1
            }
        }

        guard let command else {
            printUsage()
            exit(1)
        }

        let pid = parsePID(args)

        switch command {
        case "snapshot":
            let interactive = args.contains("-i")
            let fallback = args.contains("--fallback")
            var elements = AXScanner.snapshot(appPID: pid)
            // AX fallback: if AX returns nothing, use CGWindowList
            if elements.isEmpty || fallback {
                let fbElements = WindowManager.fallbackSnapshot(appPID: pid)
                if elements.isEmpty {
                    elements = fbElements
                    fputs("info: AX tree empty, using CGWindowList fallback (\(elements.count) windows)\n", stderr)
                }
            }
            let output = interactive ? elements.filter { $0.interactive } : elements
            printJSON(output)

        case "click":
            let ref = cmdArgs.first(where: { isRef($0) })
            let nums = cmdArgs.compactMap { Double($0) }
            let btn = cmdArgs.contains("--right") ? "right" : "left"
            let bg = cmdArgs.contains("--bg") || cmdArgs.contains("--background") || cmdArgs.contains("--focus-guard") || args.contains("--focus-guard")
            if let ref = ref {
                let ok: Bool
                if bg {
                    ok = btn == "right"
                        ? AXActions.rightclickBackground(ref: ref, appPID: pid)
                        : AXActions.clickBackground(ref: ref, appPID: pid)
                } else {
                    ok = btn == "right"
                        ? AXActions.rightclick(ref: ref, appPID: pid)
                        : AXActions.click(ref: ref, appPID: pid)
                }
                printResult(ok, action: "click", ref: ref)
            } else if nums.count >= 2 {
                if bg {
                    fputs("error: --bg / --focus-guard requires AX ref, coordinate mode not supported\n", stderr)
                    exit(1)
                }
                let ok = AXActions.clickAt(x: CGFloat(nums[0]), y: CGFloat(nums[1]), button: btn)
                printResult(ok, action: "click", ref: "\(Int(nums[0])),\(Int(nums[1]))")
            } else {
                fputs("error: usage: click @ref [--bg] [--right] | click x y\n", stderr)
                exit(1)
            }

        case "dblclick":
            guard let ref = cmdArgs.first(where: { isRef($0) }) else {
                fputs("error: missing ref\n", stderr)
                exit(1)
            }
            let bg = cmdArgs.contains("--bg") || cmdArgs.contains("--background") || cmdArgs.contains("--focus-guard") || args.contains("--focus-guard")
            let ok = bg
                ? AXActions.dblclickBackground(ref: ref, appPID: pid)
                : AXActions.dblclick(ref: ref, appPID: pid)
            printResult(ok, action: "dblclick", ref: ref)

        case "rightclick":
            guard let ref = cmdArgs.first(where: { isRef($0) }) else {
                fputs("error: missing ref\n", stderr)
                exit(1)
            }
            let bg = cmdArgs.contains("--bg") || cmdArgs.contains("--background") || cmdArgs.contains("--focus-guard") || args.contains("--focus-guard")
            let ok = bg
                ? AXActions.rightclickBackground(ref: ref, appPID: pid)
                : AXActions.rightclick(ref: ref, appPID: pid)
            printResult(ok, action: "rightclick", ref: ref)

        case "fill":
            guard let ref = cmdArgs.first(where: { isRef($0) }) else {
                fputs("error: missing ref\n", stderr)
                exit(1)
            }
            // Text is everything after the ref in cmdArgs
            let refIdx = cmdArgs.firstIndex(of: ref)!
            let textParts = cmdArgs.suffix(from: cmdArgs.index(after: refIdx)).filter { !$0.hasPrefix("--") }
            let text = textParts.joined(separator: " ")
            guard !text.isEmpty else {
                fputs("error: missing text argument\n", stderr)
                exit(1)
            }
            let bg = cmdArgs.contains("--bg") || cmdArgs.contains("--background") || cmdArgs.contains("--focus-guard") || args.contains("--focus-guard")
            let ok = bg
                ? AXActions.fillBackground(ref: ref, text: text, appPID: pid)
                : AXActions.fill(ref: ref, text: text, appPID: pid)
            printResult(ok, action: "fill", ref: ref)

        case "press":
            // Accept two forms:
            //   press cmd+shift+a               (preferred, modern)
            //   press a --modifiers cmd,shift   (legacy, test-compat)
            // Find the first non-flag arg — that's the key.
            var keyArg: String? = nil
            var i = 0
            while i < cmdArgs.count {
                let a = cmdArgs[i]
                if a == "--modifiers" || a == "--mod" { i += 2; continue }
                if a.hasPrefix("--") { i += 1; continue }
                keyArg = a
                break
            }
            guard var key = keyArg else {
                fputs("error: missing key\n", stderr)
                exit(1)
            }
            // Fold --modifiers cmd,shift into cmd+shift+<key>
            if let mi = cmdArgs.firstIndex(where: { $0 == "--modifiers" || $0 == "--mod" }),
               mi + 1 < cmdArgs.count {
                let mods = cmdArgs[mi + 1].split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }
                if !mods.isEmpty && !key.contains("+") {
                    key = mods.joined(separator: "+") + "+" + key
                }
            }
            let ok = AXActions.press(key: key)
            printResult(ok, action: "press", ref: key)

        case "longpress":
            let ref = cmdArgs.first(where: { isRef($0) })
            let nums = cmdArgs.compactMap { Double($0) }
            let durationArg = cmdArgs.first(where: { $0.hasPrefix("--duration=") })
            let durationMs = durationArg.flatMap { Double($0.dropFirst("--duration=".count)) } ?? 1000.0
            let duration = durationMs / 1000.0
            if let ref = ref {
                let ok = AXActions.longpress(ref: ref, duration: duration, appPID: pid)
                printResult(ok, action: "longpress", ref: ref)
            } else if nums.count >= 2 {
                let ok = AXActions.longpressAt(x: CGFloat(nums[0]), y: CGFloat(nums[1]), duration: duration)
                printResult(ok, action: "longpress", ref: "\(Int(nums[0])),\(Int(nums[1]))")
            } else {
                fputs("error: usage: longpress @ref | longpress x y [--duration=1000]\n", stderr)
                exit(1)
            }

        case "drag":
            let refs = cmdArgs.filter { isRef($0) }
            let nums = cmdArgs.compactMap { Double($0) }
            if refs.count == 2 {
                let ok = AXActions.drag(fromRef: refs[0], toRef: refs[1], appPID: pid)
                printResult(ok, action: "drag", ref: "\(refs[0]) → \(refs[1])")
            } else if nums.count >= 4 {
                let ok = AXActions.dragCoord(x1: CGFloat(nums[0]), y1: CGFloat(nums[1]), x2: CGFloat(nums[2]), y2: CGFloat(nums[3]))
                printResult(ok, action: "drag", ref: "\(Int(nums[0])),\(Int(nums[1])) → \(Int(nums[2])),\(Int(nums[3]))")
            } else {
                fputs("error: usage: drag @from @to | drag x1 y1 x2 y2\n", stderr)
                exit(1)
            }

        case "scroll":
            let dir = cmdArgs.first ?? "down"
            let amount = cmdArgs.count > 1 ? Int32(cmdArgs[1]) ?? 100 : 100
            let ok = AXActions.scroll(direction: dir, amount: amount)
            printResult(ok, action: "scroll", ref: "\(dir) \(amount)")

        case "screenshot":
            let ref = cmdArgs.first(where: { isRef($0) })
            let output = cmdArgs.first(where: { !isRef($0) && !$0.hasPrefix("--") }) ?? "/tmp/agent-control-screenshot.png"
            let allowFull = cmdArgs.contains("--full") || args.contains("--full")

            let ok: Bool
            if let ref = ref {
                ok = await AXScreenshot.element(ref: ref, output: output, appPID: pid)
            } else if pid != nil {
                // App-scoped capture: background-friendly, window-only
                ok = await AXScreenshot.fullScreen(output: output, appPID: pid)
            } else if allowFull {
                // Explicit full-screen opt-in
                fputs("info: full-screen capture (--full)\n", stderr)
                ok = await AXScreenshot.fullScreen(output: output, appPID: nil)
            } else {
                fputs("error: screenshot requires --app <name> (preferred) or --full for full-screen capture\n", stderr)
                fputs("hint: agent-control -p macos --app Finder screenshot /tmp/out.png\n", stderr)
                printResult(false, action: "screenshot", ref: "no-app")
                exit(1)
            }
            if ok {
                let result: [String: Any] = ["ok": true, "path": output]
                if let data = try? JSONSerialization.data(withJSONObject: result),
                   let str = String(data: data, encoding: .utf8) {
                    print(str)
                }
            } else {
                printResult(false, action: "screenshot", ref: ref ?? "fullscreen")
            }

        case "console", "logs":
            let processName = cmdArgs.first(where: { !$0.hasPrefix("--") && Int($0) == nil })
            let countStr = cmdArgs.first(where: { Int($0) != nil })
            let limit = countStr.flatMap { Int($0) } ?? 50
            
            var predicates: [String] = []
            if let pn = processName {
                predicates.append("process == \"\(pn)\"")
            } else if let p = pid {
                predicates.append("processID == \(p)")
            }
            if cmdArgs.contains("--error") {
                predicates.append("(messageType == error || messageType == fault)")
            } else if cmdArgs.contains("--fault") {
                predicates.append("messageType == fault")
            }
            
            let levelFlag = cmdArgs.contains("--debug") ? "--level debug" : "--level info"
            var logCmd = "timeout 2 /usr/bin/log stream --style compact \(levelFlag)"
            if !predicates.isEmpty {
                logCmd += " --predicate '\(predicates.joined(separator: " && "))'"
            }
            
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/zsh")
            task.arguments = ["-c", logCmd]
            let pipe = Pipe()
            task.standardOutput = pipe
            task.standardError = Pipe()
            do {
                try task.run()
                task.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8) ?? ""
                var lines = output.split(separator: "\n").filter { !$0.hasPrefix("Timestamp") && !$0.isEmpty }.map(String.init)
                lines = Array(lines.suffix(limit))
                let result: [String: Any] = ["ok": true, "action": "console", "count": lines.count, "entries": lines]
                if let jsonData = try? JSONSerialization.data(withJSONObject: result),
                   let str = String(data: jsonData, encoding: .utf8) {
                    print(str)
                }
            } catch {
                let result: [String: Any] = ["ok": false, "error": error.localizedDescription]
                if let jsonData = try? JSONSerialization.data(withJSONObject: result),
                   let str = String(data: jsonData, encoding: .utf8) {
                    print(str)
                }
            }

        // ── Window Management ──

        case "windows":
            let windows = WindowManager.listWindows(forPID: pid)
            printJSON(windows)

        case "focus":
            guard let widStr = cmdArgs.first, let wid = UInt32(widStr) else {
                fputs("error: usage: focus <windowID>\n", stderr)
                exit(1)
            }
            let ok = WindowManager.focusWindow(wid)
            printResult(ok, action: "focus", ref: widStr)

        case "focus-bg":
            guard let widStr = cmdArgs.first, let wid = UInt32(widStr) else {
                fputs("error: usage: focus-bg <windowID>\n", stderr)
                exit(1)
            }
            let ok = WindowManager.focusWindowBackground(wid)
            var meta: [String: Any] = [
                "spi_available": BackgroundFocus.isFocusWithoutRaiseAvailable,
                "auth_post_available": BackgroundFocus.isAuthPostAvailable
            ]
            if !BackgroundFocus.lastError.isEmpty {
                meta["last_error"] = BackgroundFocus.lastError
            }
            printResult(ok, action: "focus-bg", ref: widStr, extra: meta)

        case "bg-focus":
            guard let targetPID = pid else {
                fputs("error: bg-focus requires --pid or --app\n", stderr)
                exit(1)
            }
            let wid = cmdArgs.first.flatMap { UInt32($0) }
                ?? WindowManager.firstWindowID(forPID: targetPID)
                ?? 0
            let ok = BackgroundFocus.activateWithoutRaise(
                targetPid: targetPID, targetWid: CGWindowID(wid)
            )
            var meta: [String: Any] = [
                "spi_available": BackgroundFocus.isFocusWithoutRaiseAvailable,
                "windowID": wid
            ]
            if !BackgroundFocus.lastError.isEmpty {
                meta["last_error"] = BackgroundFocus.lastError
            }
            printResult(ok, action: "bg-focus", ref: "\(targetPID)", extra: meta)

        case "bg-defocus":
            guard let targetPID = pid else {
                fputs("error: bg-defocus requires --pid or --app\n", stderr)
                exit(1)
            }
            let ok = BackgroundFocus.defocusWithoutRaise(targetPid: targetPID)
            var meta: [String: Any] = [:]
            if !BackgroundFocus.lastError.isEmpty {
                meta["last_error"] = BackgroundFocus.lastError
            }
            printResult(ok, action: "bg-defocus", ref: "\(targetPID)", extra: meta)

        case "bg-click":
            guard let targetPID = pid else {
                fputs("error: bg-click requires --pid or --app\n", stderr)
                exit(1)
            }
            let nums = cmdArgs.compactMap { Double($0) }
            guard nums.count >= 2 else {
                fputs("error: usage: bg-click x y [--button left|right]\n", stderr)
                exit(1)
            }
            let btn: CGMouseButton = cmdArgs.contains("--right") ? .right : .left
            let wid = cmdArgs.first(where: { $0.hasPrefix("--window=") })
                .flatMap { CGWindowID($0.dropFirst("--window=".count)) }
            let ok = BackgroundFocus.bgClick(
                pid: targetPID, windowID: wid,
                x: CGFloat(nums[0]), y: CGFloat(nums[1]), button: btn
            )
            printResult(ok, action: "bg-click", ref: "\(Int(nums[0])),\(Int(nums[1]))")

        case "bg-type":
            guard let targetPID = pid else {
                fputs("error: bg-type requires --pid or --app\n", stderr)
                exit(1)
            }
            let text = cmdArgs.joined(separator: " ")
            guard !text.isEmpty else {
                fputs("error: usage: bg-type <text>\n", stderr)
                exit(1)
            }
            let ok = BackgroundFocus.bgType(pid: targetPID, text: text)
            printResult(ok, action: "bg-type", ref: text)

        case "bg-press":
            guard let targetPID = pid else {
                fputs("error: bg-press requires --pid or --app\n", stderr)
                exit(1)
            }
            guard let key = cmdArgs.first else {
                fputs("error: usage: bg-press <key>\n", stderr)
                exit(1)
            }
            let ok = BackgroundFocus.bgPress(pid: targetPID, key: key)
            printResult(ok, action: "bg-press", ref: key)

        case "bg-act":
            // Combo: bg-focus + action + bg-defocus
            guard let targetPID = pid else {
                fputs("error: bg-act requires --pid or --app\n", stderr)
                exit(1)
            }
            guard let subCmd = cmdArgs.first else {
                fputs("error: usage: bg-act <click|type|press> ...\n", stderr)
                exit(1)
            }
            let subArgs = Array(cmdArgs.dropFirst())
            let wid = WindowManager.firstWindowID(forPID: targetPID) ?? 0
            BackgroundFocus.activateWithoutRaise(targetPid: targetPID, targetWid: CGWindowID(wid))
            usleep(50_000)
            var ok = false
            switch subCmd {
            case "click":
                let nums = subArgs.compactMap { Double($0) }
                if nums.count >= 2 {
                    let btn: CGMouseButton = subArgs.contains("--right") ? .right : .left
                    ok = BackgroundFocus.bgClick(pid: targetPID, x: CGFloat(nums[0]), y: CGFloat(nums[1]), button: btn)
                } else {
                    fputs("error: bg-act click x y\n", stderr)
                    exit(1)
                }
            case "type":
                let text = subArgs.joined(separator: " ")
                guard !text.isEmpty else { fputs("error: bg-act type <text>\n", stderr); exit(1) }
                ok = BackgroundFocus.bgType(pid: targetPID, text: text)
            case "press":
                guard let key = subArgs.first else { fputs("error: bg-act press <key>\n", stderr); exit(1) }
                ok = BackgroundFocus.bgPress(pid: targetPID, key: key)
            default:
                fputs("error: unknown bg-act sub-command '\(subCmd)'\n", stderr)
                exit(1)
            }
            usleep(50_000)
            BackgroundFocus.defocusWithoutRaise(targetPid: targetPID)
            printResult(ok, action: "bg-act", ref: "\(subCmd) \(subArgs.joined(separator: " "))")

        case "stealth-act":
            guard let targetPID = pid else {
                fputs("error: stealth-act requires --pid or --app\n", stderr)
                exit(1)
            }
            guard let subCmd = cmdArgs.first else {
                fputs("error: usage: stealth-act <snapshot|click|type|press> ...\n", stderr)
                exit(1)
            }
            guard let wid = WindowManager.firstWindowID(forPID: targetPID) else {
                fputs("error: no window found for pid \(targetPID)\n", stderr)
                exit(1)
            }
            let subArgs = Array(cmdArgs.dropFirst())
            let ok = BackgroundFocus.stealthAct(pid: targetPID, windowID: wid) {
                switch subCmd {
                case "snapshot":
                    let elements = AXScanner.snapshot(appPID: targetPID)
                    printJSON(elements)
                    return !elements.isEmpty
                case "click":
                    let ref = subArgs.first(where: { isRef($0) })
                    let nums = subArgs.compactMap { Double($0) }
                    if let ref = ref {
                        return AXActions.click(ref: ref, appPID: targetPID)
                    } else if nums.count >= 2 {
                        return AXActions.clickAt(x: CGFloat(nums[0]), y: CGFloat(nums[1]))
                    }
                    return false
                case "type":
                    let text = subArgs.joined(separator: " ")
                    return BackgroundFocus.bgType(pid: targetPID, text: text)
                case "press":
                    if let key = subArgs.first {
                        return BackgroundFocus.bgPress(pid: targetPID, key: key)
                    }
                    return false
                default:
                    fputs("error: unknown stealth-act sub-command '\(subCmd)'\n", stderr)
                    return false
                }
            }
            if subCmd != "snapshot" { // snapshot already printed its own JSON
                printResult(ok, action: "stealth-act", ref: "\(subCmd)")
            }

        case "move-to-space":
            guard cmdArgs.count >= 2,
                  let wid = UInt32(cmdArgs[0]),
                  let spaceID = UInt64(cmdArgs[1]) else {
                fputs("error: usage: move-to-space <windowID> <spaceID>\n", stderr)
                exit(1)
            }
            let ok = WindowManager.moveWindowToSpace(wid, spaceID: spaceID)
            printResult(ok, action: "move-to-space", ref: "\(wid)→\(spaceID)")

        case "pin":
            guard let widStr = cmdArgs.first, let wid = UInt32(widStr) else {
                fputs("error: usage: pin <windowID>\n", stderr)
                exit(1)
            }
            let ok = WindowManager.pinToAllSpaces(wid)
            printResult(ok, action: "pin", ref: widStr)

        case "unpin":
            guard let widStr = cmdArgs.first, let wid = UInt32(widStr) else {
                fputs("error: usage: unpin <windowID>\n", stderr)
                exit(1)
            }
            let ok = WindowManager.unpinFromAllSpaces(wid)
            printResult(ok, action: "unpin", ref: widStr)

        case "alpha":
            guard cmdArgs.count >= 2,
                  let wid = UInt32(cmdArgs[0]),
                  let alpha = Float(cmdArgs[1]) else {
                fputs("error: usage: alpha <windowID> <0.0-1.0>\n", stderr)
                exit(1)
            }
            let ok = WindowManager.setWindowAlpha(wid, alpha: alpha)
            printResult(ok, action: "alpha", ref: "\(wid)=\(alpha)")

        case "blur":
            guard cmdArgs.count >= 2,
                  let wid = UInt32(cmdArgs[0]),
                  let radius = Int32(cmdArgs[1]) else {
                fputs("error: usage: blur <windowID> <radius>\n", stderr)
                exit(1)
            }
            let ok = WindowManager.setWindowBlur(wid, radius: radius)
            printResult(ok, action: "blur", ref: "\(wid)=\(radius)")

        case "minimize":
            guard let widStr = cmdArgs.first, let wid = UInt32(widStr) else {
                fputs("error: usage: minimize <windowID>\n", stderr)
                exit(1)
            }
            let ok = WindowManager.minimizeWindow(wid)
            printResult(ok, action: "minimize", ref: widStr)

        case "close-window":
            guard let widStr = cmdArgs.first, let wid = UInt32(widStr) else {
                fputs("error: usage: close-window <windowID>\n", stderr)
                exit(1)
            }
            let ok = WindowManager.closeWindow(wid)
            printResult(ok, action: "close-window", ref: widStr)

        // ── Spaces ──

        case "spaces":
            let spaces = WindowManager.listSpaces()
            printJSON(spaces)

        case "switch-space":
            guard let sidStr = cmdArgs.first, let spaceID = UInt64(sidStr) else {
                fputs("error: usage: switch-space <spaceID>\n", stderr)
                exit(1)
            }
            let ok = WindowManager.switchToSpace(spaceID)
            printResult(ok, action: "switch-space", ref: sidStr)

        // ── Processes ──

        case "processes":
            let procs = WindowManager.listProcesses()
            printJSON(procs)

        case "process":
            if let targetPID = pid ?? cmdArgs.first.flatMap({ pid_t($0) }) {
                if let info = WindowManager.processInfo(pid: targetPID) {
                    printJSON(info)
                } else {
                    fputs("error: process \(targetPID) not found\n", stderr)
                    exit(1)
                }
            } else if let name = cmdArgs.first {
                // Find by name
                let procs = WindowManager.listProcesses()
                let nameLower = name.lowercased()
                let matches = procs.filter {
                    $0.name.lowercased().contains(nameLower) ||
                    ($0.bundleID?.lowercased().contains(nameLower) ?? false)
                }
                printJSON(matches)
            } else {
                fputs("error: usage: process <pid|name>\n", stderr)
                exit(1)
            }

        // ── Desktop Overview ──

        case "desktop":
            if let target = cmdArgs.first {
                // Drill-down mode: look into a specific window or tray item
                if let wid = UInt32(target) {
                    // By window ID — snapshot that window's app
                    let winPid = WindowManager.pidForWindow(wid)
                    guard winPid > 0 else {
                        fputs("error: window \(wid) not found\n", stderr)
                        exit(1)
                    }
                    let elements = AXScanner.snapshot(appPID: winPid)
                    printJSON(elements)
                } else {
                    // By name — could be an app name or a tray item
                    let nameLower = target.lowercased()
                    
                    // First check if it matches a menu extra
                    let trayResult = WindowManager.openMenuExtra(named: target)
                    if let items = trayResult {
                        printJSON(items)
                    } else {
                        // Try as app name — find its windows and snapshot
                        let apps = NSWorkspace.shared.runningApplications.filter {
                            $0.activationPolicy == .regular &&
                            ($0.localizedName?.lowercased().contains(nameLower) == true ||
                             $0.bundleIdentifier?.lowercased().contains(nameLower) == true)
                        }
                        guard let app = apps.first else {
                            fputs("error: no app or tray item matching '\(target)'\n", stderr)
                            exit(1)
                        }
                        let elements = AXScanner.snapshot(appPID: app.processIdentifier)
                        printJSON(elements)
                    }
                }
            } else {
                // No argument — full overview
                let overview = WindowManager.desktopOverview()
                printJSON(overview)
            }

        // ── Doctor / TCC ──

        case "doctor":
            let perms = WindowManager.checkPermissions()
            // Pretty print
            for p in perms {
                let icon: String
                switch p.status {
                case "authorized": icon = "✅"
                case "limited": icon = "⚠️"
                default: icon = p.required ? "❌" : "⚪"
                }
                let req = p.required ? "(required)" : "(optional)"
                fputs("  \(icon) \(p.displayName): \(p.status) \(req)\n", stderr)
            }
            printJSON(perms)

        case "cursor":
            let sub = cmdArgs.first ?? "status"
            let selfPath = CommandLine.arguments[0]
            switch sub {
            case "start", "show":
                if !CursorDaemon.isDaemonAlive() {
                    if !CursorDaemon.spawnDaemon(selfPath: selfPath) {
                        fputs("error: failed to spawn cursor daemon\n", stderr)
                        exit(1)
                    }
                }
                if let resp = CursorDaemon.sendCommand(["cmd": "show"]) {
                    print(resp)
                } else {
                    printResult(false, action: "cursor", ref: "show", extra: ["error": "daemon not responding"])
                    exit(1)
                }

            case "move":
                // 语法：cursor move x y [--no-animate] [--duration 0.5]
                let nums = cmdArgs.dropFirst().compactMap { Double($0) }
                guard nums.count >= 2 else {
                    fputs("error: usage: cursor move X Y [--no-animate] [--duration SEC]\n", stderr)
                    exit(1)
                }
                if !CursorDaemon.isDaemonAlive() {
                    if !CursorDaemon.spawnDaemon(selfPath: selfPath) {
                        fputs("error: failed to spawn cursor daemon\n", stderr)
                        exit(1)
                    }
                }
                let animate = !cmdArgs.contains("--no-animate")
                var duration = 0.35
                if let di = cmdArgs.firstIndex(of: "--duration"), di + 1 < cmdArgs.count,
                   let d = Double(cmdArgs[di + 1]) { duration = d }
                let payload: [String: Any] = [
                    "cmd": "move",
                    "x": nums[0],
                    "y": nums[1],
                    "animate": animate,
                    "duration": duration,
                ]
                if let resp = CursorDaemon.sendCommand(payload) {
                    print(resp)
                } else {
                    printResult(false, action: "cursor", ref: "move", extra: ["error": "daemon not responding"])
                    exit(1)
                }

            case "hide":
                if !CursorDaemon.isDaemonAlive() {
                    print(#"{"ok":true,"note":"daemon not running"}"#)
                    return
                }
                print(CursorDaemon.sendCommand(["cmd": "hide"]) ?? #"{"ok":false}"#)

            case "stop":
                if !CursorDaemon.isDaemonAlive() {
                    print(#"{"ok":true,"note":"daemon not running"}"#)
                    return
                }
                print(CursorDaemon.sendCommand(["cmd": "stop"]) ?? #"{"ok":false}"#)

            case "status":
                if !CursorDaemon.isDaemonAlive() {
                    print(#"{"ok":true,"running":false}"#)
                    return
                }
                print(CursorDaemon.sendCommand(["cmd": "status"]) ?? #"{"ok":false}"#)

            default:
                fputs("error: unknown cursor subcommand '\(sub)'. Use: start | move | hide | stop | status\n", stderr)
                exit(1)
            }

        case "ax-enable":
            // 诊断 / 触发工具：对指定 pid 写 AXManualAccessibility + AXEnhancedUserInterface，
            // 打开 Chromium/Electron app 的 web AX tree。返回 snapshot 前后的 interactive count 对比。
            guard let p = pid else {
                fputs("error: ax-enable requires --pid or --app\n", stderr)
                exit(1)
            }
            let beforeCount = AXScanner.snapshot(appPID: p).filter { $0.interactive }.count
            let ok = AXEnablementAssertion.shared.assert(pid: p)
            // Chromium 实际构建 AX tree 需要几十毫秒
            usleep(300_000)
            let afterCount = AXScanner.snapshot(appPID: p).filter { $0.interactive }.count
            let result: [String: Any] = [
                "ok": ok,
                "action": "ax-enable",
                "pid": Int(p),
                "before_interactive": beforeCount,
                "after_interactive": afterCount,
                "delta": afterCount - beforeCount,
                "note": ok
                    ? "AX enablement asserted (AXManualAccessibility or AXEnhancedUserInterface accepted)"
                    : "both AX enablement attributes unwritable — native Cocoa, or macOS 26+ where these are deprecated (Chrome 147 still builds full AX tree by default)"
            ]
            if let data = try? JSONSerialization.data(withJSONObject: result, options: .prettyPrinted),
               let str = String(data: data, encoding: .utf8) {
                print(str)
            }

        case "help", "--help", "-h":
            printUsage()

        default:
            fputs("error: unknown command '\(command)'\n", stderr)
            printUsage()
            exit(1)
        }
    }

    // MARK: - Helpers

    static func parsePID(_ args: [String]) -> pid_t? {
        if let idx = args.firstIndex(of: "--pid"), idx + 1 < args.count {
            return pid_t(args[idx + 1])
        }
        // --app "Name" or --app bundleId → resolve to PID
        if let idx = args.firstIndex(of: "--app"), idx + 1 < args.count {
            let name = args[idx + 1]
            let nameLower = name.lowercased()
            let apps = NSWorkspace.shared.runningApplications
            if let a = apps.first(where: {
                $0.localizedName == name ||
                $0.localizedName?.lowercased() == nameLower ||
                $0.bundleIdentifier == name ||
                $0.bundleIdentifier?.lowercased() == nameLower ||
                // Match executable name (e.g. "TextEdit" on Chinese macOS where localizedName is "文本编辑")
                $0.bundleURL?.lastPathComponent.replacingOccurrences(of: ".app", with: "") == name
            }) {
                return a.processIdentifier
            }
            fputs("error: app '\(name)' not found\n", stderr)
            exit(1)
        }
        return nil
    }

    static func printJSON<T: Encodable>(_ value: T) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(value),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
    }

    static func printResult(_ ok: Bool, action: String, ref: String, extra: [String: Any] = [:]) {
        var result: [String: Any] = ["ok": ok, "action": action, "ref": ref]
        if !ok {
            result["error"] = "action '\(action)' failed for \(ref)"
        }
        for (k, v) in extra { result[k] = v }
        if let data = try? JSONSerialization.data(withJSONObject: result),
           let str = String(data: data, encoding: .utf8) {
            print(str)
        }
    }

    static func printUsage() {
        print("""
        agent-control — AI 操作层 (macOS driver)

        UI Elements:
          snapshot [-i] [--fallback]             获取可交互元素列表
          click @ref | click x y                 点击
          dblclick @ref                          双击
          rightclick @ref                        右键
          fill @ref "text"                       输入文字
          press <key>                            按键
          drag @ref1 @ref2                       拖拽
          scroll <up|down|left|right> [amount]   滚动
          screenshot --app <name> [path]         App 窗口截图 (推荐,background-friendly)
          screenshot @ref [path]                 元素截图
          screenshot --full [path]               全屏截图 (显式 opt-in)

        Background Control (SkyLight — 不抢焦点):
          bg-focus                               后台激活 (需 --pid/--app)
          bg-defocus                             取消后台激活
          bg-click x y [--right]                 后台点击
          bg-type "text"                         后台输入文字
          bg-press <key>                         后台按键 (如 cmd+t)
          bg-act <click|type|press> ...          bg-focus + 动作 + bg-defocus
          stealth-act <snapshot|click|...>       最小化窗口静默操作

        FocusGuard (AX 模拟焦点 — 推荐, macOS 26 可用):
          click @ref --focus-guard               三层 focus 栈包裹 (Chromium AX enable + AXFocused swap + activation reverter)
          fill @ref "text" --focus-guard         同上 (app 不抢前台, 不抢真 focus)
          dblclick/rightclick @ref --focus-guard
          note: --focus-guard == --bg, 别名

        Virtual Cursor (lavender 箭头, 不动真光标):
          cursor start                           启动 daemon + 显示虚拟光标
          cursor move X Y [--no-animate] [--duration SEC]  平滑移动
          cursor hide / stop / status

        Diagnostics:
          ax-enable                              写 AXManualAccessibility/AXEnhancedUserInterface
                                                 打开 Chromium/Electron web AX tree，返回 before/after interactive count

        Window Management:
          windows                                列出所有窗口
          focus <windowID>                       激活窗口 (会抢前台)
          focus-bg <windowID>                    后台激活 (按 windowID)
          move-to-space <windowID> <spaceID>     移动窗口到空间
          pin <windowID>                         钉到所有空间
          unpin <windowID>                       取消钉住
          alpha <windowID> <0.0-1.0>             设置透明度
          blur <windowID> <radius>               设置背景模糊
          minimize <windowID>                    最小化
          close-window <windowID>                关闭窗口

        Spaces:
          spaces                                 列出所有空间
          switch-space <spaceID>                 切换空间

        Processes:
          processes                              列出 GUI 应用
          process <pid|name>                     查看进程详情

        Desktop:
          desktop                                一次返回完整桌面状态（frontmost/窗口/运行中app/menubar/spaces）

        Diagnostics:
          doctor                                 检查权限状态

        Options:
          --pid <pid>    指定目标应用 PID
          --app <name>   指定目标应用名称或 bundleId
          -i             snapshot 只返回可交互元素
          --fallback     snapshot 同时返回 CGWindowList fallback

        AX (抢焦点) vs SkyLight (后台) 对比:
          click/press/fill      — AX API, 需要窗口在前台
          bg-click/bg-press/bg-type — SkyLight, 不打断用户工作
          stealth-act           — 对最小化窗口操作, 用户无感知
        """)
    }
}
