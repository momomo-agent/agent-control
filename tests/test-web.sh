#!/bin/bash
# agent-control web platform test suite
# Tests all commands + parameter ordering variants against a local test page
set -euo pipefail

AC="node $(dirname "$0")/../cli.js"
PASS=0
FAIL=0
SKIP=0
ERRORS=""

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); ERRORS="$ERRORS\n  ❌ $1: $2"; echo "  ❌ $1: $2"; }

echo "=== agent-control web test suite ==="
echo ""

# ── Setup: create test HTML page ──
TEST_HTML="/tmp/ac-test-page.html"
cat > "$TEST_HTML" << 'HTMLEOF'
<!DOCTYPE html>
<html>
<head><title>agent-control test page</title></head>
<body>
  <h1 id="title">Test Page</h1>
  <p id="desc">This is a test paragraph for snapshot verification.</p>
  <form>
    <label for="name">Name:</label>
    <input id="name" type="text" placeholder="Enter name">
    <label for="email">Email:</label>
    <input id="email" type="email" placeholder="Enter email">
    <textarea id="notes" placeholder="Notes here"></textarea>
    <select id="color">
      <option value="red">Red</option>
      <option value="blue">Blue</option>
      <option value="green">Green</option>
    </select>
    <button id="submit" type="button" onclick="document.getElementById('result').textContent='Submitted!'">Submit</button>
    <button id="reset" type="reset">Reset</button>
  </form>
  <div id="result"></div>
  <div style="height:2000px">Scroll area</div>
  <a href="#bottom" id="link">Go to bottom</a>
  <div id="bottom" style="margin-top:1000px">Bottom</div>
</body>
</html>
HTMLEOF

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION A: Core functionality
# ═══════════════════════════════════════════════════════════════════════════════

# ── 1. Open ──
echo "1. open"
OUT=$($AC -p web open "file://$TEST_HTML" 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "open local file"
else
  fail "open" "$OUT"
fi
sleep 1

# ── 2. Snapshot -e ──
echo "2. snapshot -e"
OUT=$($AC -p web -e snapshot 2>&1) || true
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

# ── 3. Snapshot --json ──
echo "3. snapshot --json"
JSON_OUT=$($AC -p web --json snapshot 2>&1)
ELEM_COUNT=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.elements?j.elements.length:0)}catch{console.log(-1)}})" 2>/dev/null)
if [ "${ELEM_COUNT:-0}" -gt 0 ]; then
  pass "snapshot --json returns valid JSON with $ELEM_COUNT elements"
else
  fail "snapshot --json" "invalid JSON or no elements"
fi

# ── 4. Snapshot --all ──
echo "4. snapshot --all"
ALL_OUT=$($AC -p web --all snapshot -e 2>&1) || true
ALL_COUNT=$(echo "$ALL_OUT" | head -1 | grep -oE '[0-9]+' | head -1)
DEFAULT_COUNT=$(echo "$OUT" | head -1 | grep -oE '[0-9]+' | head -1)
if [ "${ALL_COUNT:-0}" -ge "${DEFAULT_COUNT:-0}" ]; then
  pass "--all returns >= default elements ($ALL_COUNT >= $DEFAULT_COUNT)"
else
  fail "--all" "expected more elements ($ALL_COUNT < $DEFAULT_COUNT)"
fi

# ── 5. Snapshot --compact ──
echo "5. snapshot --compact"
COMPACT_OUT=$($AC -p web -c snapshot 2>&1) || true
if [ -n "$COMPACT_OUT" ]; then
  pass "snapshot --compact returns output"
else
  fail "snapshot --compact" "empty output"
fi

# ── 6. Find ──
echo "6. find"
FIND_OUT=$($AC -p web find "Submit" 2>&1) || true
if echo "$FIND_OUT" | grep -qi "submit"; then
  pass "find 'Submit'"
else
  fail "find" "$FIND_OUT"
fi

# ── Helper: get refs ──
SUBMIT_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>(x.label||'').includes('Submit')||(x.value||'').includes('Submit'));if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
NAME_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>(x.label||'').includes('Name')||(x.placeholder||'').includes('name'));if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
EMAIL_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>(x.label||'').includes('Email')||(x.placeholder||'').includes('email'));if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
SELECT_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>x.role==='combobox'||x.tag==='select');if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true
RESET_REF=$(echo "$JSON_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const e=j.elements.find(x=>(x.label||'').includes('Reset')||(x.value||'').includes('Reset'));if(e)console.log(e.ref)}catch{}})" 2>/dev/null) || true

echo "  (refs: submit=$SUBMIT_REF name=$NAME_REF email=$EMAIL_REF select=$SELECT_REF reset=$RESET_REF)"

# ── 7. Click ──
echo "7. click @ref"
if [ -n "$SUBMIT_REF" ]; then
  OUT=$($AC -p web click "$SUBMIT_REF" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "click $SUBMIT_REF"
  else
    fail "click" "$OUT"
  fi
else
  fail "click" "could not find Submit button ref"
fi

# ── 8. Click x y ──
echo "8. click x y"
OUT=$($AC -p web click 100 200 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "click 100 200 (coordinate)"
else
  fail "click x y" "$OUT"
fi

# ── 9. Fill ──
echo "9. fill"
if [ -n "$NAME_REF" ]; then
  OUT=$($AC -p web fill "$NAME_REF" "test user" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "fill $NAME_REF"
  else
    fail "fill" "$OUT"
  fi
else
  fail "fill" "could not find Name input ref"
fi

# ── 10. Press ──
echo "10. press"
OUT=$($AC -p web press Tab 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "press Tab"
else
  fail "press" "$OUT"
fi

# ── 11. Select ──
echo "11. select"
if [ -n "$SELECT_REF" ]; then
  OUT=$($AC -p web select "$SELECT_REF" "blue" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "select $SELECT_REF blue"
  else
    fail "select" "$OUT"
  fi
else
  fail "select" "could not find select element ref"
fi

# ── 12. Scroll ──
echo "12. scroll"
for dir in down up left right; do
  OUT=$($AC -p web scroll $dir 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "scroll $dir"
  else
    fail "scroll $dir" "$OUT"
  fi
done

# ── 13. Scroll with amount ──
echo "13. scroll with amount"
OUT=$($AC -p web scroll down 300 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "scroll down 300"
else
  fail "scroll down 300" "$OUT"
fi

# ── 14. Screenshot ──
echo "14. screenshot"
SS_PATH="/tmp/ac-test-web-screenshot.png"
rm -f "$SS_PATH"
OUT=$($AC -p web screenshot "$SS_PATH" 2>&1) || true
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

# ── 15. Screenshot default path ──
echo "15. screenshot (default path)"
rm -f /tmp/agent-control-web.png
OUT=$($AC -p web screenshot 2>&1) || true
if [ -f /tmp/agent-control-web.png ]; then
  pass "screenshot default path works"
  rm -f /tmp/agent-control-web.png
else
  fail "screenshot default" "no file at default path"
fi

# ── 16. Longpress ──
echo "16. longpress"
if [ -n "$SUBMIT_REF" ]; then
  OUT=$($AC -p web longpress "$SUBMIT_REF" --duration=500 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "longpress $SUBMIT_REF 500ms"
  else
    fail "longpress" "$OUT"
  fi
else
  fail "longpress" "no ref available"
fi

# ── 17. Drag ──
echo "17. drag @ref @ref"
if [ -n "$NAME_REF" ] && [ -n "$SUBMIT_REF" ]; then
  OUT=$($AC -p web drag "$NAME_REF" "$SUBMIT_REF" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "drag $NAME_REF → $SUBMIT_REF"
  else
    fail "drag" "$OUT"
  fi
else
  fail "drag" "no refs available"
fi

# ── 18. Drag x1 y1 x2 y2 ──
echo "18. drag x1 y1 x2 y2"
OUT=$($AC -p web drag 50 50 200 200 2>&1) || true
if echo "$OUT" | grep -q "ok"; then
  pass "drag 50,50 → 200,200 (coordinate)"
else
  fail "drag x y" "$OUT"
fi

# ── 19. Double click ──
echo "19. dblclick"
if [ -n "$SUBMIT_REF" ]; then
  OUT=$($AC -p web dblclick "$SUBMIT_REF" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "dblclick $SUBMIT_REF"
  else
    fail "dblclick" "$OUT"
  fi
else
  fail "dblclick" "no ref available"
fi

# ── 20. Right click ──
echo "20. rightclick"
if [ -n "$SUBMIT_REF" ]; then
  OUT=$($AC -p web rightclick "$SUBMIT_REF" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "rightclick $SUBMIT_REF"
  else
    fail "rightclick" "$OUT"
  fi
else
  fail "rightclick" "no ref available"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION B: Parameter ordering variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── Parameter ordering variants ──"

# ── B1. -e before vs after snapshot ──
echo "B1. -e position"
OUT1=$($AC -p web -e snapshot 2>&1) || true
OUT2=$($AC -p web snapshot -e 2>&1) || true
HAS1=$(echo "$OUT1" | grep -c "interactive elements" || true)
HAS2=$(echo "$OUT2" | grep -c "interactive elements" || true)
if [ "$HAS1" -gt 0 ] && [ "$HAS2" -gt 0 ]; then
  pass "-e before snapshot = -e after snapshot"
else
  fail "-e position" "before=$HAS1 after=$HAS2"
fi

# ── B2. --json before vs after snapshot ──
echo "B2. --json position"
OUT1=$($AC -p web --json snapshot 2>&1) || true
OUT2=$($AC -p web snapshot --json 2>&1) || true
C1=$(echo "$OUT1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).elements?'ok':'no')}catch{console.log('no')}})" 2>/dev/null)
C2=$(echo "$OUT2" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).elements?'ok':'no')}catch{console.log('no')}})" 2>/dev/null)
if [ "$C1" = "ok" ] && [ "$C2" = "ok" ]; then
  pass "--json before snapshot = --json after snapshot"
else
  fail "--json position" "before=$C1 after=$C2"
fi

# ── B3. -p position variants ──
echo "B3. -p position"
OUT1=$($AC -p web snapshot -i 2>&1) || true
OUT2=$($AC snapshot -i -p web 2>&1) || true
if echo "$OUT1" | head -c 20 | grep -q '\[' && echo "$OUT2" | head -c 20 | grep -q '\['; then
  pass "-p at start = -p at end"
else
  fail "-p position" "start=$(echo "$OUT1" | head -c 50) end=$(echo "$OUT2" | head -c 50)"
fi

# ── B4. Bare ref without @ ──
echo "B4. bare ref (e3 without @)"
if [ -n "$SUBMIT_REF" ]; then
  BARE=$(echo "$SUBMIT_REF" | sed 's/@//')
  OUT=$($AC -p web click "$BARE" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "bare ref $BARE auto-normalized to $SUBMIT_REF"
  else
    fail "bare ref" "$OUT"
  fi
else
  fail "bare ref" "no ref"
fi

# ── B5. fill with multi-word text ──
echo "B5. fill multi-word text"
if [ -n "$NAME_REF" ]; then
  OUT=$($AC -p web fill "$NAME_REF" "John Doe the Third" 2>&1) || true
  if echo "$OUT" | grep -q "ok"; then
    pass "fill with multi-word text"
  else
    fail "fill multi-word" "$OUT"
  fi
else
  fail "fill multi-word" "no ref"
fi

# ── B6. screenshot path ordering ──
echo "B6. screenshot path ordering"
SS1="/tmp/ac-test-web-order1.png"
SS2="/tmp/ac-test-web-order2.png"
rm -f "$SS1" "$SS2"
$AC -p web screenshot "$SS1" 2>&1 > /dev/null || true
$AC screenshot "$SS2" -p web 2>&1 > /dev/null || true
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

# ── B7. select with value ──
echo "B7. select different values"
if [ -n "$SELECT_REF" ]; then
  OUT1=$($AC -p web select "$SELECT_REF" "red" 2>&1) || true
  OUT2=$($AC -p web select "$SELECT_REF" "green" 2>&1) || true
  OK=0
  echo "$OUT1" | grep -q "ok" && OK=$((OK+1))
  echo "$OUT2" | grep -q "ok" && OK=$((OK+1))
  if [ "$OK" -eq 2 ]; then
    pass "select red then green"
  else
    fail "select values" "$OK/2"
  fi
else
  fail "select values" "no select ref"
fi

# ── 21. Close ──
echo ""
echo "21. close"
OUT=$($AC -p web close 2>&1) || true
if echo "$OUT" | grep -q "ok\|closed\|Browser\|hang up\|ECONNRESET"; then
  pass "close"
else
  fail "close" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION D: Multi-layer tests (iframe + shadow DOM)
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── D1. open multi-layer fixture ──"
MULTI_FIXTURE="file://$(cd "$(dirname "$0")" && pwd)/multi-layer-fixture.html"
OUT=$($AC -p web open "$MULTI_FIXTURE" 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "open multi-layer fixture"
else
  fail "open multi-layer fixture" "$OUT"
fi
sleep 1

echo "── D2. snapshot sees main page elements ──"
OUT=$($AC -p web snapshot 2>&1) || true
if echo "$OUT" | grep -q "Main Button\|main-btn"; then
  pass "snapshot sees main page button"
else
  fail "snapshot main page" "$OUT"
fi

echo "── D3. snapshot iframe visibility ──"
# Current behavior: snapshot may or may not see iframe content
# This test documents the current state
if echo "$OUT" | grep -q "iFrame Button\|iframe-btn"; then
  pass "snapshot sees iframe content (iframe piercing works)"
else
  echo "  ⚠️  snapshot does NOT see iframe content (expected limitation)"
  SKIP=$((SKIP+1))
fi

echo "── D4. snapshot shadow DOM visibility ──"
if echo "$OUT" | grep -q "Shadow Button\|shadow-btn"; then
  pass "snapshot sees shadow DOM content"
else
  echo "  ⚠️  snapshot does NOT see shadow DOM content (expected limitation)"
  SKIP=$((SKIP+1))
fi

echo "── D5. close multi-layer ──"
$AC -p web close 2>&1 > /dev/null || true

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
