# agent-control

**Give your AI agent eyes and hands.**

One CLI, three platforms. Your agent sees the UI, picks an element, acts on it.

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
<p align="center"><sub>Web · macOS · iOS — same protocol, same refs, same commands</sub></p>

## Why

AI agents are smart but blind. They can reason, plan, and decide — but they can't see a button or click it.

agent-control gives them a universal interface to any GUI:
- **See** → `snapshot` returns interactive elements with semantic labels
- **Act** → `click @ref` / `fill @ref "text"` / `press key`
- **Verify** → `screenshot` captures the result

No Selenium. No Appium. No platform-specific test frameworks.  
One protocol. Three platforms. Works today.

## Quick Start

```bash
git clone https://github.com/momomo-agent/agent-control
cd agent-control && npm install

# Web (auto-starts Playwright daemon)
agent-control -p web open https://example.com
agent-control -p web -e snapshot
agent-control -p web click @e3

# macOS (any app, via Accessibility API)
agent-control -p macos --pid $(pgrep TextEdit) -e snapshot

# iOS Simulator (via macOS AX on Simulator process)
agent-control -p ios -e snapshot
```

## Commands

| Command | What it does |
|---------|-------------|
| `snapshot [-e]` | See UI elements. `-e` = enhanced (filtered + summary) |
| `click @ref` | Click / tap |
| `fill @ref "text"` | Clear + type |
| `select @ref "val"` | Select dropdown (web) |
| `press <key>` | Keyboard key |
| `screenshot [path]` | Save PNG |
| `open <url>` | Navigate (web) |
| `swipe <dir>` | Swipe (iOS) |

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
| **macOS** | Swift + Accessibility API | Use `--pid` to target any app. Needs Accessibility permission. |
| **iOS** | macOS AX on Simulator | Auto-detects booted sim. Uses Simulator's accessibility tree. |

## Enhanced Snapshot (`-e`)

Raw snapshot returns every element. Enhanced (`-e`) filters to interactive elements and adds a semantic summary — designed for LLM consumption:

```json
{
  "total": 118,
  "interactive": 4,
  "summary": "4 interactive elements (4×submit). Key: \"Log out\", \"+ New Item\"",
  "text": "@e7 button[submit] \"Log out\"\n@e9 button[submit] \"+ New Item\"",
  "elements": [...]
}
```

## Golden Flows (Regression Testing)

JSON-defined flows to keep drivers honest:

```bash
node run-all.js    # Runs all 3 platforms

# Web: 18-step form signup
# macOS: 11-step TextEdit CRUD
# iOS: 9-step Settings navigation
# Stability: 3/3 consecutive runs, zero flakes
```

## Limitations

- iOS: Simulator only (no real device)
- Web: No CAPTCHA/anti-bot bypass
- macOS: Requires Accessibility permission in System Settings
- Platforms run serially (focus is exclusive)

## License

MIT
