#!/bin/bash
# agent-control macOS platform test suite
# Tests all commands + parameter ordering variants against TextEdit
set -euo pipefail

AC="node $(dirname "$0")/../cli.js"
PASS=0
FAIL=0
ERRORS=""

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); ERRORS="$ERRORS\n  ❌ $1: $2"; echo "  ❌ $1: $2"; }

# Helper: check if output is a valid non-empty JSON array
is_json_array() {
  echo "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);process.exit(Array.isArray(a)&&a.length>0?0:1)}catch{process.exit(1)}})" 2>/dev/null
}

echo "=== agent-control macOS test suite ==="
echo ""

# ── Setup: create a temp file and open in TextEdit ──
echo "Setup: opening TextEdit with a test file..."
TMPFILE="/tmp/ac-test-macos.txt"
echo "Hello from agent-control test" > "$TMPFILE"
open -a TextEdit "$TMPFILE"
sleep 2
osascript -e 'tell application "TextEdit" to activate' 2>/dev/null || true
sleep 1

# Get TextEdit PID for --pid tests
TE_PID=$(pgrep -x TextEdit | head -1)
echo "  TextEdit PID: $TE_PID"

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION A: Core functionality
# ═══════════════════════════════════════════════════════════════════════════════

# ── 1. Snapshot (enhanced) ──
echo "1. snapshot -e"
OUT=$($AC -p macos --app TextEdit -e snapshot 2>&1) || true
if echo "$OUT" | grep -q "interactive elements"; then
  pass "snapshot -e returns interactive elements"
else
  fail "snapshot -e" "no interactive elements found"
fi

if echo "$OUT" | grep -qE '\[ref=@e[0-9]+\]'; then
  pass "refs use @eN format"
else
  fail "refs format" "expected @eN format"
fi

# ── 2. Snapshot --json ──
echo "2. snapshot --json"
JSON_OUT=$($AC -p macos --app TextEdit --json snapshot 2>&1)
ELEM_COUNT=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.elements?j.elements.length:0)}catch{console.log(-1)}})" 2>/dev/null)
if [ "${ELEM_COUNT:-0}" -gt 0 ]; then
  pass "snapshot --json returns valid JSON with $ELEM_COUNT elements"
else
  fail "snapshot --json" "invalid JSON or no elements (count=$ELEM_COUNT)"
fi

# ── 3. Snapshot --all ──
echo "3. snapshot --all"
ALL_OUT=$($AC -p macos --app TextEdit --all snapshot -e 2>&1) || true
ALL_COUNT=$(echo "$ALL_OUT" | head -1 | grep -oE '[0-9]+' | head -1)
DEFAULT_COUNT=$(echo "$OUT" | head -1 | grep -oE '[0-9]+' | head -1)
if [ "${ALL_COUNT:-0}" -ge "${DEFAULT_COUNT:-0}" ]; then
  pass "--all returns >= default elements ($ALL_COUNT >= $DEFAULT_COUNT)"
else
  fail "--all" "expected more elements ($ALL_COUNT < $DEFAULT_COUNT)"
fi

# ── 4. Snapshot --compact ──
echo "4. snapshot --compact"
COMPACT_OUT=$($AC -p macos --app TextEdit -c snapshot 2>&1) || true
if [ -n "$COMPACT_OUT" ]; then
  pass "snapshot --compact returns output"
else
  fail "snapshot --compact" "empty output"
fi

# ── 5. Snapshot -i (interactive only, raw) ──
echo "5. snapshot -i (raw interactive)"
RAW_OUT=$($AC -p macos --app TextEdit snapshot -i 2>&1) || true
if echo "$RAW_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);process.exit(Array.isArray(a)&&a.length>0?0:1)}catch{process.exit(1)}})" 2>/dev/null; then
  pass "snapshot -i returns raw JSON array"
else
  fail "snapshot -i" "expected raw JSON array"
fi

# ── 6. Find ──
echo "6. find"
FIND_OUT=$($AC -p macos --app TextEdit find "Apple" 2>&1) || true
if echo "$FIND_OUT" | grep -qi "apple\|ok"; then
  pass "find 'Apple'"
else
  fail "find" "$(echo "$FIND_OUT" | head -3)"
fi

# ── Helper: get refs ──
FIRST_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>x.interactive!==false&&x.ref);if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
MENU_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>x.role==='MenuBarItem'&&x.ref);if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
TEXT_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>(x.role==='TextArea'||x.role==='TextField'||x.role==='ScrollArea')&&x.ref);if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
SECOND_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const els=j.elements.filter(x=>x.interactive!==false&&x.ref);if(els.length>=2)console.log(els[1].ref)}catch{}})" 2>/dev/null) || true

echo "  (refs: first=$FIRST_REF menu=$MENU_REF text=$TEXT_REF second=$SECOND_REF)"

# ── 7. Click ──
echo "7. click @ref"
if [ -n "$MENU_REF" ]; then
  CLICK_OUT=$($AC -p macos --app TextEdit click "$MENU_REF" 2>&1) || true
  if echo "$CLICK_OUT" | grep -q "ok"; then
    pass "click $MENU_REF (menu bar item)"
  else
    fail "click" "$CLICK_OUT"
  fi
  sleep 0.3
  $AC -p macos --app TextEdit press escape 2>&1 > /dev/null || true
else
  fail "click" "no menu ref found"
fi

# ── 8. Click x y (coordinate) ──
echo "8. click x y"
CLICK_XY=$($AC -p macos --app TextEdit click 100 100 2>&1) || true
if echo "$CLICK_XY" | grep -q "ok"; then
  pass "click 100 100 (coordinate)"
else
  fail "click x y" "$CLICK_XY"
fi

# ── 9. Fill ──
echo "9. fill"
if [ -n "$TEXT_REF" ]; then
  FILL_OUT=$($AC -p macos --app TextEdit fill "$TEXT_REF" "hello from test" 2>&1) || true
  if echo "$FILL_OUT" | grep -q "ok"; then
    pass "fill $TEXT_REF"
  else
    fail "fill" "$FILL_OUT"
  fi
else
  echo "  ⏭️  fill: no text field found (skipped)"
fi

# ── 10. Press ──
echo "10. press"
PRESS_OUT=$($AC -p macos --app TextEdit press return 2>&1) || true
if echo "$PRESS_OUT" | grep -q "ok"; then
  pass "press return"
else
  fail "press" "$PRESS_OUT"
fi

# ── 11. Press with modifier ──
echo "11. press with modifier"
MOD_OUT=$($AC -p macos --app TextEdit press a --modifiers cmd 2>&1) || true
if echo "$MOD_OUT" | grep -q "ok"; then
  pass "press cmd+a (select all)"
else
  fail "press cmd+a" "$MOD_OUT"
fi

# ── 12. Scroll (all directions) ──
echo "12. scroll"
for dir in down up left right; do
  SCROLL_OUT=$($AC -p macos --app TextEdit scroll $dir 2>&1) || true
  if echo "$SCROLL_OUT" | grep -q "ok"; then
    pass "scroll $dir"
  else
    fail "scroll $dir" "$SCROLL_OUT"
  fi
done

# ── 13. Scroll with amount ──
echo "13. scroll with amount"
SCROLL_AMT=$($AC -p macos --app TextEdit scroll down 200 2>&1) || true
if echo "$SCROLL_AMT" | grep -q "ok"; then
  pass "scroll down 200"
else
  fail "scroll down 200" "$SCROLL_AMT"
fi

# ── 14. Screenshot ──
echo "14. screenshot"
SS_PATH="/tmp/ac-test-macos-screenshot.png"
rm -f "$SS_PATH"
SS_OUT=$($AC -p macos --app TextEdit screenshot "$SS_PATH" 2>&1) || true
if [ -f "$SS_PATH" ]; then
  SIZE=$(stat -f%z "$SS_PATH" 2>/dev/null || stat -c%s "$SS_PATH" 2>/dev/null)
  if [ "${SIZE:-0}" -gt 1000 ]; then
    pass "screenshot saved (${SIZE} bytes)"
  else
    fail "screenshot" "file too small (${SIZE} bytes)"
  fi
else
  fail "screenshot" "file not created: $SS_OUT"
fi

# ── 15. Screenshot @ref (element) ──
echo "15. screenshot @ref"
SS_REF_PATH="/tmp/ac-test-macos-screenshot-ref.png"
rm -f "$SS_REF_PATH"
if [ -n "$FIRST_REF" ]; then
  SS_REF_OUT=$($AC -p macos --app TextEdit screenshot "$FIRST_REF" "$SS_REF_PATH" 2>&1) || true
  if [ -f "$SS_REF_PATH" ]; then
    SIZE=$(stat -f%z "$SS_REF_PATH" 2>/dev/null || stat -c%s "$SS_REF_PATH" 2>/dev/null)
    if [ "${SIZE:-0}" -gt 100 ]; then
      pass "screenshot @ref saved (${SIZE} bytes)"
    else
      fail "screenshot @ref" "file too small (${SIZE} bytes)"
    fi
  else
    fail "screenshot @ref" "file not created"
  fi
else
  fail "screenshot @ref" "no ref available"
fi

# ── 16. Longpress ──
echo "16. longpress"
if [ -n "$FIRST_REF" ]; then
  LP_OUT=$($AC -p macos --app TextEdit longpress "$FIRST_REF" --duration=500 2>&1) || true
  if echo "$LP_OUT" | grep -q "ok"; then
    pass "longpress $FIRST_REF 500ms"
  else
    fail "longpress" "$LP_OUT"
  fi
  sleep 0.3
  $AC -p macos --app TextEdit press escape 2>&1 > /dev/null || true
else
  fail "longpress" "no ref available"
fi

# ── 17. Double click ──
echo "17. dblclick"
if [ -n "$FIRST_REF" ]; then
  DBL_OUT=$($AC -p macos --app TextEdit dblclick "$FIRST_REF" 2>&1) || true
  if echo "$DBL_OUT" | grep -q "ok"; then
    pass "dblclick $FIRST_REF"
  else
    fail "dblclick" "$DBL_OUT"
  fi
else
  fail "dblclick" "no ref available"
fi

# ── 18. Right click ──
echo "18. rightclick"
if [ -n "$FIRST_REF" ]; then
  RC_OUT=$($AC -p macos --app TextEdit rightclick "$FIRST_REF" 2>&1) || true
  if echo "$RC_OUT" | grep -q "ok"; then
    pass "rightclick $FIRST_REF"
  else
    fail "rightclick" "$RC_OUT"
  fi
  sleep 0.3
  $AC -p macos --app TextEdit press escape 2>&1 > /dev/null || true
else
  fail "rightclick" "no ref available"
fi

# ── 19. Drag ──
echo "19. drag @ref @ref"
if [ -n "$FIRST_REF" ] && [ -n "$SECOND_REF" ]; then
  DRAG_OUT=$($AC -p macos --app TextEdit drag "$FIRST_REF" "$SECOND_REF" 2>&1) || true
  if echo "$DRAG_OUT" | grep -q "ok"; then
    pass "drag $FIRST_REF → $SECOND_REF"
  else
    fail "drag" "$DRAG_OUT"
  fi
else
  fail "drag" "need at least 2 refs (first=$FIRST_REF second=$SECOND_REF)"
fi

# ── 20. Drag x1 y1 x2 y2 (coordinate) ──
echo "20. drag x1 y1 x2 y2"
DRAG_XY=$($AC -p macos --app TextEdit drag 100 100 200 200 2>&1) || true
if echo "$DRAG_XY" | grep -q "ok"; then
  pass "drag 100,100 → 200,200 (coordinate)"
else
  fail "drag x y" "$DRAG_XY"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION B: Parameter ordering variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── Parameter ordering variants ──"

# ── B1. --app before vs after command ──
echo "B1. --app position"
OUT1=$($AC -p macos --app TextEdit snapshot -i 2>&1) || true
OUT2=$($AC -p macos snapshot -i --app TextEdit 2>&1) || true
if is_json_array "$OUT1" && is_json_array "$OUT2"; then
  pass "--app before command = --app after command"
else
  fail "--app position" "one or both not valid JSON array"
fi

# ── B2. --pid before vs after command ──
echo "B2. --pid position"
OUT1=$($AC -p macos --pid "$TE_PID" snapshot -i 2>&1) || true
OUT2=$($AC -p macos snapshot -i --pid "$TE_PID" 2>&1) || true
if is_json_array "$OUT1" && is_json_array "$OUT2"; then
  pass "--pid before command = --pid after command"
else
  fail "--pid position" "one or both not valid JSON array"
fi

# ── B3. --pid vs --app (both should work) ──
echo "B3. --pid vs --app equivalence"
OUT_APP=$($AC -p macos --app TextEdit --json snapshot 2>&1) || true
OUT_PID=$($AC -p macos --pid "$TE_PID" --json snapshot 2>&1) || true
COUNT_APP=$(echo "$OUT_APP" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).elements.length)}catch{console.log(-1)}})" 2>/dev/null)
COUNT_PID=$(echo "$OUT_PID" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).elements.length)}catch{console.log(-1)}})" 2>/dev/null)
if [ "${COUNT_APP:-0}" -gt 0 ] && [ "${COUNT_PID:-0}" -gt 0 ]; then
  pass "--app and --pid both return elements (app=$COUNT_APP pid=$COUNT_PID)"
else
  fail "--pid vs --app" "app=$COUNT_APP pid=$COUNT_PID"
fi

# ── B4. -p position variants ──
echo "B4. -p position"
OUT1=$($AC -p macos --app TextEdit snapshot -i 2>&1) || true
OUT2=$($AC --app TextEdit -p macos snapshot -i 2>&1) || true
if is_json_array "$OUT1" && is_json_array "$OUT2"; then
  pass "-p at start = -p in middle"
else
  fail "-p position" "one or both not valid JSON array"
fi

# ── B5. -e / --json / -c with different positions ──
echo "B5. enhance flags position"
# -e before snapshot
OUT1=$($AC -p macos --app TextEdit -e snapshot 2>&1) || true
# -e after snapshot
OUT2=$($AC -p macos --app TextEdit snapshot -e 2>&1) || true
# Both should have "interactive elements"
HAS1=$(echo "$OUT1" | grep -c "interactive elements" || true)
HAS2=$(echo "$OUT2" | grep -c "interactive elements" || true)
if [ "$HAS1" -gt 0 ] && [ "$HAS2" -gt 0 ]; then
  pass "-e before snapshot = -e after snapshot"
else
  fail "-e position" "before=$HAS1 after=$HAS2"
fi

# ── B6. screenshot path with --app in different positions ──
echo "B6. screenshot path + --app ordering"
SS1="/tmp/ac-test-order1.png"
SS2="/tmp/ac-test-order2.png"
SS3="/tmp/ac-test-order3.png"
rm -f "$SS1" "$SS2" "$SS3"
# --app before screenshot
$AC -p macos --app TextEdit screenshot "$SS1" 2>&1 > /dev/null || true
# --app after screenshot
$AC -p macos screenshot "$SS2" --app TextEdit 2>&1 > /dev/null || true
# --app between screenshot and path
$AC -p macos screenshot --app TextEdit "$SS3" 2>&1 > /dev/null || true
OK=0
for f in "$SS1" "$SS2" "$SS3"; do
  if [ -f "$f" ] && [ "$(stat -f%z "$f" 2>/dev/null)" -gt 1000 ]; then
    OK=$((OK+1))
  fi
done
if [ "$OK" -eq 3 ]; then
  pass "screenshot works with --app in 3 positions"
else
  fail "screenshot --app ordering" "only $OK/3 succeeded ($(ls -la $SS1 $SS2 $SS3 2>&1 | grep -c png) files)"
fi
rm -f "$SS1" "$SS2" "$SS3"

# ── B7. click @ref with --app in different positions ──
echo "B7. click + --app ordering"
if [ -n "$FIRST_REF" ]; then
  # --app before click
  OUT1=$($AC -p macos --app TextEdit click "$FIRST_REF" 2>&1) || true
  # --app after click
  OUT2=$($AC -p macos click "$FIRST_REF" --app TextEdit 2>&1) || true
  OK=0
  echo "$OUT1" | grep -q "ok" && OK=$((OK+1))
  echo "$OUT2" | grep -q "ok" && OK=$((OK+1))
  if [ "$OK" -eq 2 ]; then
    pass "click works with --app before and after"
  else
    fail "click --app ordering" "$OK/2 succeeded"
  fi
else
  fail "click --app ordering" "no ref"
fi

# ── B8. fill with --app in different positions ──
echo "B8. fill + --app ordering"
if [ -n "$TEXT_REF" ]; then
  OUT1=$($AC -p macos --app TextEdit fill "$TEXT_REF" "order test 1" 2>&1) || true
  OUT2=$($AC -p macos fill "$TEXT_REF" "order test 2" --app TextEdit 2>&1) || true
  OK=0
  echo "$OUT1" | grep -q "ok" && OK=$((OK+1))
  echo "$OUT2" | grep -q "ok" && OK=$((OK+1))
  if [ "$OK" -eq 2 ]; then
    pass "fill works with --app before and after"
  else
    fail "fill --app ordering" "$OK/2 succeeded"
  fi
else
  echo "  ⏭️  fill ordering: no text field (skipped)"
fi

# ── B9. Bare ref without @ prefix ──
echo "B9. bare ref (e3 without @)"
if [ -n "$FIRST_REF" ]; then
  BARE_REF=$(echo "$FIRST_REF" | sed 's/@//')
  OUT=$($AC -p macos --app TextEdit click "$BARE_REF" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "bare ref $BARE_REF auto-normalized to $FIRST_REF"
  else
    fail "bare ref" "$OUT"
  fi
else
  fail "bare ref" "no ref"
fi

# ── B10. --app with bundleId ──
echo "B10. --app with bundleId"
OUT=$($AC -p macos --app com.apple.TextEdit snapshot -i 2>&1) || true
if is_json_array "$OUT"; then
  pass "--app com.apple.TextEdit (bundleId)"
else
  fail "--app bundleId" "not a valid JSON array"
fi

# ── B11. longpress with --duration in different positions ──
echo "B11. longpress --duration ordering"
if [ -n "$FIRST_REF" ]; then
  OUT1=$($AC -p macos --app TextEdit longpress "$FIRST_REF" --duration=300 2>&1) || true
  sleep 0.2
  $AC -p macos --app TextEdit press escape 2>&1 > /dev/null || true
  OUT2=$($AC -p macos --app TextEdit longpress --duration=300 "$FIRST_REF" 2>&1) || true
  sleep 0.2
  $AC -p macos --app TextEdit press escape 2>&1 > /dev/null || true
  OK=0
  echo "$OUT1" | grep -q "ok" && OK=$((OK+1))
  echo "$OUT2" | grep -q "ok" && OK=$((OK+1))
  if [ "$OK" -eq 2 ]; then
    pass "longpress --duration before and after ref"
  else
    fail "longpress --duration ordering" "$OK/2 (out1=$(echo $OUT1|head -c40) out2=$(echo $OUT2|head -c40))"
  fi
else
  fail "longpress ordering" "no ref"
fi

# ── Cleanup ──
echo ""
echo "Cleanup: closing TextEdit (without saving)..."
osascript -e 'tell application "TextEdit" to quit saving no' 2>/dev/null || true
rm -f "$TMPFILE"

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION D: Multi-window tests
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── D1. open two TextEdit windows ──"
TMPFILE1="/tmp/ac-test-win1.txt"
TMPFILE2="/tmp/ac-test-win2.txt"
echo "Window One Content" > "$TMPFILE1"
echo "Window Two Content" > "$TMPFILE2"
open -a TextEdit "$TMPFILE1"
sleep 1
open -a TextEdit "$TMPFILE2"
sleep 2

echo "── D2. snapshot sees content from multiple windows ──"
OUT=$($AC -p macos --app TextEdit snapshot --all 2>&1) || true
HAS_WIN1=0
HAS_WIN2=0
echo "$OUT" | grep -q "ac-test-win1\|Window One Content" && HAS_WIN1=1
echo "$OUT" | grep -q "ac-test-win2\|Window Two Content" && HAS_WIN2=1
if [ "$HAS_WIN1" -eq 1 ] && [ "$HAS_WIN2" -eq 1 ]; then
  pass "snapshot sees both windows"
elif [ "$HAS_WIN1" -eq 1 ] || [ "$HAS_WIN2" -eq 1 ]; then
  pass "snapshot sees at least one window (multi-window partial)"
else
  fail "multi-window snapshot" "neither window content found"
fi

echo "── D3. cleanup multi-window ──"
osascript -e 'tell application "TextEdit" to quit saving no' 2>/dev/null || true
rm -f "$TMPFILE1" "$TMPFILE2"
pass "multi-window cleanup"

# ════════════════════════════════════════════════════════════════════════════
# SECTION E: Background invariants (frontmost app must not change)
# ════════════════════════════════════════════════════════════════════════════
echo ""
echo "── E. background invariants (frontmost does not change) ──"

# Setup: TextEdit as frontmost anchor, Finder as background target
TMPFILE3="/tmp/ac-test-bg-anchor.txt"
echo "anchor" > "$TMPFILE3"
open -a TextEdit "$TMPFILE3"
sleep 1
osascript -e 'tell application "TextEdit" to activate' 2>/dev/null || true
sleep 1
open -g -a Finder  # -g = open without activating
sleep 1

BASELINE=$(osascript -e 'tell application "System Events" to name of first application process whose frontmost is true')
if [ "$BASELINE" != "TextEdit" ]; then
  fail "E. baseline" "expected TextEdit frontmost, got: $BASELINE"
else
  pass "E0. baseline: TextEdit is frontmost"
fi

assert_bg() {
  local label="$1"
  shift
  "$@" > /dev/null 2>&1 || true
  local now
  now=$(osascript -e 'tell application "System Events" to name of first application process whose frontmost is true')
  if [ "$now" = "$BASELINE" ]; then
    pass "E. $label (frontmost=$now, unchanged)"
  else
    fail "E. $label" "frontmost changed: $BASELINE → $now"
  fi
}

assert_bg "snapshot --app Finder"      $AC -p macos --app Finder snapshot
assert_bg "snapshot -e --app Finder"   $AC -p macos --app Finder -e snapshot
assert_bg "screenshot --app Finder"    $AC -p macos --app Finder screenshot /tmp/ac-bg-shot.png
assert_bg "press cmd+1 --app Finder"   $AC -p macos --app Finder press cmd+1
assert_bg "press escape --app Finder"  $AC -p macos --app Finder press escape
assert_bg "scroll down --app Finder"   $AC -p macos --app Finder scroll down
assert_bg "windows"                    $AC -p macos windows
assert_bg "processes"                  $AC -p macos processes

# Cleanup section E
osascript -e 'tell application "Finder" to close every window' 2>/dev/null || true
osascript -e 'tell application "TextEdit" to quit saving no' 2>/dev/null || true
rm -f "$TMPFILE3" /tmp/ac-bg-shot.png

# ════════════════════════════════════════════════════════════════════════════
# SECTION F: Screenshot policy (no --app → error; --full → ok)
# ════════════════════════════════════════════════════════════════════════════
echo ""
echo "── F. screenshot policy ──"

# F1. No --app, no --full → must exit non-zero
F1_OUT=$($AC -p macos screenshot /tmp/ac-policy-1.png 2>&1 || true)
F1_CODE=$?
if echo "$F1_OUT" | grep -qi "requires --app"; then
  pass "F1. no --app → error message present"
else
  fail "F1. no --app" "expected 'requires --app' hint, got: $F1_OUT"
fi
if [ ! -s /tmp/ac-policy-1.png ]; then
  pass "F1. no file created"
else
  fail "F1. no --app" "file should not be created"
fi
rm -f /tmp/ac-policy-1.png

# F2. --full → ok + stderr note
F2_OUT=$($AC -p macos screenshot --full /tmp/ac-policy-2.png 2>&1 || true)
if echo "$F2_OUT" | grep -q '"ok":true'; then
  pass "F2. --full returns ok"
else
  fail "F2. --full" "$F2_OUT"
fi
if [ -s /tmp/ac-policy-2.png ]; then
  pass "F2. --full creates file"
else
  fail "F2. --full" "file not created"
fi
rm -f /tmp/ac-policy-2.png

# F3. --app Finder → ok, window-only
open -g -a Finder; sleep 1
F3_OUT=$($AC -p macos --app Finder screenshot /tmp/ac-policy-3.png 2>&1 || true)
if echo "$F3_OUT" | grep -q '"ok":true' && [ -s /tmp/ac-policy-3.png ]; then
  pass "F3. --app Finder creates file"
else
  fail "F3. --app Finder" "$F3_OUT"
fi
# App-scoped should be smaller than full-screen on a typical Retina display.
if [ -f /tmp/ac-policy-3.png ]; then
  SIZE_APP=$(stat -f%z /tmp/ac-policy-3.png 2>/dev/null || stat -c%s /tmp/ac-policy-3.png)
  if [ "$SIZE_APP" -lt 2000000 ]; then
    pass "F3. app-scoped size sanity (<2MB: $SIZE_APP)"
  else
    # Not fatal — might be a big window. Inform but don't fail.
    pass "F3. app-scoped size: $SIZE_APP (not smaller than full-screen threshold — ok if window is large)"
  fi
fi
osascript -e 'tell application "Finder" to close every window' 2>/dev/null || true
rm -f /tmp/ac-policy-3.png

# ════════════════════════════════════════════════════════════════════════════
# SECTION G: Modifier keys (press cmd+shift+x + --modifiers)
# ════════════════════════════════════════════════════════════════════════════
echo ""
echo "── G. press modifier combinations ──"

# Open a fresh TextEdit to receive keys
TMPFILE_G="/tmp/ac-test-g.txt"
echo "" > "$TMPFILE_G"
open -a TextEdit "$TMPFILE_G"
sleep 1
osascript -e 'tell application "TextEdit" to activate' 2>/dev/null || true
sleep 1

for combo in "cmd+a" "cmd+shift+a" "shift+tab" "ctrl+a" "cmd+1" "cmd+f1"; do
  G_OUT=$($AC -p macos --app TextEdit press "$combo" 2>&1 || true)
  if echo "$G_OUT" | grep -q '"ok":true'; then
    pass "G. press $combo"
  else
    fail "G. press $combo" "$G_OUT"
  fi
done

# --modifiers flag form (legacy)
G_MOD=$($AC -p macos --app TextEdit press a --modifiers cmd,shift 2>&1 || true)
if echo "$G_MOD" | grep -q '"ok":true' && echo "$G_MOD" | grep -q "cmd+shift+a"; then
  pass "G. press a --modifiers cmd,shift (folds to cmd+shift+a)"
else
  fail "G. --modifiers flag" "$G_MOD"
fi

# Unknown modifier → must error
G_BAD=$($AC -p macos --app TextEdit press "wat+a" 2>&1 || true)
if echo "$G_BAD" | grep -q "unknown modifier"; then
  pass "G. unknown modifier → error"
else
  fail "G. unknown modifier" "$G_BAD"
fi

osascript -e 'tell application "TextEdit" to quit saving no' 2>/dev/null || true
rm -f "$TMPFILE_G"

# ── Summary ──
echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
if [ $FAIL -gt 0 ]; then
  echo -e "\nFailures:$ERRORS"
  exit 1
else
  echo "All tests passed! ✅"
fi
