# agent-control

> One protocol, three platforms. Give AI hands.

AI operation layer that lets agents see and interact with any app through a unified `snapshot / click / fill / drag / screenshot` interface.

```
┌─────────────┐
│   AI Agent   │  ← brain (you provide)
├─────────────┤
│ agent-control│  ← eyes + hands (this project)
├──────┬──────┬─────┬─────────┤
│macOS │ Web  │ iOS │ Android │
│ AX   │Playw.│ idb │  adb    │
└──────┴──────┴─────┴─────────┘
```

## Install

```bash
npm i -g agent-control
```

macOS driver requires building the Swift binary:
```bash
cd node_modules/agent-control/macos-driver && swift build
```

## Usage

```bash
# macOS — operate any app via Accessibility API
agent-control -p macos --pid $(pgrep TextEdit) snapshot -i
agent-control -p macos --pid $(pgrep TextEdit) click @e3
agent-control -p macos --pid $(pgrep TextEdit) screenshot out.png

# Web — operate any page via Playwright
agent-control -p web open https://example.com
agent-control -p web snapshot -i
agent-control -p web fill @e1 "hello"
agent-control -p web screenshot out.png

# iOS — operate simulator via idb
agent-control -p ios snapshot -i
agent-control -p ios tap @e2
agent-control -p ios screenshot out.png

# Android — operate device/emulator via adb
agent-control -p android snapshot -i
agent-control -p android tap @e2
agent-control -p android screenshot out.png
agent-control -p android open com.android.chrome
agent-control -p android swipe up
```

## Unified Actions

| Action | macOS | Web | iOS | Android |
|--------|-------|-----|-----|---------|
| `snapshot` | AX tree | DOM tree | idb describe-all | uiautomator dump |
| `click` | AXPress / CGEvent | mouse.click | idb tap | adb input tap |
| `fill` | AXSetValue / keyboard | keyboard.type | idb text | adb input text |
| `screenshot` | screencapture -l | page.screenshot | simctl io | adb screencap + pull |
| `drag` | CGEvent | mouse.drag | idb swipe | adb input swipe |
| `scroll` | AXScroll | mouse.wheel | idb swipe | adb input swipe |
| `press` | CGEvent key | keyboard.press | idb key | adb input keyevent |

## Goal Runner

Observe → Decide → Act loop with visual HTML reports:

```bash
agent-control -p macos --pid 1234 observe --note "checking file tree"
agent-control -p macos --pid 1234 act-observe dblclick @e5 --note "opening README"
agent-control report    # generates HTML report with screenshots
```

## Two Modes

- **DBB** — pre-orchestrated scenarios for regression/CI (`dbb-runner.js`)
- **Goal** — observe→decide→act loop for autonomous operation (`goal-runner.js`)

## License

MIT
