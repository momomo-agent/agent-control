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

        guard let command = args.first else {
            printUsage()
            exit(1)
        }

        let pid = parsePID(args)

        switch command {
        case "snapshot":
            let interactive = args.contains("-i")
            let elements = AXScanner.snapshot(appPID: pid)
            let output = interactive ? elements.filter { $0.interactive } : elements
            printJSON(output)

        case "click":
            let ref = args.dropFirst().first(where: { isRef($0) })
            let nums = args.dropFirst().compactMap { Double($0) }
            let btn = args.contains("--right") ? "right" : "left"
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
            guard let ref = args.dropFirst().first(where: { isRef($0) }) else {
                fputs("error: missing ref\n", stderr)
                exit(1)
            }
            let ok = AXActions.dblclick(ref: ref, appPID: pid)
            printResult(ok, action: "dblclick", ref: ref)

        case "rightclick":
            guard let ref = args.dropFirst().first(where: { isRef($0) }) else {
                fputs("error: missing ref\n", stderr)
                exit(1)
            }
            let ok = AXActions.rightclick(ref: ref, appPID: pid)
            printResult(ok, action: "rightclick", ref: ref)

        case "fill":
            guard let ref = args.dropFirst().first(where: { isRef($0) }) else {
                fputs("error: missing ref\n", stderr)
                exit(1)
            }
            let textIdx = args.firstIndex(of: ref)! + 1
            guard textIdx < args.count else {
                fputs("error: missing text argument\n", stderr)
                exit(1)
            }
            // Collect text args, skip --pid and its value
            var textParts: [String] = []
            var i = textIdx
            while i < args.count {
                if args[i] == "--pid" { i += 2; continue }
                if args[i].hasPrefix("--") { i += 1; continue }
                textParts.append(args[i])
                i += 1
            }
            let text = textParts.joined(separator: " ")
            let ok = AXActions.fill(ref: ref, text: text, appPID: pid)
            printResult(ok, action: "fill", ref: ref)

        case "press":
            guard args.count > 1 else {
                fputs("error: missing key\n", stderr)
                exit(1)
            }
            let key = args[1]
            let ok = AXActions.press(key: key)
            printResult(ok, action: "press", ref: key)

        case "longpress":
            let ref = args.dropFirst().first(where: { isRef($0) })
            let nums = args.dropFirst().compactMap { Double($0) }
            let durationArg = args.first(where: { $0.hasPrefix("--duration=") })
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
            let refs = args.dropFirst().filter { isRef($0) }
            let nums = args.dropFirst().compactMap { Double($0) }
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
            let dir = args.count > 1 ? args[1] : "down"
            let amount = args.count > 2 ? Int32(args[2]) ?? 100 : 100
            let ok = AXActions.scroll(direction: dir, amount: amount)
            printResult(ok, action: "scroll", ref: "\(dir) \(amount)")

        case "screenshot":
            let ref = args.dropFirst().first(where: { isRef($0) })
            // Skip flag values (--pid X, --app X, -i)
            var skipNext = false
            let output = args.dropFirst().first(where: { arg in
                if skipNext { skipNext = false; return false }
                if arg == "--pid" || arg == "--app" { skipNext = true; return false }
                return !isRef(arg) && !arg.hasPrefix("--") && arg != "-i" && arg != "screenshot"
            }) ?? "/tmp/agent-control-screenshot.png"

            let ok: Bool
            if let ref = ref {
                ok = await AXScreenshot.element(ref: ref, output: output, appPID: pid)
            } else {
                ok = await AXScreenshot.fullScreen(output: output, appPID: pid)
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
            let apps = NSWorkspace.shared.runningApplications
            if let a = apps.first(where: { $0.localizedName == name || $0.bundleIdentifier == name }) {
                return a.processIdentifier
            }
            fputs("error: app '\(name)' not found\n", stderr)
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

        Usage:
          agent-control snapshot [-i]           获取可交互元素列表
          agent-control click @ref              点击
          agent-control dblclick @ref            双击
          agent-control rightclick @ref          右键
          agent-control fill @ref "text"         输入文字
          agent-control press <key>              按键
          agent-control drag @ref1 @ref2         拖拽
          agent-control scroll <up|down|left|right> [amount] 滚动
          agent-control screenshot [path]        全屏截图
          agent-control screenshot @ref [path]   元素截图

        Options:
          --pid <pid>    指定目标应用 PID（默认前台应用）
          --app <name>   指定目标应用名称或 bundleId
          -i             snapshot 只返回可交互元素
        """)
    }
}
