#!/bin/bash
# agent-control Flutter driver test suite
# Uses a mock Dart VM Service to test protocol handling
set -euo pipefail

AC="node $(dirname "$0")/../cli.js"
AC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_PORT=19231
MOCK_PID=""
PASS=0
FAIL=0
SKIP=0
ERRORS=""

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); ERRORS="$ERRORS\n  ❌ $1: $2"; echo "  ❌ $1: $2"; }
skip() { SKIP=$((SKIP+1)); echo "  ⏭️  $1"; }

cleanup() {
  if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  rm -f /tmp/agent-control-flutter-snap.json
}
trap cleanup EXIT

echo "=== agent-control Flutter test suite ==="
echo ""

# ── Create mock VM service ──
MOCK_SCRIPT="$AC_DIR/tests/flutter-mock-server.js"
cat > "$MOCK_SCRIPT" << 'MOCKEOF'
const WebSocket = require('ws');
const fs = require('fs');
const PORT = parseInt(process.env.MOCK_PORT || '19231');

const wss = new WebSocket.Server({ port: PORT });

// Mock widget tree
const MOCK_TREE = {
  widgetRuntimeType: 'MaterialApp',
  label: 'Test App',
  children: [
    {
      widgetRuntimeType: 'Scaffold',
      label: '',
      children: [
        { widgetRuntimeType: 'AppBar', label: 'Home', textPreview: 'Home', children: [] },
        {
          widgetRuntimeType: 'Column',
          label: '',
          children: [
            { widgetRuntimeType: 'Text', label: 'Hello World', textPreview: 'Hello World', children: [] },
            { widgetRuntimeType: 'ElevatedButton', label: 'Submit', hasAction: true, children: [] },
            { widgetRuntimeType: 'TextField', label: 'Enter name', hasAction: true, isFocusable: true, children: [] },
            { widgetRuntimeType: 'Checkbox', label: 'Agree', hasAction: true, value: 'false', children: [] },
            { widgetRuntimeType: 'IconButton', label: 'Settings', hasAction: true, children: [] },
            { widgetRuntimeType: 'Switch', label: 'Dark mode', hasAction: true, value: 'off', children: [] },
            { widgetRuntimeType: 'Slider', label: 'Volume', hasAction: true, value: '50', children: [] },
            { widgetRuntimeType: 'ListTile', label: 'Profile', hasAction: true, children: [] },
          ]
        }
      ]
    }
  ]
};

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const { id, method, params } = msg;
    let result;

    switch (method) {
      case 'getVM':
        result = { isolates: [{ id: 'isolates/main', name: 'main' }] };
        break;

      case 'ext.flutter.inspector.getRootWidgetSummaryTree':
        result = MOCK_TREE;
        break;

      case 'ext.flutter.inspector.getRootRenderObject':
        result = MOCK_TREE;
        break;

      case 'ext.flutter.driver':
        // Handle driver commands
        const cmd = params?.command;
        switch (cmd) {
          case 'tap':
            result = { status: 'ok' };
            break;
          case 'enter_text':
            result = { status: 'ok', text: params.text };
            break;
          case 'scroll':
            result = { status: 'ok', dx: params.dx, dy: params.dy };
            break;
          case 'screenshot':
            // Return a tiny 1x1 red PNG as base64
            const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
            result = { screenshot: PNG_1x1 };
            break;
          case 'request_data':
            result = { status: 'ok', message: params.message };
            break;
          default:
            result = { status: 'ok', command: cmd };
        }
        break;

      case '_flutter.screenshot':
        const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
        result = { screenshot: PNG };
        break;

      default:
        result = { type: 'Sentinel', kind: 'Collected', valueAsString: 'not implemented' };
    }

    ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});

console.log(`Mock Flutter VM service on ws://127.0.0.1:${PORT}/ws`);
MOCKEOF

echo "Starting mock Flutter VM service (port $MOCK_PORT)..."
MOCK_PORT=$MOCK_PORT node "$MOCK_SCRIPT" &
MOCK_PID=$!
sleep 1

if ! kill -0 "$MOCK_PID" 2>/dev/null; then
  echo "❌ Mock server failed to start"; exit 1
fi
echo "Mock server running (PID $MOCK_PID) ✅"
echo ""

export FLUTTER_VM_SERVICE_URL="ws://127.0.0.1:$MOCK_PORT/ws"

# ═══════════════════════════════════════════════════════════════════════════════
# 1. CONNECTION
# ═══════════════════════════════════════════════════════════════════════════════
echo "── 1. connection ──"

# No URL → error
OUT=$(FLUTTER_VM_SERVICE_URL="" $AC -p flutter snapshot 2>&1) || true
if echo "$OUT" | grep -q "no Flutter VM service URL"; then
  pass "no URL → helpful error"
else
  fail "no URL" "$OUT"
fi

# Bad URL → error
OUT=$(FLUTTER_VM_SERVICE_URL="ws://127.0.0.1:19999/ws" $AC -p flutter snapshot 2>&1) || true
if echo "$OUT" | grep -qi "cannot connect\|error"; then
  pass "bad URL → connection error"
else
  fail "bad URL" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 2. SNAPSHOT
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 2. snapshot ──"

# Raw snapshot
OUT=$($AC -p flutter snapshot 2>&1) || true
if echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);process.exit(Array.isArray(a)&&a.length>0?0:1)}catch{process.exit(1)}})" 2>/dev/null; then
  COUNT=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).length)}catch{console.log(0)}})")
  pass "snapshot → JSON array ($COUNT elements)"
else
  fail "snapshot" "$OUT"
fi

# Snapshot -i (interactive only)
OUT_I=$($AC -p flutter snapshot -i 2>&1) || true
COUNT_I=$(echo "$OUT_I" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).length)}catch{console.log(-1)}})" 2>/dev/null)
if [ "${COUNT_I:-0}" -gt 0 ] && [ "${COUNT_I:-0}" -le "${COUNT:-0}" ]; then
  pass "snapshot -i filters interactive ($COUNT_I <= $COUNT)"
else
  fail "snapshot -i" "interactive=$COUNT_I total=$COUNT"
fi

# Snapshot -e (enhanced)
OUT_E=$($AC -p flutter -e snapshot 2>&1) || true
if echo "$OUT_E" | grep -qE '\[ref=@e[0-9]+\]|interactive elements'; then
  pass "snapshot -e → enhanced text with refs"
else
  fail "snapshot -e" "$(echo "$OUT_E" | head -3)"
fi

# Snapshot --json (enhanced JSON)
OUT_J=$($AC -p flutter --json snapshot 2>&1) || true
if echo "$OUT_J" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);process.exit(j.elements?0:1)}catch{process.exit(1)}})" 2>/dev/null; then
  pass "snapshot --json → {elements, summary}"
else
  fail "snapshot --json" "$(echo "$OUT_J" | head -3)"
fi

# Check refs format
HAS_REFS=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);console.log(a.every(e=>e.ref&&e.ref.startsWith('@e')))}catch{console.log(false)}})" 2>/dev/null)
if [ "$HAS_REFS" = "true" ]; then
  pass "all elements have @eN refs"
else
  fail "refs format" "not all @eN"
fi

# Check interactive flag
HAS_INTERACTIVE=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);const i=a.filter(e=>e.interactive);console.log(i.length>0&&i.length<a.length)}catch{console.log(false)}})" 2>/dev/null)
if [ "$HAS_INTERACTIVE" = "true" ]; then
  pass "interactive flag correctly set"
else
  fail "interactive flag" "all or none interactive"
fi

# Check widget types preserved
HAS_TYPES=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);const types=a.map(e=>e.type);console.log(types.includes('ElevatedButton')&&types.includes('TextField'))}catch{console.log(false)}})" 2>/dev/null)
if [ "$HAS_TYPES" = "true" ]; then
  pass "widget types preserved (ElevatedButton, TextField)"
else
  fail "widget types" "missing expected types"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 3. CLICK
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 3. click ──"

# Click by coordinates
for coords in "100 200" "0 0" "300 400" "50 50"; do
  OUT=$($AC -p flutter click $coords 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "click $coords"
  else
    fail "click $coords" "$OUT"
  fi
done

# Click no args → error
OUT=$($AC -p flutter click 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "click (no args) → error"
else
  fail "click no args" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 4. FILL
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 4. fill ──"

# Fill requires ref
OUT=$($AC -p flutter fill 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "fill (no args) → error"
else
  fail "fill no args" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 5. PRESS
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 5. press ──"

for key in enter tab escape space backspace back; do
  OUT=$($AC -p flutter press $key 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "press $key"
  else
    fail "press $key" "$OUT"
  fi
done

# Press no key → error
OUT=$($AC -p flutter press 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "press (no key) → error"
else
  fail "press no key" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 6. SCROLL
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 6. scroll ──"

for dir in up down left right; do
  OUT=$($AC -p flutter scroll $dir 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "scroll $dir"
  else
    fail "scroll $dir" "$OUT"
  fi
done

# Scroll with amount
for combo in "down 100" "down 500" "up 200" "left 300" "right 150"; do
  OUT=$($AC -p flutter scroll $combo 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "scroll $combo"
  else
    fail "scroll $combo" "$OUT"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════
# 7. SWIPE
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 7. swipe ──"

for dir in up down left right; do
  OUT=$($AC -p flutter swipe $dir 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "swipe $dir"
  else
    fail "swipe $dir" "$OUT"
  fi
done

# ═══════════════════════════════════════════════════════════════════════════════
# 8. SCREENSHOT
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 8. screenshot ──"

# Default path
rm -f /tmp/agent-control-flutter.png
OUT=$($AC -p flutter screenshot 2>&1) || true
if [ -f /tmp/agent-control-flutter.png ]; then
  pass "screenshot (default path)"
  rm -f /tmp/agent-control-flutter.png
else
  fail "screenshot default" "no file"
fi

# Custom path
rm -f /tmp/flutter-test-shot.png
OUT=$($AC -p flutter screenshot /tmp/flutter-test-shot.png 2>&1) || true
if [ -f /tmp/flutter-test-shot.png ]; then
  pass "screenshot /tmp/flutter-test-shot.png"
  rm -f /tmp/flutter-test-shot.png
else
  fail "screenshot custom" "no file"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 9. DRAG
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 9. drag ──"

for coords in "10 10 200 200" "0 0 100 100" "50 50 300 300"; do
  OUT=$($AC -p flutter drag $coords 2>&1) || true
  if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
    pass "drag $coords"
  else
    fail "drag $coords" "$OUT"
  fi
done

# Drag no args → error
OUT=$($AC -p flutter drag 2>&1) || true
if echo "$OUT" | grep -qi "error\|usage"; then
  pass "drag (no args) → error"
else
  fail "drag no args" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 10. FIND
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 10. find ──"

# Find existing text
OUT=$($AC -p flutter find Submit 2>&1) || true
if echo "$OUT" | grep -q '"count"' && echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "find 'Submit'"
else
  fail "find Submit" "$OUT"
fi

# Find case insensitive
OUT=$($AC -p flutter find submit 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "find 'submit' (lowercase)"
else
  fail "find lowercase" "$OUT"
fi

# Find non-existent
OUT=$($AC -p flutter find "NonExistent12345" 2>&1) || true
if echo "$OUT" | grep -q '"count": 0\|"count":0'; then
  pass "find non-existent → count 0"
else
  fail "find non-existent" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 11. BACK
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 11. back ──"

OUT=$($AC -p flutter back 2>&1) || true
if echo "$OUT" | grep -q '"ok": true\|"ok":true'; then
  pass "back navigation"
else
  fail "back" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 12. UNKNOWN COMMAND
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 12. error handling ──"

OUT=$($AC -p flutter foobar 2>&1) || true
if echo "$OUT" | grep -qi "unknown command\|error"; then
  pass "unknown command → error"
else
  fail "unknown command" "$OUT"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 13. --vm-service flag
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── 13. --vm-service flag ──"

# Pass URL via flag instead of env
OUT=$(FLUTTER_VM_SERVICE_URL="" $AC -p flutter --vm-service "ws://127.0.0.1:$MOCK_PORT/ws" snapshot 2>&1) || true
if echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const a=JSON.parse(d);process.exit(Array.isArray(a)?0:1)}catch{process.exit(1)}})" 2>/dev/null; then
  pass "--vm-service flag works"
else
  fail "--vm-service flag" "$OUT"
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
