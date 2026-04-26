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
        let args = Array(CommandLine.arguments.dropFirst())

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
            if let ref = ref {
                let ok = btn == "right"
                    ? AXActions.rightclick(ref: ref, appPID: pid)
                    : AXActions.click(ref: ref, appPID: pid)
                printResult(ok, action: "click", ref: ref)
            } else if nums.count >= 2 {
                let ok = AXActions.clickAt(x: CGFloat(nums[0]), y: CGFloat(nums[1]), button: btn)
                printResult(ok, action: "click", ref: "\(Int(nums[0])),\(Int(nums[1]))")
            } else {
                fputs("error: usage: click @ref | click x y\n", stderr)
                exit(1)
            }

        case "dblclick":
            guard let ref = cmdArgs.first(where: { isRef($0) }) else {
                fputs("error: missing ref\n", stderr)
                exit(1)
            }
            let ok = AXActions.dblclick(ref: ref, appPID: pid)
            printResult(ok, action: "dblclick", ref: ref)

        case "rightclick":
            guard let ref = cmdArgs.first(where: { isRef($0) }) else {
                fputs("error: missing ref\n", stderr)
                exit(1)
            }
            let ok = AXActions.rightclick(ref: ref, appPID: pid)
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
            let ok = AXActions.fill(ref: ref, text: text, appPID: pid)
            printResult(ok, action: "fill", ref: ref)

        case "press":
            guard let key = cmdArgs.first else {
                fputs("error: missing key\n", stderr)
                exit(1)
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

    static func printResult(_ ok: Bool, action: String, ref: String) {
        var result: [String: Any] = ["ok": ok, "action": action, "ref": ref]
        if !ok {
            result["error"] = "action '\(action)' failed for \(ref)"
        }
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

        Window Management:
          windows                                列出所有窗口
          focus <windowID>                       激活窗口
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

        Diagnostics:
          doctor                                 检查权限状态

        Options:
          --pid <pid>    指定目标应用 PID
          --app <name>   指定目标应用名称或 bundleId
          -i             snapshot 只返回可交互元素
          --fallback     snapshot 同时返回 CGWindowList fallback
        """)
    }
}
