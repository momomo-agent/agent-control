# Cua SkyLight Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete three-layer background control (focus-without-raise, authenticated event post, stealth deminiaturize) in agent-control's macos-driver using SkyLight private APIs.

**Architecture:** Layer 1 (BackgroundFocus.activateWithoutRaise) and core Layer 2 (postToPid/setWindowLocation) already exist in BackgroundFocus.swift. We need to: (1) add bg-defocus standalone, (2) build high-level bg-click/bg-type/bg-press on top of postToPid, (3) implement stealth-act with alpha-hide deminiaturize pattern. All private API calls stay in BackgroundFocus.swift; CLI routing in main.swift; helpers that need window resolution use WindowManager.

**Tech Stack:** Swift 5.9, SkyLight.framework, CoreGraphics CGEvent, ApplicationServices AX

---

## Existing State

- `BackgroundFocus.activateWithoutRaise(targetPid:targetWid:)` — Layer 1 done
- `BackgroundFocus.postToPid(_:event:attachAuthMessage:)` — Layer 2 core done
- `BackgroundFocus.setWindowLocation(_:point:)` — done
- `SetIntFieldFn` type declared but **not resolved** (needed for session ID fields f51/f91/f92)
- CLI: `focus-bg <windowID>` exists — needs alias as `bg-focus` with --pid/--app support
- No: bg-defocus, bg-click, bg-type, bg-press, bg-act, stealth-act

## File Map

- **Modify:** `Sources/BackgroundFocus.swift` — add setIntField resolution, defocusWithoutRaise, bgClick, bgType, bgPress, stealthAct
- **Modify:** `Sources/main.swift` — add CLI commands: bg-focus, bg-defocus, bg-click, bg-type, bg-press, bg-act, stealth-act
- **Modify:** `Sources/WindowManager.swift` — add helper: firstWindowID(forPID:), deminiaturize/reminimize

---

### Task 1: Layer 1 — bg-focus / bg-defocus CLI

**Files:**
- Modify: `Sources/BackgroundFocus.swift` — add `defocusWithoutRaise(targetPid:)`
- Modify: `Sources/main.swift` — add `bg-focus` and `bg-defocus` commands
- Modify: `Sources/WindowManager.swift` — add `firstWindowID(forPID:)` helper

- [ ] **Step 1: Add defocusWithoutRaise to BackgroundFocus.swift**

```swift
/// Defocus targetPid: send defocus event (0x02) to its PSN.
@discardableResult
public static func defocusWithoutRaise(targetPid: pid_t) -> Bool {
    lastError = ""
    guard isFocusWithoutRaiseAvailable else {
        lastError = "spi_not_available"
        return false
    }
    var psn = [UInt32](repeating: 0, count: 2)
    let code = psn.withUnsafeMutableBytes { raw -> Int32 in
        getProcessForPIDFn?(targetPid, raw.baseAddress!) ?? -1
    }
    guard code == 0 else {
        lastError = "getProcessForPID=\(code) pid=\(targetPid)"
        return false
    }
    var buf = [UInt8](repeating: 0, count: 0xF8)
    buf[0x04] = 0xF8; buf[0x08] = 0x0D; buf[0x8A] = 0x02
    let result = psn.withUnsafeBytes { psnRaw -> Int32 in
        buf.withUnsafeBufferPointer { bp -> Int32 in
            postEventRecordToFn?(psnRaw.baseAddress!, bp.baseAddress!) ?? -1
        }
    }
    if result != 0 { lastError = "defocus=\(result)"; return false }
    return true
}
```

- [ ] **Step 2: Add firstWindowID helper to WindowManager**

```swift
/// Get the first layer-0 window ID for a given PID.
static func firstWindowID(forPID pid: pid_t) -> UInt32? {
    let wins = listWindows(forPID: pid)
    return wins.first(where: { $0.layer == 0 })?.windowID
}
```

- [ ] **Step 3: Add bg-focus and bg-defocus CLI commands in main.swift**

```swift
case "bg-focus":
    guard let targetPID = pid else {
        fputs("error: bg-focus requires --pid or --app\n", stderr); exit(1)
    }
    let wid = cmdArgs.first.flatMap { UInt32($0) }
        ?? WindowManager.firstWindowID(forPID: targetPID)
        ?? 0
    let ok = BackgroundFocus.activateWithoutRaise(targetPid: targetPID, targetWid: CGWindowID(wid))
    printResult(ok, action: "bg-focus", ref: "\(targetPID)", extra: [
        "spi_available": BackgroundFocus.isFocusWithoutRaiseAvailable,
        "last_error": BackgroundFocus.lastError
    ])

case "bg-defocus":
    guard let targetPID = pid else {
        fputs("error: bg-defocus requires --pid or --app\n", stderr); exit(1)
    }
    let ok = BackgroundFocus.defocusWithoutRaise(targetPid: targetPID)
    printResult(ok, action: "bg-defocus", ref: "\(targetPID)")
```

- [ ] **Step 4: Build and verify**

```bash
cd macos-driver && swift build 2>&1
```

- [ ] **Step 5: Real test — bg-focus**

Open Chrome foreground, TextEdit background:
```bash
./build/debug/agent-control --app TextEdit bg-focus
./build/debug/agent-control --app TextEdit bg-defocus
```

- [ ] **Step 6: Commit**

```bash
git add Sources/BackgroundFocus.swift Sources/main.swift Sources/WindowManager.swift
git commit -m "feat(macos): Layer 1 — bg-focus/bg-defocus CLI (focus without raise)"
```

---

### Task 2: Layer 2 — bg-click / bg-type / bg-press

**Files:**
- Modify: `Sources/BackgroundFocus.swift` — add setIntField resolution, bgClick, bgType, bgPress, bgAct
- Modify: `Sources/main.swift` — add CLI commands

- [ ] **Step 1: Resolve SLEventSetIntegerValueField in BackgroundFocus.swift**

Add to the `resolved` lazy var or as separate lazy:
```swift
private static let setIntFieldFn: SetIntFieldFn? = {
    _ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
    guard let p = dlsym(UnsafeMutableRawPointer(bitPattern: -2),
                        "SLEventSetIntegerValueField") else { return nil }
    return unsafeBitCast(p, to: SetIntFieldFn.self)
}()
```

- [ ] **Step 2: Add bgClick — background mouse click**

```swift
/// Background click at (x,y) in window-local coords for the target pid/window.
@discardableResult
public static func bgClick(
    pid: pid_t, windowID: CGWindowID? = nil,
    x: CGFloat, y: CGFloat, button: CGMouseButton = .left
) -> Bool {
    let screenPoint = CGPoint(x: x, y: y) // caller provides screen coords
    let windowPoint = CGPoint(x: x, y: y) // window-local (adjust if windowID given)

    let downType: CGEventType = button == .left ? .leftMouseDown : .rightMouseDown
    let upType: CGEventType = button == .left ? .leftMouseUp : .rightMouseUp

    guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: screenPoint, mouseButton: button),
          let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: screenPoint, mouseButton: button)
    else { return false }

    // Set window-local coordinates
    setWindowLocation(down, point: windowPoint)
    setWindowLocation(up, point: windowPoint)

    // Mouse events: NO auth message (would bypass cgAnnotatedSessionEventTap)
    postToPid(pid, event: down, attachAuthMessage: false)
    usleep(50_000)
    postToPid(pid, event: up, attachAuthMessage: false)
    return true
}
```

- [ ] **Step 3: Add bgPress — background key press**

Reuse AXActions' keycode mapping but post via postToPid with auth:
```swift
/// Background key press. `key` uses same format as AXActions.press ("cmd+shift+a").
@discardableResult
public static func bgPress(pid: pid_t, key: String) -> Bool {
    let parts = key.lowercased().split(separator: "+").map(String.init)
    guard !parts.isEmpty else { return false }

    var flags: CGEventFlags = []
    for mod in parts.dropLast() {
        switch mod {
        case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: break
        }
    }

    let mainKey = parts.last!
    let keyCode = resolveKeyCode(mainKey, flags: &flags)

    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
    else { return false }

    down.flags = flags
    up.flags = flags

    // Keyboard: WITH auth message (Chromium requires it on macOS 14+)
    postToPid(pid, event: down, attachAuthMessage: true)
    usleep(10_000)
    postToPid(pid, event: up, attachAuthMessage: true)
    return true
}
```

- [ ] **Step 4: Add bgType — background text typing**

```swift
/// Background type string, character by character.
@discardableResult
public static func bgType(pid: pid_t, text: String) -> Bool {
    for ch in text {
        let s = String(ch)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        else { return false }
        let utf16 = Array(s.utf16)
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        postToPid(pid, event: down, attachAuthMessage: true)
        usleep(5_000)
        postToPid(pid, event: up, attachAuthMessage: true)
        usleep(5_000)
    }
    return true
}
```

- [ ] **Step 5: Add resolveKeyCode helper (extract from AXActions pattern)**

Port the keycode lookup table from AXActions.press into BackgroundFocus as a private helper.

- [ ] **Step 6: Add CLI commands for bg-click, bg-type, bg-press, bg-act**

```swift
case "bg-click":
    guard let targetPID = pid else { fputs("error: requires --pid/--app\n", stderr); exit(1) }
    let nums = cmdArgs.compactMap { Double($0) }
    guard nums.count >= 2 else { fputs("error: bg-click x y\n", stderr); exit(1) }
    let btn: CGMouseButton = cmdArgs.contains("--right") ? .right : .left
    let wid = cmdArgs.first(where: { $0.hasPrefix("--window=") })
        .flatMap { CGWindowID($0.dropFirst("--window=".count)) }
    let ok = BackgroundFocus.bgClick(pid: targetPID, windowID: wid,
                                      x: CGFloat(nums[0]), y: CGFloat(nums[1]), button: btn)
    printResult(ok, action: "bg-click", ref: "\(Int(nums[0])),\(Int(nums[1]))")

case "bg-type":
    guard let targetPID = pid else { fputs("error: requires --pid/--app\n", stderr); exit(1) }
    let text = cmdArgs.joined(separator: " ")
    guard !text.isEmpty else { fputs("error: bg-type <text>\n", stderr); exit(1) }
    let ok = BackgroundFocus.bgType(pid: targetPID, text: text)
    printResult(ok, action: "bg-type", ref: text)

case "bg-press":
    guard let targetPID = pid else { fputs("error: requires --pid/--app\n", stderr); exit(1) }
    guard let key = cmdArgs.first else { fputs("error: bg-press <key>\n", stderr); exit(1) }
    let ok = BackgroundFocus.bgPress(pid: targetPID, key: key)
    printResult(ok, action: "bg-press", ref: key)

case "bg-act":
    // Combo: bg-focus + action + bg-defocus
    guard let targetPID = pid else { fputs("error: requires --pid/--app\n", stderr); exit(1) }
    guard let subCmd = cmdArgs.first else { fputs("error: bg-act <click|type|press> ...\n", stderr); exit(1) }
    let subArgs = Array(cmdArgs.dropFirst())
    let wid = WindowManager.firstWindowID(forPID: targetPID) ?? 0
    BackgroundFocus.activateWithoutRaise(targetPid: targetPID, targetWid: CGWindowID(wid))
    usleep(50_000)
    var ok = false
    switch subCmd {
    case "click":
        let nums = subArgs.compactMap { Double($0) }
        if nums.count >= 2 {
            ok = BackgroundFocus.bgClick(pid: targetPID, x: CGFloat(nums[0]), y: CGFloat(nums[1]))
        }
    case "type":
        ok = BackgroundFocus.bgType(pid: targetPID, text: subArgs.joined(separator: " "))
    case "press":
        if let key = subArgs.first { ok = BackgroundFocus.bgPress(pid: targetPID, key: key) }
    default:
        fputs("error: unknown bg-act sub-command '\(subCmd)'\n", stderr); exit(1)
    }
    usleep(50_000)
    BackgroundFocus.defocusWithoutRaise(targetPid: targetPID)
    printResult(ok, action: "bg-act", ref: "\(subCmd) \(subArgs.joined(separator: " "))")
```

- [ ] **Step 7: Build and verify**
- [ ] **Step 8: Real test — bg-type into Chrome**
- [ ] **Step 9: Commit**

```bash
git commit -m "feat(macos): Layer 2 — bg-click/bg-type/bg-press (authenticated event post)"
```

---

### Task 3: Layer 3 — stealth-act (stealth deminiaturize)

**Files:**
- Modify: `Sources/BackgroundFocus.swift` — add stealthAct
- Modify: `Sources/WindowManager.swift` — add deminiaturize/isMinimized helpers
- Modify: `Sources/main.swift` — add stealth-act CLI

- [ ] **Step 1: Add isMinimized/deminiaturize/reminimize helpers to WindowManager**

```swift
static func isMinimized(_ wid: UInt32) -> Bool {
    let pid = pidForWindow(wid)
    guard pid > 0, let axWin = axWindowForID(wid, pid: pid) else { return false }
    var value: CFTypeRef?
    AXUIElementCopyAttributeValue(axWin, kAXMinimizedAttribute as CFString, &value)
    return (value as? Bool) == true
}

static func deminiaturizeWindow(_ wid: UInt32) -> Bool {
    let pid = pidForWindow(wid)
    guard pid > 0, let axWin = axWindowForID(wid, pid: pid) else { return false }
    return AXUIElementSetAttributeValue(axWin, kAXMinimizedAttribute as CFString, false as CFBoolean) == .success
}
```

- [ ] **Step 2: Add stealthAct to BackgroundFocus**

```swift
/// Stealth action on a minimized window:
/// 1. alpha(0)  2. deminiaturize  3. action  4. minimize  5. alpha(1)
@discardableResult
public static func stealthAct(
    pid: pid_t, windowID: UInt32,
    action: () -> Bool
) -> Bool {
    let wasMinimized = WindowManager.isMinimized(windowID)

    // Step 1: Hide
    if wasMinimized {
        _ = WindowManager.setWindowAlpha(windowID, alpha: 0)
        usleep(50_000)
        _ = WindowManager.deminiaturizeWindow(windowID)
        usleep(200_000) // wait for deminiaturize animation
    }

    // Step 2: Execute
    let ok = action()

    // Step 3: Re-minimize
    if wasMinimized {
        _ = WindowManager.minimizeWindow(windowID)
        usleep(100_000)
        _ = WindowManager.setWindowAlpha(windowID, alpha: 1)
    }
    return ok
}
```

- [ ] **Step 3: Add stealth-act CLI**

```swift
case "stealth-act":
    guard let targetPID = pid else { fputs("error: requires --pid/--app\n", stderr); exit(1) }
    guard let subCmd = cmdArgs.first else { fputs("error: stealth-act <snapshot|click|...>\n", stderr); exit(1) }
    guard let wid = WindowManager.firstWindowID(forPID: targetPID) else {
        fputs("error: no window found for pid \(targetPID)\n", stderr); exit(1)
    }
    // ... dispatch subCmd inside stealthAct closure
```

- [ ] **Step 4: Build and verify**
- [ ] **Step 5: Real test — stealth snapshot of minimized Chrome**
- [ ] **Step 6: Commit**

```bash
git commit -m "feat(macos): Layer 3 — stealth-act (stealth deminiaturize for minimized windows)"
```

---

### Task 4: Update help text and final verification

- [ ] **Step 1: Update printUsage() with new commands**
- [ ] **Step 2: Full build clean**
- [ ] **Step 3: Commit**
