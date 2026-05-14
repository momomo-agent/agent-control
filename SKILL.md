---
name: agent-control
description: "Control apps and GUIs across platforms (macOS, Web, Electron, iOS, Android). Use when: automating UI interactions, clicking buttons, filling forms, taking screenshots, or any task requiring direct app manipulation. Primary interface: `agent-control screen` for full desktop awareness."
---

# agent-control

See, decide, act on any GUI. One command gives you the entire screen.

## Core Paradigm: `screen`

```bash
agent-control screen                          # see everything on screen
agent-control screen "App"                    # drill into an app
agent-control screen "App" --click @e3        # act on an element
agent-control screen --screenshot /tmp/s.png  # capture full screen
```

**No verb = snapshot.** The most common action (looking) has zero syntax overhead.
**Verb = act + auto-snapshot.** One round-trip: do something, see the result.

## The Loop

```
screen → decide → --verb → (auto returns new snapshot) → decide → ...
```

## `screen` Command

### See the whole screen

```bash
agent-control screen
```

Returns everything visible: menu bar, menu extras, dock, all windows — grouped by display on multi-monitor setups.

```
Screen [active: Cursor, 2 displays, 89 interactive]

  ┌ Display 1: Built-in Retina Display [2056×1329, main]
  │
  │ Menu Bar:
  │   @e1 MenuBarItem "Apple"
  │   @e2 MenuBarItem "Cursor"
  │   @e3 MenuBarItem "File"
  │   ...
  │ Menu Extras:
  │   @e12 MenuBarItem "电池" val="93%，正在充电"
  │   @e13 MenuBarItem "时钟" val="5月14日 周四 09:42"
  │   @e14 MenuBarItem "Wi‑Fi，已接入，3格"
  │ Dock:
  │   @e16 DockItem "访达"
  │   @e17 DockItem "Arc"
  │   @e18 DockItem "Discord"
  │   ...
  │ Cursor "main.swift — project": [active]
  │   - Group "editor area"
  │     @e50 TextField "Search"
  │     @e51 Button "Run"
  │   ...
  └
  ┌ Display 2: Studio Display [2560×1440]
  │ ...
  └
```

### Drill into an app

```bash
agent-control screen "Cursor"           # full AX tree of Cursor
agent-control screen "Chrome"           # AX tree + auto web content via CDP
```

Browser apps (Chrome/Arc/Edge/Brave) automatically append page DOM content when remote debugging is available.

### Act on elements

Verbs use `--` prefix. All verbs return a post-action snapshot automatically.

```bash
agent-control screen "Finder" --click @e3
agent-control screen "Cursor" --fill @e8 "hello world"
agent-control screen "Cursor" --press cmd+s
agent-control screen --click @e21              # click dock item (no app target)
agent-control screen "App" --dblclick @e5
agent-control screen "App" --rightclick @e3
agent-control screen "App" --longpress @e5
agent-control screen "App" --scroll down
agent-control screen "App" --drag @e1 @e5
```

### Read full element content

Tree output truncates long values (e.g. terminal buffers). Use `--read` to get the full content:

```bash
agent-control screen "Ghostty" --read @e1     # full terminal buffer (can be 200KB+)
agent-control screen "Cursor" --read @e8      # full text field content
```

Useful for terminals (Ghostty/iTerm/Terminal), text editors, and any TextArea with long content.

### Screenshot

```bash
agent-control screen --screenshot /tmp/full.png          # entire screen
agent-control screen "Simulator" --screenshot /tmp/s.png # single app window
```

### Flags

| Flag | Effect |
|------|--------|
| `--json` | JSON output instead of indented tree |
| `--bg` | Background mode (default, no focus steal) |
| `--fg` | Foreground mode (bring app to front) |
| `--no-snapshot` | Skip post-action snapshot |
| `--read @ref` | Read full AX value of an element (no truncation) |

## Legacy `-p` Interface

Still works for platform-specific operations:

```bash
# macOS (same as screen drill)
agent-control -p macos --app Finder snapshot
agent-control -p macos --app Finder click @e3

# Web (Playwright daemon)
agent-control -p web open https://example.com
agent-control -p web snapshot
agent-control -p web click @e3
agent-control -p web fill @e8 "Alice"

# Electron (CDP)
agent-control -p electron --port 9223 snapshot
agent-control -p electron --port 9223 click @e3

# iOS Simulator
agent-control -p ios snapshot
agent-control -p ios click @e5

# Android
agent-control -p android snapshot
```

## Key Behaviors

- **Background-first**: `--bg` is default. Actions go through AX API without stealing focus.
- **App-scoped screenshots**: `--app` captures only that window, not full screen.
- **Indented tree output**: Human and agent readable. `@ref` inline with elements.
- **Multi-display aware**: Windows grouped by which physical display they're on.
- **Z-order aware**: Windows sorted front-to-back. Top 3 expanded, rest collapsed to title.
- **Window refs (`@w`)**: Each window gets `@w1`, `@w2` etc. in z-order for disambiguation.
- **Browser auto-detection**: `screen "Chrome"` automatically fetches web page content via CDP.
- **Active app shown**: Header shows which app has focus; window sections tagged `[active]`.

## Output Format

`screen` output (full desktop):

```
Screen [active: Cursor, 2 displays, 89 interactive]

  Menu Bar:
    @e1 MenuBarItem "Apple"
    ...
  Dock:
    @e16 DockItem "访达"
    ...

  Windows:

    @w1 Cursor "main.swift": [active]
      @e50 TextField "Search"
      @e51 Button "Run"

    @w2 Discord "#dm": 
      @e60 Button "Send"

    @w3 Ghostty "Claude Code":
      @e70 TextArea val="...last 500 chars..."

    @w4 Finder "Downloads" [12 elements]
    @w5 Notion "notes" [3 elements]
```

- Top 3 windows expanded (by z-order), rest collapsed to `[N elements]`
- Collapsed windows: `screen "Notion"` to drill in
- Same-name windows disambiguated by `@w` ref

App drill output:

```
App "Finder" [42 interactive, 58 total]
- Group "sidebar"
  @e1 Button "AirDrop"
  @e2 Button "最近使用"
  @e3 Button "应用程序"
- Group "content"
  @e4 Image "Documents"
  @e5 Image "Downloads"
@e20 MenuBarItem "File"
  @e21 MenuItem "新建访达窗口"
  @e22 MenuItem "新建文件夹"
```

- Indentation = hierarchy
- `@ref` = interactive, can be targeted by verbs
- `- Role "label"` = container (not directly interactive)
- `[active]` / `val="..."` = state annotations

## Workflow Examples

### Navigate an app

```bash
agent-control screen                    # what's on screen?
agent-control screen "Finder"           # drill into Finder
agent-control screen "Finder" --click @e3   # click something
# → auto-returns updated snapshot
```

### Open an app from Dock

```bash
agent-control screen                    # see dock items
agent-control screen --click @e28       # click Discord in dock
```

### Use menu bar

```bash
agent-control screen                    # see menu bar items
agent-control screen --click @e3        # click "File" menu
agent-control screen "Finder"           # see expanded menu items
agent-control screen "Finder" --click @e22  # click "新建文件夹"
```

### Browser workflow

```bash
agent-control screen "Chrome"           # AX tree + web page content
agent-control screen "Chrome" --click @w5   # click web element
agent-control screen "Chrome" --fill @e12 "search query"  # fill address bar
```

## Install

```bash
npm install -g agent-control
# or
git clone https://github.com/momomo-agent/agent-control
cd agent-control && npm install && npm link
```

macOS driver requires building:
```bash
cd macos-driver && swift build -c release
```

## Requirements

- **macOS**: Accessibility permission (System Settings > Privacy > Accessibility)
- **Web**: Chromium-based browser or Playwright
- **iOS**: Xcode + Simulator
- **Android**: adb + device/emulator
- **Browser CDP**: Chrome launched with `--remote-debugging-port=9222`
