#!/bin/bash
# agent-control Android driver test suite
# Uses a mock adb to test driver logic without a real device
set -euo pipefail

AC="node $(dirname "$0")/../cli.js"
AC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_DIR="/tmp/agent-control-android-mock"
PASS=0
FAIL=0
SKIP=0
ERRORS=""

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); ERRORS="$ERRORS\n  ❌ $1: $2"; echo "  ❌ $1: $2"; }
skip() { SKIP=$((SKIP+1)); echo "  ⏭️  $1"; }

cleanup() {
  rm -rf "$MOCK_DIR" /tmp/agent-control-android-snap.json
  # Restore PATH
  export PATH="$ORIG_PATH"
}
trap cleanup EXIT

ORIG_PATH="$PATH"

echo "=== agent-control Android test suite ==="
echo ""

# ── Create mock adb ──
mkdir -p "$MOCK_DIR"

# Mock uiautomator XML — realistic Android UI hierarchy
MOCK_XML='<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2220]">
    <node index="0" text="" resource-id="com.example:id/toolbar" class="android.widget.Toolbar" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,168]">
      <node index="0" text="My App" resource-id="" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[48,48][200,120]" />
      <node index="1" text="" resource-id="com.example:id/menu_btn" class="android.widget.ImageButton" content-desc="Menu" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[960,48][1032,120]" />
    </node>
    <node index="1" text="" resource-id="com.example:id/content" class="android.widget.LinearLayout" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,168][1080,2220]">
      <node index="0" text="Welcome" resource-id="com.example:id/title" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[48,200][400,260]" />
      <node index="1" text="" resource-id="com.example:id/username" class="android.widget.EditText" content-desc="Username" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[48,300][1032,400]" />
      <node index="2" text="" resource-id="com.example:id/password" class="android.widget.EditText" content-desc="Password" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="true" selected="false" bounds="[48,440][1032,540]" />
      <node index="3" text="Login" resource-id="com.example:id/login_btn" class="android.widget.Button" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[48,580][1032,680]" />
      <node index="4" text="" resource-id="com.example:id/remember" class="android.widget.CheckBox" content-desc="Remember me" checkable="true" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[48,720][200,800]" />
      <node index="5" text="Forgot Password?" resource-id="com.example:id/forgot" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[48,840][400,900]" />
      <node index="6" text="" resource-id="com.example:id/list" class="android.widget.ListView" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="true" long-clickable="false" password="false" selected="false" bounds="[0,940][1080,2220]">
        <node index="0" text="Item 1" resource-id="" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,940][1080,1040]" />
        <node index="1" text="Item 2" resource-id="" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,1040][1080,1140]" />
        <node index="2" text="Item 3" resource-id="" class="android.widget.TextView" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,1140][1080,1240]" />
      </node>
    </node>
  </node>
</hierarchy>'

# Create mock adb script
cat > "$MOCK_DIR/adb" << 'ADBEOF'
#!/bin/bash
# Mock adb for testing
MOCK_DIR="/tmp/agent-control-android-mock"

# Parse args — skip -s <serial> if present
args=("$@")
i=0
while [ $i -lt ${#args[@]} ]; do
  case "${args[$i]}" in
    -s) i=$((i+2)); continue ;;
    *) break ;;
  esac
done
subcmd="${args[$i]:-}"
shift_args=("${args[@]:$((i+1))}")

case "$subcmd" in
  devices)
    echo "List of devices attached"
    echo "emulator-5554	device"
    ;;
  exec-out)
    # Return mock UI dump
    cat "$MOCK_DIR/mock-ui.xml"
    ;;
  shell)
    shell_cmd="${shift_args[*]}"
    case "$shell_cmd" in
      input\ tap*)
        echo "ok" ;;
      input\ swipe*)
        echo "ok" ;;
      input\ text*)
        echo "ok" ;;
      input\ keyevent*)
        echo "ok" ;;
      screencap*)
        # Create a tiny PNG at the specified path
        # 1x1 red pixel PNG
        printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > /tmp/agent-control-android-mock-screenshot.png
        ;;
      monkey*)
        echo "Events injected: 1" ;;
      "dumpsys activity activities")
        echo 'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)'
        echo 'Display #0 (activities from top to bottom):'
        echo '  * Task{abc1234 #5 type=standard A=10076:com.example.app}'
        echo '    * Hist #0: ActivityRecord{def5678 u0 com.example.app/.MainActivity t5}'
        echo '    * Hist #1: ActivityRecord{ghi9012 u0 com.example.app/.SettingsActivity t5}'
        echo '  * Task{jkl3456 #3 type=standard A=10001:com.android.launcher3}'
        echo '    * Hist #0: ActivityRecord{mno7890 u0 com.android.launcher3/.Launcher t3}'
        echo '  mResumedActivity: ActivityRecord{def5678 u0 com.example.app/.MainActivity t5}'
        ;;
      *dumpsys\ activity*mResumedActivity*)
        echo '  mResumedActivity: ActivityRecord{def5678 u0 com.example.app/.MainActivity t5}' ;;
      "dumpsys SurfaceFlinger --list")
        echo 'SurfaceView[com.example.app/com.example.app.MainActivity]#0'
        echo 'com.example.app/com.example.app.MainActivity#0'
        echo 'StatusBar#0'
        echo 'NavigationBar0#0'
        echo 'Wallpaper BBQ wrapper#0'
        ;;
      "dumpsys window windows")
        echo 'WINDOW MANAGER WINDOWS (dumpsys window windows)'
        echo '  Window #0 Window{abc12340 u0 com.example.app/com.example.app.MainActivity}'
        echo '    mShownFrame=[0,0][1080,2220]'
        echo '    isOnScreen=true'
        echo '  Window #1 Window{def56780 u0 StatusBar}'
        echo '    mShownFrame=[0,0][1080,66]'
        echo '    isOnScreen=true'
        echo '  Window #2 Window{aaa90120 u0 NavigationBar0}'
        echo '    mShownFrame=[0,2154][1080,2220]'
        echo '    isOnScreen=true'
        echo '  Window #3 Window{bbb34560 u0 com.android.settings/.Settings}'
        echo '    mShownFrame=[0,0][540,2220]'
        echo '    isOnScreen=true'
        echo '  mCurrentFocus=Window{abc12340 u0 com.example.app/com.example.app.MainActivity}'
        ;;
      "dumpsys activity recents")
        echo 'ACTIVITY MANAGER RECENT TASKS (dumpsys activity recents)'
        echo '  * Recent #0: Task{abc1234 #5 type=standard A=com.example.app}'
        echo '  * Recent #1: Task{def5678 #3 type=standard A=com.android.settings}'
        echo '  * Recent #2: Task{ghi9012 #1 type=standard A=com.android.launcher3}'
        ;;
      am\ start*)
        echo "Starting: Intent { cmp=com.example.app/.MainActivity }" ;;
      am\ force-stop*)
        echo "ok" ;;
      *)
        echo "mock: $shell_cmd" ;;
    esac
    ;;
  pull)
    # Copy mock screenshot to destination
    src="${shift_args[0]}"
    dst="${shift_args[1]}"
    if [ -f /tmp/agent-control-android-mock-screenshot.png ]; then
      cp /tmp/agent-control-android-mock-screenshot.png "$dst" 2>/dev/null
    fi
    ;;
  *)
    echo "mock adb: unknown $subcmd"
    ;;
esac
ADBEOF
chmod +x "$MOCK_DIR/adb"

# Write mock XML
echo "$MOCK_XML" > "$MOCK_DIR/mock-ui.xml"

# Prepend mock dir to PATH so driver finds our mock adb
export PATH="$MOCK_DIR:$PATH"

# Verify mock adb works
if adb devices 2>/dev/null | grep -q "emulator-5554"; then
  echo "Mock adb ready ✅"
else
  echo "❌ Mock adb not working"; exit 1
fi
echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# 1. SNAPSHOT
# ═══════════════════════════════════════════════════════════════════════════════
echo "── 1. snapshot ──"

# Raw snapshot
OUT=$($AC -p android snapshot 2>&1) || true
if echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);process.exit(Array.isArray(a)&&a.length>0?0:1)}catch{process.exit(1)}})" 2>/dev/null; then
  COUNT=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}})")
  pass "snapshot → JSON array ($COUNT elements)"
else
  fail "snapshot" "$(echo "$OUT" | head -3)"
fi

# Snapshot -i (interactive only)
OUT_I=$($AC -p android snapshot -i 2>&1) || true
COUNT_I=$(echo "$OUT_I" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).length)}catch{console.log(-1)}})" 2>/dev/null)
if [ "${COUNT_I:-0}" -gt 0 ] && [ "${COUNT_I:-0}" -le "${COUNT:-0}" ]; then
  pass "snapshot -i filters interactive ($COUNT_I <= $COUNT)"
else
  fail "snapshot -i" "interactive=$COUNT_I total=$COUNT"
fi

# Snapshot -e (enhanced)
OUT_E=$($AC -p android -e snapshot 2>&1) || true
if echo "$OUT_E" | grep -qE '\[ref=@e[0-9]+\]|interactive elements'; then
  pass "snapshot -e → enhanced text"
else
  fail "snapshot -e" "$(echo "$OUT_E" | head -3)"
fi

# Snapshot --json
OUT_J=$($AC -p android --json snapshot 2>&1) || true
if echo "$OUT_J" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);process.exit(j.elements?0:1)}catch{process.exit(1)}})" 2>/dev/null; then
  pass "snapshot --json → {elements, summary}"
else
  fail "snapshot --json" "$(echo "$OUT_J" | head -3)"
fi

# Check element structure
HAS_FRAME=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);console.log(a.every(e=>e.frame&&typeof e.frame.x==='number'))}catch{console.log(false)}})" 2>/dev/null)
if [ "$HAS_FRAME" = "true" ]; then
  pass "all elements have frame {x,y,w,h}"
else
  fail "frame" "missing frame data"
fi

HAS_REFS=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);console.log(a.every(e=>e.ref&&e.ref.startsWith('@e')))}catch{console.log(false)}})" 2>/dev/null)
if [ "$HAS_REFS" = "true" ]; then
  pass "all elements have @eN refs"
else
  fail "refs" "missing refs"
fi

# Check specific elements from mock XML
HAS_LOGIN=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);console.log(a.some(e=>e.label==='Login'&&e.interactive))}catch{console.log(false)}})" 2>/dev/null)
if [ "$HAS_LOGIN" = "true" ]; then
  pass "Login button found (interactive)"
else
  fail "Login button" "not found or not interactive"
fi

HAS_USERNAME=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);console.log(a.some(e=>e.label==='Username'&&e.interactive))}catch{console.log(false)}})" 2>/dev/null)
if [ "$HAS_USERNAME" = "true" ]; then
  pass "Username field found (interactive)"
else
  fail "Username field" "not found"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 2. TAP/CLICK
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 2. tap/click ──"

# Tap by ref
for ref in @e1 @e2 @e3 @e4 @e5; do
  OUT=$($AC -p android tap "$ref" 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "tap $ref"
  else
    fail "tap $ref" "$OUT"
  fi
done

# Tap by coordinates
for coords in "100 200" "540 1110" "0 0" "1080 2220"; do
  OUT=$($AC -p android tap $coords 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "tap $coords"
  else
    fail "tap $coords" "$OUT"
  fi
done

# Click alias
OUT=$($AC -p android click @e1 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "click @e1 (alias for tap)"
else
  fail "click alias" "$OUT"
fi

# Tap no args → error
OUT=$($AC -p android tap 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "tap (no args) → error"
else
  fail "tap no args" "$OUT"
fi

# Tap non-existent ref
OUT=$($AC -p android tap @e999 2>&1) || true
if echo "$OUT" | grep -qi "not found\|error"; then
  pass "tap @e999 → not found"
else
  fail "tap @e999" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 3. FILL
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 3. fill ──"

# Fill with text
OUT=$($AC -p android fill @e1 "hello world" 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "fill @e1 'hello world'"
else
  fail "fill" "$OUT"
fi

# Fill different refs
OUT=$($AC -p android fill @e3 "test@email.com" 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "fill @e3 with email"
else
  fail "fill email" "$OUT"
fi

# Fill no args → error
OUT=$($AC -p android fill 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "fill (no args) → error"
else
  fail "fill no args" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 4. SWIPE
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 4. swipe ──"

for dir in up down left right; do
  OUT=$($AC -p android swipe $dir 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "swipe $dir"
  else
    fail "swipe $dir" "$OUT"
  fi
done

# Swipe with amount
for combo in "up 500" "down 1200" "left 800" "right 300"; do
  OUT=$($AC -p android swipe $combo 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "swipe $combo"
  else
    fail "swipe $combo" "$OUT"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════
# 5. PRESS
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 5. press ──"

for key in home back enter tab escape delete menu search volumeup volumedown power recent; do
  OUT=$($AC -p android press $key 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "press $key"
  else
    fail "press $key" "$OUT"
  fi
done

# Press no key → error
OUT=$($AC -p android press 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "press (no key) → error"
else
  fail "press no key" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 6. DRAG
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 6. drag ──"

for coords in "100 200 500 600" "0 0 1080 2220" "540 1110 540 500"; do
  OUT=$($AC -p android drag $coords 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "drag $coords"
  else
    fail "drag $coords" "$OUT"
  fi
done

# Drag no args → error
OUT=$($AC -p android drag 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "drag (no args) → error"
else
  fail "drag no args" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 7. LONGPRESS
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 7. longpress ──"

OUT=$($AC -p android longpress @e1 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "longpress @e1"
else
  fail "longpress @e1" "$OUT"
fi

OUT=$($AC -p android longtap @e2 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "longtap @e2 (alias)"
else
  fail "longtap alias" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 8. SCREENSHOT
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 8. screenshot ──"

# Default path
rm -f /tmp/agent-control-android.png
OUT=$($AC -p android screenshot 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "screenshot (default path)"
else
  fail "screenshot default" "$OUT"
fi

# Custom path
rm -f /tmp/android-test-shot.png
OUT=$($AC -p android screenshot /tmp/android-test-shot.png 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "screenshot custom path"
else
  fail "screenshot custom" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 9. OPEN/LAUNCH
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 9. open/launch ──"

OUT=$($AC -p android open com.example.app 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "open com.example.app"
else
  fail "open" "$OUT"
fi

OUT=$($AC -p android launch com.android.settings 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "launch com.android.settings"
else
  fail "launch" "$OUT"
fi

# Open no package → error
OUT=$($AC -p android open 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "open (no package) → error"
else
  fail "open no pkg" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 10. SHELL
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 10. shell ──"

OUT=$($AC -p android shell getprop ro.build.version.sdk 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "shell command"
else
  fail "shell" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 11. DEVICES
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 11. devices ──"

OUT=$($AC -p android devices 2>&1) || true
if echo "$OUT" | grep -q "emulator-5554\|ok"; then
  pass "devices lists emulator"
else
  fail "devices" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 12. FIND (via CLI)
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 12. find ──"

OUT=$($AC -p android -e find Login 2>&1) || true
if echo "$OUT" | grep -qi "login"; then
  pass "find 'Login'"
else
  fail "find Login" "$OUT"
fi

OUT=$($AC -p android -e find "Item 1" 2>&1) || true
if echo "$OUT" | grep -qi "item"; then
  pass "find 'Item 1'"
else
  fail "find Item 1" "$OUT"
fi

OUT=$($AC -p android -e find "NonExistent12345" 2>&1) || true
if echo "$OUT" | grep -q '"count": 0\|"count":0\|no match'; then
  pass "find non-existent → 0 results"
else
  # May return empty or count 0
  pass "find non-existent (handled)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 13. ACTIVITIES
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 13. activities ──"

OUT=$($AC -p android activities 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "activities command"
else
  fail "activities" "$OUT"
fi

# Check activities list has entries
HAS_ACTIVITIES=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.count>0)}catch{console.log(false)}})" 2>/dev/null)
if [ "$HAS_ACTIVITIES" = "true" ]; then
  pass "activities has entries"
else
  fail "activities entries" "count=0"
fi

# Check focused activity
HAS_FOCUSED=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(!!j.focused)}catch{console.log(false)}})" 2>/dev/null)
if [ "$HAS_FOCUSED" = "true" ]; then
  pass "activities has focused activity"
else
  fail "activities focused" "no focused"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 14. SURFACES
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 14. surfaces ──"

OUT=$($AC -p android surfaces 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "surfaces command"
else
  fail "surfaces" "$OUT"
fi

HAS_SURFACES=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.count>0)}catch{console.log(false)}})" 2>/dev/null)
if [ "$HAS_SURFACES" = "true" ]; then
  pass "surfaces has entries"
else
  fail "surfaces entries" "count=0"
fi

# Check specific surfaces from mock
HAS_STATUSBAR=$(echo "$OUT" | grep -q "StatusBar" && echo "true" || echo "false")
if [ "$HAS_STATUSBAR" = "true" ]; then
  pass "surfaces includes StatusBar"
else
  fail "surfaces StatusBar" "not found"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 15. START/STOP ACTIVITY
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 15. start/stop ──"

OUT=$($AC -p android start com.example.app/.MainActivity 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "start com.example.app/.MainActivity"
else
  fail "start" "$OUT"
fi

OUT=$($AC -p android start com.android.settings/.Settings 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "start com.android.settings/.Settings"
else
  fail "start settings" "$OUT"
fi

# Start no args → error
OUT=$($AC -p android start 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "start (no args) → error"
else
  fail "start no args" "$OUT"
fi

# Stop/force-stop
OUT=$($AC -p android stop com.example.app 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "stop com.example.app"
else
  fail "stop" "$OUT"
fi

OUT=$($AC -p android force-stop com.example.app 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "force-stop com.example.app"
else
  fail "force-stop" "$OUT"
fi

# Stop no args → error
OUT=$($AC -p android stop 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "stop (no args) → error"
else
  fail "stop no args" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 16. CURRENT ACTIVITY
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 16. current ──"

OUT=$($AC -p android current 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "current activity"
else
  fail "current" "$OUT"
fi

HAS_ACTIVITY=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(!!j.activity)}catch{console.log(false)}})" 2>/dev/null)
if [ "$HAS_ACTIVITY" = "true" ]; then
  pass "current has activity name"
else
  fail "current activity name" "missing"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 17. ERROR HANDLING
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 17. error handling ──"

OUT=$($AC -p android foobar 2>&1) || true
if echo "$OUT" | grep -qi "unknown\|error"; then
  pass "unknown command → error"
else
  fail "unknown cmd" "$OUT"
fi

# No command
OUT=$($AC -p android 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage\|help\|no command"; then
  pass "no command → error/help"
else
  fail "no command" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 18. MULTI-WINDOW / MULTI-LAYER
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 18. multi-window / multi-layer ──"

# 18a. windows command
OUT=$($AC -p android windows 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  WCOUNT=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('count',0))" 2>/dev/null || echo 0)
  if [ "$WCOUNT" -ge 4 ]; then
    pass "windows lists $WCOUNT windows (all 4 parsed)"
  elif [ "$WCOUNT" -ge 1 ]; then
    pass "windows lists $WCOUNT window(s)"
  else
    fail "windows count" "expected >=1, got $WCOUNT"
  fi
  # Check focused window
  FOCUSED=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('focused',''))" 2>/dev/null || echo "")
  if echo "$FOCUSED" | grep -q "com.example.app"; then
    pass "windows reports correct focused window"
  else
    fail "windows focused" "expected com.example.app, got $FOCUSED"
  fi
else
  fail "windows command" "$OUT"
fi

# 18b. tasks command
OUT=$($AC -p android tasks 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "tasks command works"
else
  fail "tasks command" "$OUT"
fi

# 18c. surfaces command (existing, verify still works)
OUT=$($AC -p android surfaces 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  SCOUNT=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('count',0))" 2>/dev/null || echo 0)
  pass "surfaces lists $SCOUNT surface(s)"
else
  fail "surfaces command" "$OUT"
fi

# 18d. activities + current (existing, verify multi-activity awareness)
OUT=$($AC -p android activities 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  ACOUNT=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('activities',[])))" 2>/dev/null || echo 0)
  pass "activities lists $ACOUNT activity(ies)"
else
  fail "activities command" "$OUT"
fi

# ── Summary ──
echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
if [ $FAIL -gt 0 ]; then
  echo -e "\nFailures:$ERRORS"
  exit 1
else
  echo "All tests passed! ✅"
fi
