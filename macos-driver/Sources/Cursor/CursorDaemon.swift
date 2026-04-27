// CursorDaemon.swift
// \u865a\u62df\u5149\u6807 daemon\u3002\u4e24\u4e2a\u89d2\u8272\uff1a
// - server\uff1a\u5728\u5b50\u8fdb\u7a0b\u91cc\u8dd1 NSRunLoop + AF_UNIX socket\uff0c\u6536 JSON \u547d\u4ee4\u8df3\u5f15 AgentCursor
// - client\uff1a\u8fde\u63a5 socket\uff0c\u53d1\u4e00\u6761 JSON\uff0c\u8bfb\u56de\u590d\uff0c\u65ad\u5f00
//
// \u534f\u8bae\uff1a\u6bcf\u6761\u6d88\u606f\u662f UTF-8 JSON + "\\n" \u7ed3\u5c3e\u3002
// \u652f\u6301\u7684 command\uff1a
//   {"cmd":"show"}              \u2192 {"ok":true,"visible":true}
//   {"cmd":"move","x":\u2026,"y":\u2026,"animate":true,"duration":0.35}
//   {"cmd":"hide"}              \u2192 {"ok":true}
//   {"cmd":"stop"}              \u2192 {"ok":true,"exit":true}  (\u4e4b\u540e daemon \u9000\u51fa)
//   {"cmd":"status"}            \u2192 {"ok":true,"visible":bool,"pid":int}

import AppKit
import Darwin
import Foundation

public enum CursorDaemon {
    public static let socketPath = "/tmp/agent-control-cursor.sock"
    public static let pidFile = "/tmp/agent-control-cursor.pid"

    // MARK: - Server

    /// \u5728\u5f53\u524d\u8fdb\u7a0b\u8fd0\u884c daemon\uff08\u963b\u585e\u8c03\u7528\uff09\u3002
    /// \u6ce8\u610f\u8c03\u8005\u9700\u8981\u6709 NSApplication\uff0c\u5305\u542b NSRunLoop\u3002
    public static func runServer() -> Never {
        // \u72ec\u5360\u68c0\u67e5\uff1a\u5df2\u6709 daemon \u5219\u9000\u51fa
        if let existing = readPid(), kill(existing, 0) == 0 {
            fputs("cursor daemon already running (pid \(existing))\n", stderr)
            exit(0)
        }

        // \u5199 pid file
        try? String(getpid()).write(toFile: pidFile, atomically: true, encoding: .utf8)

        // \u5f00 listen socket
        unlink(socketPath)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            fputs("socket() failed: \(String(cString: strerror(errno)))\n", stderr)
            exit(1)
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        socketPath.withCString { p in
            withUnsafeMutableBytes(of: &addr.sun_path) { buf in
                strncpy(buf.baseAddress!.assumingMemoryBound(to: CChar.self), p, buf.count - 1)
            }
        }
        let addrSize = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindOk = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bind(fd, sa, addrSize)
            }
        }
        guard bindOk == 0 else {
            fputs("bind() failed: \(String(cString: strerror(errno)))\n", stderr)
            exit(1)
        }
        guard listen(fd, 8) == 0 else {
            fputs("listen() failed: \(String(cString: strerror(errno)))\n", stderr)
            exit(1)
        }

        // \u5728\u540e\u53f0\u7ebf\u7a0b accept\uff0c\u6307\u4ee4\u5206\u53d1\u5230\u4e3b\u7ebf\u7a0b\u6267\u884c
        DispatchQueue.global(qos: .utility).async {
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 { continue }
                DispatchQueue.global(qos: .utility).async {
                    handleClient(client)
                }
            }
        }

        // \u5728\u4e3b\u7ebf\u7a0b\u8dd1 RunLoop \u4e3b\u6301 NSApp / overlay\u3002
        // \u9700\u8981 NSApplication \u5b9e\u4f8b\u5316 + run()\u3002
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)  // \u4e0d\u663e\u793a\u5728 Dock / \u4e0d\u62a2\u7126\u70b9
        app.run()
        // run() \u4e0d\u4f1a\u8fd4\u56de\u3002stop \u547d\u4ee4\u5185\u90e8\u8c03 exit(0)
        fatalError("NSApp.run returned")
    }

    private static func handleClient(_ fd: Int32) {
        defer { close(fd) }

        // \u8bfb\u4e00\u884c JSON (\u7ed3\u5c3e \\n)
        var buf = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            buf.append(chunk, count: n)
            if chunk[0..<n].contains(UInt8(ascii: "\n")) { break }
        }
        guard !buf.isEmpty else { return }

        let response = processCommand(buf)

        var reply = response
        if !reply.hasSuffix("\n") { reply += "\n" }
        reply.withCString { p in
            _ = write(fd, p, strlen(p))
        }
    }

    private static func processCommand(_ data: Data) -> String {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String else {
            return #"{"ok":false,"error":"invalid json or missing cmd"}"#
        }

        // \u6240\u6709 UI \u64cd\u4f5c\u8d70\u4e3b\u7ebf\u7a0b\u3002\u7528 semaphore \u7b49\u4e3b\u7ebf\u7a0b\u5b8c\u6210
        var response = #"{"ok":false,"error":"unhandled"}"#
        let sem = DispatchSemaphore(value: 0)

        DispatchQueue.main.async {
            switch cmd {
            case "show":
                AgentCursor.shared.show()
                response = #"{"ok":true,"visible":true}"#
            case "hide":
                AgentCursor.shared.hide()
                response = #"{"ok":true,"visible":false}"#
            case "move":
                let x = (obj["x"] as? Double) ?? (obj["x"] as? NSNumber)?.doubleValue ?? 0
                let y = (obj["y"] as? Double) ?? (obj["y"] as? NSNumber)?.doubleValue ?? 0
                let animate = (obj["animate"] as? Bool) ?? true
                let duration = (obj["duration"] as? Double) ?? 0.35
                AgentCursor.shared.show()  // ensure visible
                if animate {
                    AgentCursor.shared.animate(to: CGPoint(x: x, y: y), duration: duration)
                } else {
                    AgentCursor.shared.move(to: CGPoint(x: x, y: y))
                }
                response = #"{"ok":true}"#
            case "status":
                let vis = AgentCursor.shared.isVisible
                response = "{\"ok\":true,\"visible\":\(vis),\"pid\":\(getpid())}"
            case "stop":
                AgentCursor.shared.destroy()
                response = #"{"ok":true,"exit":true}"#
                // \u7b54\u590d\u540e\u9000\u51fa
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    unlink(socketPath)
                    unlink(pidFile)
                    exit(0)
                }
            default:
                response = "{\"ok\":false,\"error\":\"unknown cmd: \(cmd)\"}"
            }
            sem.signal()
        }

        _ = sem.wait(timeout: .now() + 2.0)
        return response
    }

    private static func readPid() -> pid_t? {
        guard let s = try? String(contentsOfFile: pidFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
              let p = pid_t(s) else { return nil }
        return p
    }

    // MARK: - Client

    /// \u8fde\u63a5\u8fd0\u884c\u4e2d\u7684 daemon \u53d1\u547d\u4ee4\uff0c\u8fd4\u56de\u539f\u59cb\u56de\u590d\u5b57\u7b26\u4e32\u3002
    /// \u5931\u8d25\u8fd4\u56de nil\u3002
    public static func sendCommand(_ payload: [String: Any], timeoutMs: Int = 2000) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            return nil
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }

        var tv = timeval(tv_sec: Int(timeoutMs / 1000), tv_usec: Int32((timeoutMs % 1000) * 1000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        socketPath.withCString { p in
            withUnsafeMutableBytes(of: &addr.sun_path) { buf in
                strncpy(buf.baseAddress!.assumingMemoryBound(to: CChar.self), p, buf.count - 1)
            }
        }
        let addrSize = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connectOk = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                connect(fd, sa, addrSize)
            }
        }
        if connectOk != 0 { return nil }

        // \u53d1\u9001 (JSON \uff0b \\n)
        var payload = data
        payload.append(UInt8(ascii: "\n"))
        _ = payload.withUnsafeBytes { buf -> Int in
            write(fd, buf.baseAddress, buf.count)
        }

        // \u8bfb\u56de\u590d
        var resp = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            resp.append(chunk, count: n)
            if resp.last == UInt8(ascii: "\n") { break }
        }
        return String(data: resp, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// \u5c1d\u8bd5\u8fde\u63a5\uff0c\u8fd4\u56de daemon \u662f\u5426\u5b58\u6d3b\u3002
    public static func isDaemonAlive() -> Bool {
        guard let pid = readPid() else { return false }
        return kill(pid, 0) == 0
    }

    /// fork + exec \u81ea\u5df1\uff0c\u542f\u52a8 daemon\u3002\u8fd4\u56de\u81f3 daemon \u53ef\u5230\u8fbe\u4e3a\u6b62\u3002
    public static func spawnDaemon(selfPath: String) -> Bool {
        if isDaemonAlive() { return true }

        var pid = pid_t(0)
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }

        // \u65e0 tty\u3001stdout/stderr \u91cd\u5b9a\u5411\u5230 /tmp/agent-control-cursor.log
        let logPath = "/tmp/agent-control-cursor.log"
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, logPath, O_WRONLY | O_CREAT | O_APPEND, 0644)
        posix_spawn_file_actions_addopen(&actions, 2, logPath, O_WRONLY | O_CREAT | O_APPEND, 0644)

        let args: [String] = [selfPath, "cursor-daemon-run"]
        var cArgs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
        defer { cArgs.forEach { if let p = $0 { free(p) } } }

        var env: [UnsafeMutablePointer<CChar>?] = ProcessInfo.processInfo.environment.map {
            strdup("\($0.key)=\($0.value)")
        } + [nil]
        defer { env.forEach { if let p = $0 { free(p) } } }

        // setsid \u4f7f daemon \u72ec\u7acb\u4e8e\u5f53\u524d\u4f1a\u8bdd
        var spawnAttr: posix_spawnattr_t?
        posix_spawnattr_init(&spawnAttr)
        defer { posix_spawnattr_destroy(&spawnAttr) }
        posix_spawnattr_setflags(&spawnAttr, Int16(POSIX_SPAWN_SETSID))

        let rc = posix_spawn(&pid, selfPath, &actions, &spawnAttr, &cArgs, &env)
        guard rc == 0 else {
            fputs("posix_spawn failed: \(String(cString: strerror(rc)))\n", stderr)
            return false
        }

        // \u7b49 daemon \u8d77\u6765 (pidfile \u51fa\u73b0) \u6700\u591a 2s
        for _ in 0..<40 {
            if isDaemonAlive() { return true }
            usleep(50_000)
        }
        return false
    }
}
