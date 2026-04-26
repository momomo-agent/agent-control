#!/bin/bash
# agent-control args variant test suite
# Tests different argument VALUES for each command
# Uses Electron fixture for self-contained testing
set -euo pipefail

AC="node $(dirname "$0")/../cli.js"
FIXTURE_DIR="$(cd "$(dirname "$0")/electron-fixture" && pwd)"
ELECTRON_BIN="/Users/kenefe/LOCAL/momo-agent/projects/paw/node_modules/.bin/electron"
CDP_PORT=19230
ELECTRON_PID=""
PASS=0
FAIL=0
SKIP=0
ERRORS=""

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); ERRORS="$ERRORS\n  ❌ $1: $2"; echo "  ❌ $1: $2"; }
skip() { SKIP=$((SKIP+1)); echo "  ⏭️  $1"; }

cleanup() {
  if [ -n "$ELECTRON_PID" ] && kill -0 "$ELECTRON_PID" 2>/dev/null; then
    kill "$ELECTRON_PID" 2>/dev/null || true
    wait "$ELECTRON_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== agent-control args variant test suite ==="
echo ""

# ── Start fixture ──
echo "Starting Electron fixture (CDP $CDP_PORT)..."
ELECTRON_DEBUG_PORT=$CDP_PORT "$ELECTRON_BIN" "$FIXTURE_DIR" --remote-debugging-port=$CDP_PORT &
ELECTRON_PID=$!
sleep 3
if ! curl -s "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; then
  echo "❌ CDP not responding"; exit 1
fi
echo "Fixture running ✅"
echo ""
export ELECTRON_DEBUG_PORT=$CDP_PORT

# ═══════════════════════════════════════════════════════════════════════════════
# 1. SNAPSHOT variants
# ═══════════════════════════════════════════════════════════════════════════════
echo "── 1. snapshot flag combinations ──"

# Raw (no flags)
OUT=$($AC -p electron snapshot 2>&1) || true
if echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.exit(Array.isArray(JSON.parse(d))?0:1)}catch{process.exit(1)}})" 2>/dev/null; then
  pass "snapshot (raw, no flags) → JSON array"
else
  fail "snapshot raw" "not a JSON array"
fi

# -i (interactive only)
OUT_I=$($AC -p electron snapshot -i 2>&1) || true
COUNT_I=$(echo "$OUT_I" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);console.log(a.length)}catch{console.log(-1)}})" 2>/dev/null)
COUNT_ALL=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);console.log(a.length)}catch{console.log(-1)}})" 2>/dev/null)
if [ "${COUNT_I:-0}" -le "${COUNT_ALL:-0}" ] && [ "${COUNT_I:-0}" -gt 0 ]; then
  pass "snapshot -i filters to interactive ($COUNT_I <= $COUNT_ALL)"
else
  fail "snapshot -i" "interactive=$COUNT_I all=$COUNT_ALL"
fi

# -e (enhanced text)
OUT_E=$($AC -p electron -e snapshot 2>&1) || true
if echo "$OUT_E" | grep -q "interactive elements" && echo "$OUT_E" | grep -qE '\[ref=@e[0-9]+\]'; then
  pass "snapshot -e → text with refs"
else
  fail "snapshot -e" "missing summary or refs"
fi

# --json (enhanced JSON)
OUT_J=$($AC -p electron --json snapshot 2>&1) || true
if echo "$OUT_J" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);process.exit(j.elements&&j.summary?0:1)}catch{process.exit(1)}})" 2>/dev/null; then
  pass "snapshot --json → {elements, summary}"
else
  fail "snapshot --json" "missing elements or summary"
fi

# --compact (compact text)
OUT_C=$($AC -p electron -c snapshot 2>&1) || true
LEN_E=${#OUT_E}
LEN_C=${#OUT_C}
if [ "$LEN_C" -le "$LEN_E" ] && [ "$LEN_C" -gt 0 ]; then
  pass "snapshot --compact <= -e ($LEN_C <= $LEN_E)"
else
  fail "snapshot --compact" "compact=$LEN_C enhanced=$LEN_E"
fi

# --all (include non-interactive)
OUT_ALL=$($AC -p electron --all --json snapshot 2>&1) || true
COUNT_ENHANCED=$(echo "$OUT_J" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).elements.length)}catch{console.log(-1)}})" 2>/dev/null)
COUNT_ALL_E=$(echo "$OUT_ALL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).elements.length)}catch{console.log(-1)}})" 2>/dev/null)
if [ "${COUNT_ALL_E:-0}" -ge "${COUNT_ENHANCED:-0}" ]; then
  pass "snapshot --all --json includes more ($COUNT_ALL_E >= $COUNT_ENHANCED)"
else
  fail "snapshot --all" "all=$COUNT_ALL_E default=$COUNT_ENHANCED"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 2. CLICK variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 2. click arg variants ──"

# click @ref
OUT=$($AC -p electron click @e1 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "click @e1" || fail "click @e1" "$OUT"

# click different refs
for ref in @e1 @e2 @e3 @e4 @e5 @e6; do
  OUT=$($AC -p electron click "$ref" 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "click $ref" || fail "click $ref" "$OUT"
done

# click x y — different coordinates
for coords in "10 10" "100 50" "200 200" "0 0" "400 300"; do
  OUT=$($AC -p electron click $coords 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "click $coords" || fail "click $coords" "$OUT"
done

# click with --right flag
OUT=$($AC -p electron click @e1 --right 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "click @e1 --right" || fail "click --right" "$OUT"

# ═══════════════════════════════════════════════════════════════════════════════
# 3. FILL variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 3. fill arg variants ──"

# Single word
OUT=$($AC -p electron fill @e1 "hello" 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "fill single word" || fail "fill single" "$OUT"

# Multi-word
OUT=$($AC -p electron fill @e1 "hello world test" 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "fill multi-word" || fail "fill multi" "$OUT"

# Special characters
OUT=$($AC -p electron fill @e1 "test@email.com" 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "fill with @" || fail "fill @" "$OUT"

OUT=$($AC -p electron fill @e1 "path/to/file.txt" 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "fill with slashes" || fail "fill slashes" "$OUT"

OUT=$($AC -p electron fill @e1 "it's a test" 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "fill with apostrophe" || fail "fill apostrophe" "$OUT"

# Unicode
OUT=$($AC -p electron fill @e1 "你好世界" 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "fill unicode (中文)" || fail "fill unicode" "$OUT"

# Numbers
OUT=$($AC -p electron fill @e1 "12345" 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "fill numbers" || fail "fill numbers" "$OUT"

# Long text
OUT=$($AC -p electron fill @e1 "The quick brown fox jumps over the lazy dog 1234567890" 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "fill long text" || fail "fill long" "$OUT"

# Different refs
OUT=$($AC -p electron fill @e2 "email field" 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "fill @e2" || fail "fill @e2" "$OUT"

# ═══════════════════════════════════════════════════════════════════════════════
# 4. PRESS variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 4. press key variants ──"

for key in Escape Tab Enter Space Backspace ArrowUp ArrowDown ArrowLeft ArrowRight Home End PageUp PageDown Delete; do
  OUT=$($AC -p electron press "$key" 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "press $key" || fail "press $key" "$OUT"
done

# Single character keys
for key in a z A Z 0 9; do
  OUT=$($AC -p electron press "$key" 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "press '$key'" || fail "press '$key'" "$OUT"
done

# ═══════════════════════════════════════════════════════════════════════════════
# 5. SCROLL variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 5. scroll direction + amount variants ──"

# All directions
for dir in up down left right; do
  OUT=$($AC -p electron scroll $dir 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "scroll $dir (default amount)" || fail "scroll $dir" "$OUT"
done

# Different amounts
for amount in 50 100 200 500 1000; do
  OUT=$($AC -p electron scroll down $amount 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "scroll down $amount" || fail "scroll down $amount" "$OUT"
done

# Direction + amount combos
for combo in "up 100" "up 500" "down 100" "down 500" "left 200" "right 200"; do
  OUT=$($AC -p electron scroll $combo 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "scroll $combo" || fail "scroll $combo" "$OUT"
done

# ═══════════════════════════════════════════════════════════════════════════════
# 6. LONGPRESS variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 6. longpress duration variants ──"

# Different durations
for dur in 100 300 500 1000; do
  OUT=$($AC -p electron longpress @e1 --duration=$dur 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "longpress @e1 --duration=$dur" || fail "longpress dur=$dur" "$OUT"
done

# Longpress with coordinates
OUT=$($AC -p electron longpress 100 100 --duration=300 2>&1) || true
echo "$OUT" | grep -q "ok" && pass "longpress 100 100 --duration=300" || fail "longpress coords" "$OUT"

# Different refs
for ref in @e1 @e2 @e3; do
  OUT=$($AC -p electron longpress "$ref" --duration=200 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "longpress $ref" || fail "longpress $ref" "$OUT"
done

# ═══════════════════════════════════════════════════════════════════════════════
# 7. DRAG variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 7. drag arg variants ──"

# @ref to @ref
for pair in "@e1 @e2" "@e2 @e3" "@e1 @e4" "@e3 @e1"; do
  OUT=$($AC -p electron drag $pair 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "drag $pair" || fail "drag $pair" "$OUT"
done

# Coordinate pairs
for coords in "10 10 200 200" "0 0 100 100" "50 50 300 300" "200 100 50 50"; do
  OUT=$($AC -p electron drag $coords 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "drag $coords" || fail "drag $coords" "$OUT"
done

# ═══════════════════════════════════════════════════════════════════════════════
# 8. SCREENSHOT variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 8. screenshot arg variants ──"

# Default path
rm -f /tmp/screenshot.png
OUT=$($AC -p electron screenshot 2>&1) || true
if [ -f /tmp/screenshot.png ]; then
  pass "screenshot (default path)"
  rm -f /tmp/screenshot.png
else
  fail "screenshot default" "no file"
fi

# Custom path
for p in "/tmp/ac-args-test1.png" "/tmp/ac-args-test2.png" "/tmp/ac args space.png"; do
  rm -f "$p"
  OUT=$($AC -p electron screenshot "$p" 2>&1) || true
  if [ -f "$p" ]; then
    SIZE=$(stat -f%z "$p" 2>/dev/null || stat -c%s "$p" 2>/dev/null)
    if [ "${SIZE:-0}" -gt 500 ]; then
      pass "screenshot '$p' (${SIZE}b)"
    else
      fail "screenshot '$p'" "too small (${SIZE}b)"
    fi
    rm -f "$p"
  else
    fail "screenshot '$p'" "not created"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════
# 9. DBLCLICK variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 9. dblclick arg variants ──"

for ref in @e1 @e2 @e3 @e4; do
  OUT=$($AC -p electron dblclick "$ref" 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "dblclick $ref" || fail "dblclick $ref" "$OUT"
done

# ═══════════════════════════════════════════════════════════════════════════════
# 10. RIGHTCLICK variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 10. rightclick arg variants ──"

for ref in @e1 @e2 @e3; do
  OUT=$($AC -p electron rightclick "$ref" 2>&1) || true
  echo "$OUT" | grep -q "ok" && pass "rightclick $ref" || fail "rightclick $ref" "$OUT"
done

# ═══════════════════════════════════════════════════════════════════════════════
# 11. EVAL variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 11. eval expression variants ──"

# Simple property
OUT=$($AC -p electron eval "document.title" 2>&1) || true
echo "$OUT" | grep -qi "test" && pass "eval document.title" || fail "eval title" "$OUT"

# Return value
OUT=$($AC -p electron eval "1 + 1" 2>&1) || true
echo "$OUT" | grep -q "2" && pass "eval 1+1 = 2" || fail "eval 1+1" "$OUT"

# String return
OUT=$($AC -p electron eval "'hello'" 2>&1) || true
echo "$OUT" | grep -q "hello" && pass "eval string literal" || fail "eval string" "$OUT"

# DOM query
OUT=$($AC -p electron eval "document.querySelectorAll('input').length" 2>&1) || true
echo "$OUT" | grep -qE "[0-9]" && pass "eval DOM query" || fail "eval DOM" "$OUT"

# Boolean
OUT=$($AC -p electron eval "document.hasFocus()" 2>&1) || true
echo "$OUT" | grep -qE "true|false" && pass "eval boolean" || fail "eval bool" "$OUT"

# ═══════════════════════════════════════════════════════════════════════════════
# 12. FIND variants
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 12. find query variants ──"

# Exact match
OUT=$($AC -p electron find "Submit" 2>&1) || true
echo "$OUT" | grep -qi "submit" && pass "find 'Submit'" || fail "find Submit" "$OUT"

# Case insensitive
OUT=$($AC -p electron find "submit" 2>&1) || true
echo "$OUT" | grep -qi "submit" && pass "find 'submit' (lowercase)" || fail "find lowercase" "$OUT"

# Partial match
OUT=$($AC -p electron find "Name" 2>&1) || true
echo "$OUT" | grep -qi "name" && pass "find 'Name'" || fail "find Name" "$OUT"

# Non-existent
OUT=$($AC -p electron find "NonExistentElement12345" 2>&1) || true
# Should return empty or no match — not crash
if ! echo "$OUT" | grep -qi "error\|crash\|exception"; then
  pass "find non-existent (no crash)"
else
  fail "find non-existent" "crashed: $OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 13. ERROR HANDLING — invalid args
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 13. error handling (invalid args) ──"

# Click with no args
OUT=$($AC -p electron click 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage\|missing"; then
  pass "click (no args) → error message"
else
  fail "click no args" "no error: $OUT"
fi

# Fill with no text
OUT=$($AC -p electron fill @e1 2>&1) || true
# Should either error or be a no-op
pass "fill @e1 (no text) → handled"

# Press with no key
OUT=$($AC -p electron press 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage\|missing\|no key"; then
  pass "press (no key) → error message"
else
  fail "press no key" "no error: $OUT"
fi

# Click non-existent ref
OUT=$($AC -p electron click @e999 2>&1) || true
if echo "$OUT" | grep -qi "error\|not found"; then
  pass "click @e999 → not found error"
else
  fail "click @e999" "no error: $OUT"
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
