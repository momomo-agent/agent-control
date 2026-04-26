# agent-control

**Give your AI agent eyes and hands.**

One CLI, four platforms. Your agent sees the UI, picks an element, acts on it.

```
agent-control -p web -e snapshot

→ 12 interactive elements (5×label, 1×text, 1×email, 1×password, 1×select, 1×checkbox, 1×submit, 1×a)
  @e8  text "Name"
  @e10 email "Email"
  @e12 password "Password"
  @e18 submit "Create Account"

agent-control -p web click @e18
→ { ok: true }
```

<p align="center">
  <img src="docs/demo/web-screenshot.png" width="32%" />
  <img src="docs/demo/macos-screenshot.png" width="32%" />
  <img src="docs/demo/ios-screenshot.png" width="32%" />
</p>
<p align="center"><sub>Web · macOS · iOS · Android — same protocol, same refs, same commands</sub></p>

## Why

AI agents are smart but blind. They can reason, plan, and decide — but they can't see a button or click it.

agent-control gives them a universal interface to any GUI:
- **See** → `snapshot` returns interactive elements with semantic labels
- **Act** → `click @ref` / `fill @ref "text"` / `press key`
- **Verify** → `screenshot` captures the result

No Selenium. No Appium. No platform-specific test frameworks.
One protocol. Four platforms. Works today.

## Design Principles

**Background-first.** Agents shouldn't steal focus. `click`/`fill`/`press` go through the Accessibility API (AXPress / AXSetValue) — the target app doesn't need to be frontmost, and your cursor doesn't jump. You can keep working while the agent works.

**App-scoped screenshots.** Prefer `--app <name>` over full-screen captures. On macOS, `screenshot --app Finder` uses `screencapture -l <windowID>` — it captures only that app's window, even if it's behind others. Less noise for the model, better privacy, no need to raise windows.

**One tool for all GUI work.** If you'd reach for AppleScript, `osascript`, `cliclick`, `adb shell input`, or browser-specific scripts — use agent-control instead. Same refs, same verbs, across web / macOS / iOS / Android.

```bash
# ❌ old way: multi-tool, app must be frontmost
osascript -e 'tell app "Finder" to activate' && cliclick c:500,300

# ✅ agent-control: one tool, background, any app
agent-control -p macos --app Finder -e snapshot
agent-control -p macos --app Finder click @e3
```

## Install

```bash
npm install -g agent-control
```

Or clone and link:

```bash
git clone https://github.com/momomo-agent/agent-control
cd agent-control && npm install && npm link
```

### Quick check

```bash
agent-control doctor
```

## Usage

```bash
# Web — open a page, see it, act on it
agent-control -p web open https://example.com
agent-control -p web -e snapshot
agent-control -p web click @e3
agent-control -p web fill @e8 "Alice"

# macOS — target any app by name or PID
agent-control -p macos --app Finder -e snapshot
agent-control -p macos --app TextEdit fill @e1 "hello"
agent-control -p macos --app "Slack" -e snapshot

# macOS — menubar / Electron apps
agent-control -p macos screenshot --app com.apple.controlcenter /tmp/menubar.png

# iOS Simulator
agent-control -p ios -e snapshot
agent-control -p ios click @e5

# Android (experimental)
agent-control -p android -e snapshot
```

### Demo (30 seconds)

```bash
agent-control demo web
```

Auto: environment check → start driver → open test page → snapshot → screenshot. Zero config.

## Commands

| Command | What it does |
|---------|-------------|
| `snapshot [-e]` | See UI elements. `-e` = enhanced (filtered + summary) |
| `click @ref` | Click / tap |
| `longpress @ref [--duration=ms]` | Long press (default 1s) |
| `dblclick @ref` | Double click |
| `fill @ref "text"` | Clear + type |
| `select @ref "val"` | Select dropdown (web) |
| `press <key>` | Keyboard key |
| `screenshot --app <name> [path]` | Save PNG (app-scoped, background-friendly) |
| `screenshot --full [path]` | Save PNG (full-screen, explicit opt-in) |
| `scroll <up\|down>` | Scroll view |
| `drag @from @to` | Drag between elements |
| `open <url>` | Navigate (web) |
| `swipe <dir>` | Swipe (iOS/Android) |
| `find <text>` | Search for element by text |
| `wait --idle` | Wait for network idle (web) |
| `wait @ref` | Wait for element visible (web) |
| `eval <js>` | Execute JS in page (web) |
| `back` / `forward` | Browser navigation (web) |
| `close` | Close browser (web) |

## How It Works

```
Your Agent (brain)          agent-control (eyes + hands)
     │                              │
     │  snapshot -e                 │
     │─────────────────────────────→│──→ Playwright / AX API / Simulator
     │                              │
     │  @e8 text "Name"             │
     │  @e10 email "Email"          │
     │  @e18 submit "Create Account"│
     │←─────────────────────────────│
     │                              │
     │  fill @e8 "Alice"            │
     │─────────────────────────────→│
     │  { ok: true }                │
     │←─────────────────────────────│
```

agent-control is **not** an agent. It's the hands and eyes that any agent can use.
You bring the brain (Claude, GPT, Gemini, local LLM — whatever). We handle the GUI.

## Platforms

| Platform | Driver | Notes |
|----------|--------|-------|
| **Web** | Playwright | Auto-starts daemon on port 3901. Headless Chromium. |
| **macOS** | Swift + Accessibility API | `--app` or `--pid` to target any app. Supports menubar + Electron. |
| **iOS** | Simulator AX | Auto-detects booted sim. |
| **Android** | adb + uiautomator | Experimental. Requires emulator or device via adb. |

## Enhanced Snapshot (`-e`)

Raw snapshot returns every element. Enhanced (`-e`) filters to interactive elements and adds a semantic summary:

```json
{
  "total": 118,
  "interactive": 4,
  "summary": "4 interactive elements (4×submit). Key: \"Log out\", \"+ New Item\"",
  "text": "@e7 button[submit] \"Log out\"\n@e9 button[submit] \"+ New Item\"",
  "elements": [...]
}
```

## Auto Mode (LLM-Driven)

Let an LLM autonomously operate the UI toward a goal:

```bash
export AC_API_KEY=sk-...
agent-control auto -p web --goal "Sign up with name Alice" --url https://example.com/signup
```

Loops: snapshot → LLM decides → execute → repeat until done. Works with any OpenAI-compatible API.

## Golden Flows (Regression Testing)

JSON-defined flows to keep drivers honest:

```bash
agent-control run-all    # Runs all platforms

# Web: 18-step form signup (5s)
# macOS: 11-step TextEdit CRUD (9s)
# iOS: 12-step Settings navigation (31s)
# Android: 6-step Settings About (23s)
```

## Limitations

- iOS: Simulator only (no real device)
- Web: No CAPTCHA/anti-bot bypass
- macOS: Requires Accessibility permission in System Settings
- Android: Experimental — uiautomator dump can be slow (~4s)

## License

MIT
