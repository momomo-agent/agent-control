#!/bin/bash
# agent-control Electron platform test suite
# Auto-starts a minimal Electron fixture app for testing
set -euo pipefail

AC="node $(dirname "$0")/../cli.js"
FIXTURE_DIR="$(cd "$(dirname "$0")/electron-fixture" && pwd)"
ELECTRON_BIN="/Users/kenefe/LOCAL/momo-agent/projects/paw/node_modules/.bin/electron"
CDP_PORT=19229
ELECTRON_PID=""
PASS=0
FAIL=0
ERRORS=""

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); ERRORS="$ERRORS\n  ❌ $1: $2"; echo "  ❌ $1: $2"; }

cleanup() {
  if [ -n "$ELECTRON_PID" ] && kill -0 "$ELECTRON_PID" 2>/dev/null; then
    kill "$ELECTRON_PID" 2>/dev/null || true
    wait "$ELECTRON_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== agent-control Electron test suite ==="
echo ""

# ── Start fixture Electron app ──
echo "Starting Electron fixture app (CDP port $CDP_PORT)..."
if [ ! -f "$ELECTRON_BIN" ]; then
  echo "❌ Electron binary not found at $ELECTRON_BIN"
  exit 1
fi

ELECTRON_DEBUG_PORT=$CDP_PORT "$ELECTRON_BIN" "$FIXTURE_DIR" --remote-debugging-port=$CDP_PORT &
ELECTRON_PID=$!
sleep 3

# Verify CDP is up
if ! curl -s "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; then
  echo "❌ CDP not responding on port $CDP_PORT"
  exit 1
fi
echo "Electron fixture running (PID $ELECTRON_PID, CDP $CDP_PORT) ✅"
echo ""

export ELECTRON_DEBUG_PORT=$CDP_PORT

# ── 1. Snapshot (enhanced) ──
echo "1. snapshot -e"
OUT=$($AC -p electron -e snapshot 2>&1) || true
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
JSON_OUT=$($AC -p electron --json snapshot 2>&1)
ELEM_COUNT=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.elements?j.elements.length:0)}catch{console.log(-1)}})" 2>/dev/null)
if [ "${ELEM_COUNT:-0}" -gt 0 ]; then
  pass "snapshot --json returns valid JSON with $ELEM_COUNT elements"
else
  fail "snapshot --json" "invalid JSON or no elements (count=$ELEM_COUNT)"
fi

# ── 3. Snapshot --all ──
echo "3. snapshot --all"
ALL_OUT=$($AC -p electron --all snapshot -e 2>&1) || true
ALL_COUNT=$(echo "$ALL_OUT" | head -1 | grep -oE '[0-9]+' | head -1)
DEFAULT_COUNT=$(echo "$OUT" | head -1 | grep -oE '[0-9]+' | head -1)
if [ "${ALL_COUNT:-0}" -ge "${DEFAULT_COUNT:-0}" ]; then
  pass "--all returns >= default elements ($ALL_COUNT >= $DEFAULT_COUNT)"
else
  fail "--all" "expected more elements ($ALL_COUNT < $DEFAULT_COUNT)"
fi

# ── 4. Snapshot --compact ──
echo "4. snapshot --compact"
COMPACT_OUT=$($AC -p electron -c snapshot 2>&1) || true
if [ -n "$COMPACT_OUT" ]; then
  pass "snapshot --compact returns output"
else
  fail "snapshot --compact" "empty output"
fi

# ── 4b. Snapshot --ui ──
echo "4b. snapshot --ui"
UI_OUT=$($AC -p electron snapshot --ui 2>&1) || true
UI_COUNT=$(echo "$UI_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);console.log(Array.isArray(a)?a.length:0)}catch{console.log(-1)}})" 2>/dev/null)
if [ "${UI_COUNT:-0}" -gt 0 ]; then
  pass "snapshot --ui returns $UI_COUNT elements"
else
  fail "snapshot --ui" "no elements (count=$UI_COUNT)"
fi

# Check --ui returns CSS properties (color, bg, fontSize)
HAS_CSS=$(echo "$UI_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);const e=a[0];console.log(e&&e.color&&e.fontSize?'true':'false')}catch{console.log('false')}})" 2>/dev/null)
if [ "$HAS_CSS" = "true" ]; then
  pass "snapshot --ui includes CSS properties (color, fontSize)"
else
  fail "snapshot --ui CSS" "missing color/fontSize"
fi

# ── 5. Find ──
echo "5. find"
FIND_OUT=$($AC -p electron find "Submit" 2>&1) || true
if echo "$FIND_OUT" | grep -qi "submit\|ok"; then
  pass "find 'Submit'"
else
  fail "find" "$(echo "$FIND_OUT" | head -3)"
fi

# ── Helper: get refs ──
FIRST_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>x.interactive!==false&&x.ref);if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
INPUT_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>(x.tag==='input'||x.tag==='textarea'||x.role==='textbox')&&x.ref);if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
SECOND_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const els=j.elements.filter(x=>x.interactive!==false&&x.ref);if(els.length>=2)console.log(els[1].ref)}catch{}})" 2>/dev/null) || true

echo "  (refs: first=$FIRST_REF input=$INPUT_REF second=$SECOND_REF)"

# ── 6. Click ──
echo "6. click"
if [ -n "$FIRST_REF" ]; then
  OUT=$($AC -p electron click "$FIRST_REF" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "click $FIRST_REF"
  else
    fail "click" "$OUT"
  fi
else
  fail "click" "no interactive element found"
fi

# ── 7. Fill ──
echo "7. fill"
if [ -n "$INPUT_REF" ]; then
  OUT=$($AC -p electron fill "$INPUT_REF" "test from agent-control" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "fill $INPUT_REF"
  else
    fail "fill" "$OUT"
  fi
else
  fail "fill" "no input field found"
fi

# ── 8. Press ──
echo "8. press"
OUT=$($AC -p electron press Escape 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "press Escape"
else
  fail "press" "$OUT"
fi

# ── 9. Scroll ──
echo "9. scroll"
for dir in down up; do
  OUT=$($AC -p electron scroll $dir 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "scroll $dir"
  else
    fail "scroll $dir" "$OUT"
  fi
done

# ── 10. Screenshot ──
echo "10. screenshot"
SS_PATH="/tmp/ac-test-electron-screenshot.png"
rm -f "$SS_PATH"
OUT=$($AC -p electron screenshot "$SS_PATH" 2>&1) || true
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

# ── 11. Double click ──
echo "11. dblclick"
if [ -n "$FIRST_REF" ]; then
  OUT=$($AC -p electron dblclick "$FIRST_REF" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "dblclick $FIRST_REF"
  else
    fail "dblclick" "$OUT"
  fi
else
  fail "dblclick" "no ref available"
fi

# ── 12. Right click ──
echo "12. rightclick"
if [ -n "$FIRST_REF" ]; then
  OUT=$($AC -p electron rightclick "$FIRST_REF" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "rightclick $FIRST_REF"
  else
    fail "rightclick" "$OUT"
  fi
else
  fail "rightclick" "no ref available"
fi

# ── 13. Longpress ──
echo "13. longpress"
if [ -n "$FIRST_REF" ]; then
  OUT=$($AC -p electron longpress "$FIRST_REF" --duration=500 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "longpress $FIRST_REF 500ms"
  else
    fail "longpress" "$OUT"
  fi
else
  fail "longpress" "no ref available"
fi

# ── 14. Drag ──
echo "14. drag"
if [ -n "$FIRST_REF" ] && [ -n "$SECOND_REF" ]; then
  OUT=$($AC -p electron drag "$FIRST_REF" "$SECOND_REF" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "drag $FIRST_REF → $SECOND_REF"
  else
    fail "drag" "$OUT"
  fi
else
  fail "drag" "need at least 2 refs (first=$FIRST_REF second=$SECOND_REF)"
fi

# ── 15. Eval ──
echo "15. eval"
OUT=$($AC -p electron eval "document.title" 2>&1) || true
if echo "$OUT" | grep -qi "test\|ac"; then
  pass "eval document.title: $(echo "$OUT" | head -1)"
else
  fail "eval" "unexpected: $OUT"
fi

# ── 16. Windows ──
echo "16. windows"
OUT=$($AC -p electron windows 2>&1) || true
if echo "$OUT" | grep -qi "window\|title\|id\|url\|ok"; then
  pass "windows list"
else
  fail "windows" "$OUT"
fi

# ── 17. Click x y ──
echo "17. click x y"
OUT=$($AC -p electron click 100 200 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "click 100 200 (coordinate)"
else
  fail "click x y" "$OUT"
fi

# ── 18. Drag x1 y1 x2 y2 ──
echo "18. drag x1 y1 x2 y2"
OUT=$($AC -p electron drag 50 50 200 200 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "drag 50,50 → 200,200 (coordinate)"
else
  fail "drag x y" "$OUT"
fi

# ── 19. Screenshot default path ──
echo "19. screenshot (default path)"
rm -f /tmp/screenshot.png
OUT=$($AC -p electron screenshot 2>&1) || true
if [ -f /tmp/screenshot.png ]; then
  pass "screenshot default path works"
  rm -f /tmp/screenshot.png
else
  fail "screenshot default" "no file at default path"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION B: Parameter ordering variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── Parameter ordering variants ──"

# ── B1. -e before vs after snapshot ──
echo "B1. -e position"
OUT1=$($AC -p electron -e snapshot 2>&1) || true
OUT2=$($AC -p electron snapshot -e 2>&1) || true
HAS1=$(echo "$OUT1" | grep -c "interactive elements" || true)
HAS2=$(echo "$OUT2" | grep -c "interactive elements" || true)
if [ "$HAS1" -gt 0 ] && [ "$HAS2" -gt 0 ]; then
  pass "-e before snapshot = -e after snapshot"
else
  fail "-e position" "before=$HAS1 after=$HAS2"
fi

# ── B2. --json before vs after snapshot ──
echo "B2. --json position"
OUT1=$($AC -p electron --json snapshot 2>&1) || true
OUT2=$($AC -p electron snapshot --json 2>&1) || true
C1=$(echo "$OUT1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).elements?'ok':'no')}catch{console.log('no')}})" 2>/dev/null)
C2=$(echo "$OUT2" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).elements?'ok':'no')}catch{console.log('no')}})" 2>/dev/null)
if [ "$C1" = "ok" ] && [ "$C2" = "ok" ]; then
  pass "--json before snapshot = --json after snapshot"
else
  fail "--json position" "before=$C1 after=$C2"
fi

# ── B3. -p position ──
echo "B3. -p position"
OUT1=$($AC -p electron snapshot 2>&1) || true
OUT2=$($AC snapshot -p electron 2>&1) || true
if [ -n "$OUT1" ] && [ -n "$OUT2" ]; then
  pass "-p at start = -p at end"
else
  fail "-p position" "start=$(echo "$OUT1" | head -c 50) end=$(echo "$OUT2" | head -c 50)"
fi

# ── B4. Bare ref without @ ──
echo "B4. bare ref (e1 without @)"
if [ -n "$FIRST_REF" ]; then
  BARE=$(echo "$FIRST_REF" | sed 's/@//')
  OUT=$($AC -p electron click "$BARE" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "bare ref $BARE auto-normalized to $FIRST_REF"
  else
    fail "bare ref" "$OUT"
  fi
else
  fail "bare ref" "no ref"
fi

# ── B5. fill multi-word text ──
echo "B5. fill multi-word text"
if [ -n "$INPUT_REF" ]; then
  OUT=$($AC -p electron fill "$INPUT_REF" "Hello World Test" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "fill with multi-word text"
  else
    fail "fill multi-word" "$OUT"
  fi
else
  fail "fill multi-word" "no input ref"
fi

# ── B6. screenshot path ordering ──
echo "B6. screenshot path ordering"
SS1="/tmp/ac-test-electron-order1.png"
SS2="/tmp/ac-test-electron-order2.png"
rm -f "$SS1" "$SS2"
$AC -p electron screenshot "$SS1" 2>&1 > /dev/null || true
$AC screenshot "$SS2" -p electron 2>&1 > /dev/null || true
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

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION C: Multi-window tests
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── C1. windows command (single window) ──"
OUT=$($AC -p electron windows 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  TCOUNT=$(echo "$OUT" | grep -c '"title"' || true)
  if [ "$TCOUNT" -ge 1 ]; then
    pass "windows lists at least 1 target"
  else
    fail "windows count" "expected >=1, got $TCOUNT"
  fi
else
  fail "windows command" "$OUT"
fi

echo "── C2. open second window via eval ──"
# Use eval to trigger second window creation
$AC -p electron eval "window.testAPI && window.testAPI.openSecondWindow()" 2>&1 > /dev/null || true
sleep 2

OUT=$($AC -p electron windows 2>&1) || true
TCOUNT=$(echo "$OUT" | grep -c '"title"' || true)
if [ "$TCOUNT" -ge 2 ]; then
  pass "windows lists 2+ targets after opening second window"
else
  fail "multi-window count" "expected >=2, got $TCOUNT"
fi

echo "── C3. --target 0 (first window) ──"
OUT=$($AC -p electron --target 0 snapshot 2>&1) || true
if echo "$OUT" | grep -q 'Agent Control Test\|Submit\|@e'; then
  pass "--target 0 snapshots first window"
else
  fail "--target 0 snapshot" "$OUT"
fi

echo "── C4. --target 1 (second window) ──"
OUT=$($AC -p electron --target 1 snapshot 2>&1) || true
if echo "$OUT" | grep -q 'Second Window\|Action in Window 2\|input2\|@e'; then
  pass "--target 1 snapshots second window"
else
  fail "--target 1 snapshot" "$OUT"
fi

echo "── C5. --target out of range ──"
OUT=$($AC -p electron --target 99 snapshot 2>&1) || true
if echo "$OUT" | grep -q 'error\|out of range'; then
  pass "--target 99 → error"
else
  fail "--target out of range" "$OUT"
fi

echo "── C6. interact with second window ──"
OUT=$($AC -p electron --target 1 fill @e1 "hello from window 2" 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "fill in second window via --target 1"
else
  fail "fill in second window" "$OUT"
fi

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
