#!/bin/bash
# agent-control iOS platform test suite
# Tests all commands + parameter ordering variants against booted Simulator
set -euo pipefail

AC="node $(dirname "$0")/../cli.js"
PASS=0
FAIL=0
ERRORS=""

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); ERRORS="$ERRORS\n  ❌ $1: $2"; echo "  ❌ $1: $2"; }

echo "=== agent-control iOS test suite ==="
echo ""

# ── Check Simulator is booted ──
BOOTED=$(xcrun simctl list devices booted 2>/dev/null | grep -c "Booted" || true)
if [ "$BOOTED" -eq 0 ]; then
  echo "❌ No booted Simulator found. Boot one first:"
  echo "   xcrun simctl boot 'iPhone 17'"
  exit 1
fi
echo "Simulator booted ✅"

# ── Setup: open Settings app ──
echo "Setup: opening Settings..."
xcrun simctl launch booted com.apple.Preferences 2>/dev/null || true
sleep 2

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION A: Core functionality
# ═══════════════════════════════════════════════════════════════════════════════

# ── 1. Snapshot -e ──
echo "1. snapshot -e"
OUT=$($AC -p ios -e snapshot 2>&1) || true
if echo "$OUT" | grep -q "interactive elements"; then
  pass "snapshot -e returns interactive elements"
else
  fail "snapshot -e" "no interactive elements: $(echo "$OUT" | head -3)"
fi

if echo "$OUT" | grep -qE '\[ref=@e[0-9]+\]'; then
  pass "refs use @eN format"
else
  fail "refs format" "expected @eN format"
fi

# ── 2. Snapshot --json ──
echo "2. snapshot --json"
JSON_OUT=$($AC -p ios --json snapshot 2>&1)
ELEM_COUNT=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.elements?j.elements.length:0)}catch{console.log(-1)}})" 2>/dev/null)
if [ "${ELEM_COUNT:-0}" -gt 0 ]; then
  pass "snapshot --json returns valid JSON with $ELEM_COUNT elements"
else
  fail "snapshot --json" "invalid JSON or no elements"
fi

# ── 3. Snapshot --all ──
echo "3. snapshot --all"
ALL_OUT=$($AC -p ios --all snapshot -e 2>&1) || true
ALL_COUNT=$(echo "$ALL_OUT" | head -1 | grep -oE '[0-9]+' | head -1)
DEFAULT_COUNT=$(echo "$OUT" | head -1 | grep -oE '[0-9]+' | head -1)
if [ "${ALL_COUNT:-0}" -ge "${DEFAULT_COUNT:-0}" ]; then
  pass "--all returns >= default elements ($ALL_COUNT >= $DEFAULT_COUNT)"
else
  fail "--all" "expected more elements ($ALL_COUNT < $DEFAULT_COUNT)"
fi

# ── 4. Snapshot --compact ──
echo "4. snapshot --compact"
COMPACT_OUT=$($AC -p ios -c snapshot 2>&1) || true
if [ -n "$COMPACT_OUT" ]; then
  pass "snapshot --compact returns output"
else
  fail "snapshot --compact" "empty output"
fi

# ── 5. Snapshot -i (raw) ──
echo "5. snapshot -i (raw)"
RAW_OUT=$($AC -p ios snapshot -i 2>&1) || true
if echo "$RAW_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);process.exit(Array.isArray(a)&&a.length>0?0:1)}catch{process.exit(1)}})" 2>/dev/null; then
  pass "snapshot -i returns raw JSON array"
else
  fail "snapshot -i" "expected raw JSON array"
fi

# ── 6. Find ──
echo "6. find"
FIND_OUT=$($AC -p ios find "Settings" 2>&1) || true
if echo "$FIND_OUT" | grep -qi "settings\|General\|ok"; then
  pass "find 'Settings'"
else
  fail "find" "$(echo "$FIND_OUT" | head -3)"
fi

# ── Helper: get refs ──
FIRST_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>x.interactive!==false&&x.ref);if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
CELL_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>(x.label||'').includes('General'));if(e)console.log(e.ref);else{const any=j.elements.find(x=>x.interactive!==false&&x.ref);if(any)console.log(any.ref)}}catch{}})" 2>/dev/null) || true
SECOND_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const els=j.elements.filter(x=>x.interactive!==false&&x.ref);if(els.length>=2)console.log(els[1].ref)}catch{}})" 2>/dev/null) || true

echo "  (refs: first=$FIRST_REF cell=$CELL_REF second=$SECOND_REF)"

# ── 7. Click (tap) ──
echo "7. click @ref"
if [ -n "$CELL_REF" ]; then
  OUT=$($AC -p ios click "$CELL_REF" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "click $CELL_REF"
  else
    fail "click" "$OUT"
  fi
  sleep 1
else
  fail "click" "could not find tappable element"
fi

# ── 8. Click x y ──
echo "8. click x y"
OUT=$($AC -p ios click 200 400 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "click 200 400 (coordinate)"
else
  fail "click x y" "$OUT"
fi

# ── 9. Scroll ──
echo "9. scroll"
for dir in down up; do
  OUT=$($AC -p ios scroll $dir 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "scroll $dir"
  else
    fail "scroll $dir" "$OUT"
  fi
done

# ── 10. Scroll with amount ──
echo "10. scroll with amount"
OUT=$($AC -p ios scroll down 200 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "scroll down 200"
else
  fail "scroll down 200" "$OUT"
fi

# ── 11. Swipe (all directions) ──
echo "11. swipe"
for dir in up down left right; do
  OUT=$($AC -p ios swipe $dir 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "swipe $dir"
  else
    fail "swipe $dir" "$OUT"
  fi
done

# ── 12. Screenshot ──
echo "12. screenshot"
SS_PATH="/tmp/ac-test-ios-screenshot.png"
rm -f "$SS_PATH"
OUT=$($AC -p ios screenshot "$SS_PATH" 2>&1) || true
if [ -f "$SS_PATH" ]; then
  SIZE=$(stat -f%z "$SS_PATH" 2>/dev/null || stat -c%s "$SS_PATH" 2>/dev/null)
  if [ "${SIZE:-0}" -gt 1000 ]; then
    pass "screenshot saved (${SIZE} bytes)"
  else
    fail "screenshot" "file too small (${SIZE} bytes)"
  fi
else
  fail "screenshot" "file not created"
fi

# ── 13. Screenshot default path ──
echo "13. screenshot (default path)"
rm -f /tmp/agent-control-ios.png
OUT=$($AC -p ios screenshot 2>&1) || true
if [ -f /tmp/agent-control-ios.png ]; then
  pass "screenshot default path works"
  rm -f /tmp/agent-control-ios.png
else
  fail "screenshot default" "no file at default path"
fi

# ── 14. Press ──
echo "14. press home"
OUT=$($AC -p ios press home 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "press home"
else
  fail "press home" "$OUT"
fi
sleep 1

# ── 15. Longpress ──
echo "15. longpress @ref"
# Re-open Settings
xcrun simctl launch booted com.apple.Preferences 2>/dev/null || true
sleep 1
ICON_REF=$($AC -p ios --json snapshot 2>&1 | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>x.interactive!==false&&x.ref);if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true

if [ -n "$ICON_REF" ]; then
  OUT=$($AC -p ios longpress "$ICON_REF" --duration=500 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "longpress $ICON_REF 500ms"
  else
    fail "longpress" "$OUT"
  fi
else
  fail "longpress" "no ref available"
fi

# ── 16. Longpress x y ──
echo "16. longpress x y"
OUT=$($AC -p ios longpress 200 400 --duration=300 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "longpress 200 400 (coordinate)"
else
  fail "longpress x y" "$OUT"
fi

# ── 17. Fill (search field) ──
echo "17. fill"
SEARCH_REF=$($AC -p ios --json snapshot 2>&1 | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>x.role==='SearchField'||x.role==='TextField'||(x.label||'').includes('Search'));if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true

if [ -n "$SEARCH_REF" ]; then
  OUT=$($AC -p ios fill "$SEARCH_REF" "General" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "fill $SEARCH_REF"
  else
    fail "fill" "$OUT"
  fi
else
  echo "  ⏭️  fill: no search field found (skipped)"
fi

# ── 18. Drag @ref @ref ──
echo "18. drag @ref @ref"
DRAG_REF1=$($AC -p ios --json snapshot 2>&1 | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const els=j.elements.filter(x=>x.interactive!==false&&x.ref);if(els.length>=1)console.log(els[0].ref)}catch{}})" 2>/dev/null) || true
DRAG_REF2=$($AC -p ios --json snapshot 2>&1 | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const els=j.elements.filter(x=>x.interactive!==false&&x.ref);if(els.length>=2)console.log(els[1].ref)}catch{}})" 2>/dev/null) || true

if [ -n "$DRAG_REF1" ] && [ -n "$DRAG_REF2" ]; then
  OUT=$($AC -p ios drag "$DRAG_REF1" "$DRAG_REF2" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "drag $DRAG_REF1 → $DRAG_REF2"
  else
    fail "drag" "$OUT"
  fi
else
  echo "  ⏭️  drag: need 2 refs (skipped)"
fi

# ── 19. Drag x1 y1 x2 y2 ──
echo "19. drag x1 y1 x2 y2"
OUT=$($AC -p ios drag 200 300 200 500 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "drag 200,300 → 200,500 (coordinate)"
else
  fail "drag x y" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION B: Parameter ordering variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── Parameter ordering variants ──"

# ── B1. -e before vs after snapshot ──
echo "B1. -e position"
OUT1=$($AC -p ios -e snapshot 2>&1) || true
OUT2=$($AC -p ios snapshot -e 2>&1) || true
HAS1=$(echo "$OUT1" | grep -c "interactive elements" || true)
HAS2=$(echo "$OUT2" | grep -c "interactive elements" || true)
if [ "$HAS1" -gt 0 ] && [ "$HAS2" -gt 0 ]; then
  pass "-e before snapshot = -e after snapshot"
else
  fail "-e position" "before=$HAS1 after=$HAS2"
fi

# ── B2. --json before vs after snapshot ──
echo "B2. --json position"
OUT1=$($AC -p ios --json snapshot 2>&1) || true
OUT2=$($AC -p ios snapshot --json 2>&1) || true
C1=$(echo "$OUT1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).elements?'ok':'no')}catch{console.log('no')}})" 2>/dev/null)
C2=$(echo "$OUT2" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).elements?'ok':'no')}catch{console.log('no')}})" 2>/dev/null)
if [ "$C1" = "ok" ] && [ "$C2" = "ok" ]; then
  pass "--json before snapshot = --json after snapshot"
else
  fail "--json position" "before=$C1 after=$C2"
fi

# ── B3. -p position ──
echo "B3. -p position"
OUT1=$($AC -p ios snapshot -i 2>&1) || true
OUT2=$($AC snapshot -i -p ios 2>&1) || true
if echo "$OUT1" | head -c 20 | grep -q '\[' && echo "$OUT2" | head -c 20 | grep -q '\['; then
  pass "-p at start = -p at end"
else
  fail "-p position" "start=$(echo "$OUT1" | head -c 50) end=$(echo "$OUT2" | head -c 50)"
fi

# ── B4. Bare ref without @ ──
echo "B4. bare ref (e3 without @)"
CUR_REF=$($AC -p ios --json snapshot 2>&1 | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>x.interactive!==false&&x.ref);if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
if [ -n "$CUR_REF" ]; then
  BARE=$(echo "$CUR_REF" | sed 's/@//')
  OUT=$($AC -p ios click "$BARE" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "bare ref $BARE auto-normalized to $CUR_REF"
  else
    fail "bare ref" "$OUT"
  fi
else
  fail "bare ref" "no ref"
fi

# ── B5. screenshot path ordering ──
echo "B5. screenshot path ordering"
SS1="/tmp/ac-test-ios-order1.png"
SS2="/tmp/ac-test-ios-order2.png"
rm -f "$SS1" "$SS2"
$AC -p ios screenshot "$SS1" 2>&1 > /dev/null || true
$AC screenshot "$SS2" -p ios 2>&1 > /dev/null || true
OK=0
for f in "$SS1" "$SS2"; do
  [ -f "$f" ] && [ "$(stat -f%z "$f" 2>/dev/null)" -gt 1000 ] && OK=$((OK+1))
done
if [ "$OK" -eq 2 ]; then
  pass "screenshot path works with -p in different positions"
else
  fail "screenshot path ordering" "$OK/2 succeeded"
fi
rm -f "$SS1" "$SS2"

# ── B6. longpress --duration ordering ──
echo "B6. longpress --duration ordering"
CUR_REF=$($AC -p ios --json snapshot 2>&1 | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>x.interactive!==false&&x.ref);if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
if [ -n "$CUR_REF" ]; then
  OUT1=$($AC -p ios longpress "$CUR_REF" --duration=300 2>&1) || true
  OUT2=$($AC -p ios longpress --duration=300 "$CUR_REF" 2>&1) || true
  OK=0
  echo "$OUT1" | grep -q "ok" && OK=$((OK+1))
  echo "$OUT2" | grep -q "ok" && OK=$((OK+1))
  if [ "$OK" -eq 2 ]; then
    pass "longpress --duration before and after ref"
  else
    fail "longpress --duration ordering" "$OK/2"
  fi
else
  fail "longpress ordering" "no ref"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# Platform-specific: iOS
# ═══════════════════════════════════════════════════════════════════════════════

# ── C1. Launch ──
echo "C1. launch"
OUT=$($AC -p ios launch com.apple.Preferences 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "launch com.apple.Preferences"
else
  fail "launch" "$OUT"
fi

# ── C2. Terminate ──
echo "C2. terminate"
# Launch Shortcuts first (always available), then terminate
$AC -p ios launch com.apple.shortcuts 2>&1 >/dev/null || true
sleep 2
OUT=$($AC -p ios terminate com.apple.shortcuts 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "terminate com.apple.shortcuts"
else
  fail "terminate" "$OUT"
fi

# ── C3. Windows ──
echo "C3. windows"
OUT=$($AC -p ios windows 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "windows command"
else
  fail "windows" "$OUT"
fi

# ── C4. List-apps ──
echo "C4. list-apps"
OUT=$($AC -p ios list-apps 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "list-apps command"
  APP_COUNT=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.count||0)}catch{console.log(0)}})" 2>/dev/null)
  if [ "${APP_COUNT:-0}" -gt 0 ]; then
    pass "list-apps has $APP_COUNT apps"
  else
    fail "list-apps count" "0 apps"
  fi
else
  fail "list-apps" "$OUT"
fi

# ── C5. Launch no args → error ──
echo "C5. launch/terminate error handling"
OUT=$($AC -p ios launch 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "launch (no args) → error"
else
  fail "launch no args" "$OUT"
fi

OUT=$($AC -p ios terminate 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "terminate (no args) → error"
else
  fail "terminate no args" "$OUT"
fi

# ── C6. Screenshot --window ──
echo "C6. screenshot --window"
# Just test that the flag is accepted (may fail if display ID invalid, that's ok)
OUT=$($AC -p ios screenshot --window 1 /tmp/agent-control-ios-window.png 2>&1) || true
# Accept both success and "invalid display" type errors — just not "unknown flag"
if echo "$OUT" | grep -qv "unknown.*flag\|unrecognized"; then
  pass "screenshot --window flag accepted"
else
  fail "screenshot --window" "$OUT"
fi
rm -f /tmp/agent-control-ios-window.png

# Restore Settings for any subsequent tests
$AC -p ios launch com.apple.Preferences 2>&1 >/dev/null || true
sleep 1

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
