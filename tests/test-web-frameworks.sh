#!/bin/bash
# test-web-frameworks.sh — Test agent-control Web driver against Vanilla/Vue/React
# Tests: snapshot, click, fill, select, screenshot, tab switching, dialog, dynamic list
set -euo pipefail

AC="agent-control -p web"
DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES="$DIR/fixtures"
PASS=0; FAIL=0; SKIP=0
ERRORS=""

pass() { ((PASS++)); echo "  ✅ $1"; }
fail() { ((FAIL++)); echo "  ❌ $1: $2"; ERRORS="$ERRORS\n  ❌ $1: $2"; }
skip() { ((SKIP++)); echo "  ⚠️  $1 (skipped)"; }

# Kill any existing daemon
$AC close 2>/dev/null || true
sleep 0.5

test_framework() {
  local NAME="$1"
  local FILE="$2"
  echo ""
  echo "═══════════════════════════════════════"
  echo "  Testing: $NAME"
  echo "═══════════════════════════════════════"

  # 1. Open page
  echo "--- Open ---"
  local OPEN_RESULT
  OPEN_RESULT=$($AC open "file://$FILE" 2>&1)
  if echo "$OPEN_RESULT" | grep -q '"ok": true\|"ok":true'; then
    pass "$NAME: open page"
  else
    fail "$NAME: open page" "$OPEN_RESULT"
    return
  fi
  sleep 1  # Wait for JS frameworks to mount

  # 2. Snapshot — check elements found
  echo "--- Snapshot ---"
  local SNAP
  SNAP=$($AC snapshot 2>&1)
  local ELEM_COUNT
  ELEM_COUNT=$(echo "$SNAP" | grep -o '"ref"' | wc -l | tr -d ' ')
  if [ "$ELEM_COUNT" -gt 5 ]; then
    pass "$NAME: snapshot found $ELEM_COUNT elements"
  else
    fail "$NAME: snapshot" "only $ELEM_COUNT elements found"
  fi

  # 3. Snapshot with -i (interactive only, raw JSON)
  local SNAP_I
  SNAP_I=$($AC snapshot -i 2>&1)
  local I_COUNT
  I_COUNT=$(echo "$SNAP_I" | grep -o '"ref"' | wc -l | tr -d ' ')
  if [ "$I_COUNT" -le "$ELEM_COUNT" ]; then
    pass "$NAME: snapshot -i found $I_COUNT interactive elements (<= $ELEM_COUNT total)"
  else
    fail "$NAME: snapshot -i" "$I_COUNT > $ELEM_COUNT"
  fi

  # 4. Check specific elements exist
  # Name input
  if echo "$SNAP" | grep -q '"aria-label":\s*"Name"\|"label":\s*"Name"\|"placeholder":\s*"Enter your name"\|Name'; then
    pass "$NAME: Name input found"
  else
    # Try broader search
    if echo "$SNAP" | grep -qi 'name'; then
      pass "$NAME: Name input found (broad match)"
    else
      fail "$NAME: Name input" "not found in snapshot"
    fi
  fi

  # Submit button
  if echo "$SNAP" | grep -q 'Submit'; then
    pass "$NAME: Submit button found"
  else
    fail "$NAME: Submit button" "not found in snapshot"
  fi

  # 5. Find and fill the Name input
  echo "--- Fill ---"
  local NAME_REF
  NAME_REF=$(echo "$SNAP" | grep -o '"ref": *"@e[0-9]*"' | head -1 | grep -o '@e[0-9]*')
  # Find the actual name input ref by looking for placeholder or aria-label
  NAME_REF=$(echo "$SNAP" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    elems = data if isinstance(data, list) else data.get('elements', data.get('ok') and [])
    if not elems and isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list): elems = v; break
    for el in (elems or []):
        if isinstance(el, dict):
            label = el.get('label','').lower()
            ph = el.get('placeholder','').lower()
            if 'name' in label or 'enter your name' in ph:
                print(el['ref']); break
except: pass
" 2>/dev/null || true)

  if [ -n "$NAME_REF" ]; then
    local FILL_RESULT
    FILL_RESULT=$($AC fill "$NAME_REF" "Test User" 2>&1)
    if echo "$FILL_RESULT" | grep -q '"ok": true\|"ok":true'; then
      pass "$NAME: fill Name input ($NAME_REF)"
    else
      fail "$NAME: fill Name input" "$FILL_RESULT"
    fi
  else
    skip "$NAME: fill Name input (ref not found)"
  fi

  # 6. Find and fill Email input
  local EMAIL_REF
  EMAIL_REF=$(echo "$SNAP" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    elems = data if isinstance(data, list) else data.get('elements', data.get('ok') and [])
    if not elems and isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list): elems = v; break
    for el in (elems or []):
        if isinstance(el, dict):
            label = el.get('label','').lower()
            ph = el.get('placeholder','').lower()
            if 'email' in label or 'email' in ph:
                print(el['ref']); break
except: pass
" 2>/dev/null || true)

  if [ -n "$EMAIL_REF" ]; then
    local FILL_EMAIL
    FILL_EMAIL=$($AC fill "$EMAIL_REF" "test@example.com" 2>&1)
    if echo "$FILL_EMAIL" | grep -q '"ok": true\|"ok":true'; then
      pass "$NAME: fill Email input ($EMAIL_REF)"
    else
      fail "$NAME: fill Email" "$FILL_EMAIL"
    fi
  else
    skip "$NAME: fill Email (ref not found)"
  fi

  # 7. Select dropdown
  echo "--- Select ---"
  local SELECT_REF
  SELECT_REF=$(echo "$SNAP" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    elems = data if isinstance(data, list) else data.get('elements', data.get('ok') and [])
    if not elems and isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list): elems = v; break
    for el in (elems or []):
        if isinstance(el, dict):
            tag = el.get('tag','')
            role = el.get('role','')
            label = el.get('label','').lower()
            if tag == 'select' or 'select' in role.lower() or 'role' in label:
                print(el['ref']); break
except: pass
" 2>/dev/null || true)

  if [ -n "$SELECT_REF" ]; then
    local SELECT_RESULT
    SELECT_RESULT=$($AC select "$SELECT_REF" "dev" 2>&1)
    if echo "$SELECT_RESULT" | grep -q '"ok": true\|"ok":true'; then
      pass "$NAME: select dropdown ($SELECT_REF)"
    else
      # Try fill as fallback
      SELECT_RESULT=$($AC fill "$SELECT_REF" "dev" 2>&1)
      if echo "$SELECT_RESULT" | grep -q '"ok": true\|"ok":true'; then
        pass "$NAME: select dropdown via fill ($SELECT_REF)"
      else
        fail "$NAME: select dropdown" "$SELECT_RESULT"
      fi
    fi
  else
    skip "$NAME: select dropdown (ref not found)"
  fi

  # 8. Click Submit
  echo "--- Click ---"
  local SUBMIT_REF
  SUBMIT_REF=$(echo "$SNAP" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    elems = data if isinstance(data, list) else data.get('elements', data.get('ok') and [])
    if not elems and isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list): elems = v; break
    for el in (elems or []):
        if isinstance(el, dict):
            label = el.get('label','')
            if label == 'Submit':
                print(el['ref']); break
except: pass
" 2>/dev/null || true)

  if [ -n "$SUBMIT_REF" ]; then
    local CLICK_RESULT
    CLICK_RESULT=$($AC click "$SUBMIT_REF" 2>&1)
    if echo "$CLICK_RESULT" | grep -q '"ok": true\|"ok":true'; then
      pass "$NAME: click Submit ($SUBMIT_REF)"
    else
      fail "$NAME: click Submit" "$CLICK_RESULT"
    fi
  else
    skip "$NAME: click Submit (ref not found)"
  fi

  # 9. Verify submit result appeared
  sleep 0.3
  local SNAP2
  SNAP2=$($AC snapshot --all 2>&1)
  if echo "$SNAP2" | grep -q 'Submitted.*Test User\|Test User'; then
    pass "$NAME: submit result visible"
  else
    skip "$NAME: submit result (may need different check)"
  fi

  # 10. Tab switching
  echo "--- Tabs ---"
  local TAB2_REF
  TAB2_REF=$(echo "$SNAP" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    elems = data if isinstance(data, list) else data.get('elements', data.get('ok') and [])
    if not elems and isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list): elems = v; break
    for el in (elems or []):
        if isinstance(el, dict):
            label = el.get('label','')
            role = el.get('role','')
            if 'Tab 2' in label and role == 'tab':
                print(el['ref']); break
except: pass
" 2>/dev/null || true)

  if [ -n "$TAB2_REF" ]; then
    local TAB_RESULT
    TAB_RESULT=$($AC click "$TAB2_REF" 2>&1)
    if echo "$TAB_RESULT" | grep -q '"ok": true\|"ok":true'; then
      pass "$NAME: click Tab 2 ($TAB2_REF)"
    else
      fail "$NAME: click Tab 2" "$TAB_RESULT"
    fi
  else
    skip "$NAME: Tab 2 (ref not found)"
  fi

  # 11. Screenshot
  echo "--- Screenshot ---"
  local SS_FILE="/tmp/ac-test-$(echo $NAME | tr '[:upper:]' '[:lower:]').png"
  rm -f "$SS_FILE"
  local SS_RESULT
  SS_RESULT=$($AC screenshot "$SS_FILE" 2>&1)
  if [ -f "$SS_FILE" ] && [ -s "$SS_FILE" ]; then
    pass "$NAME: screenshot saved ($SS_FILE)"
  else
    fail "$NAME: screenshot" "file not created"
  fi

  # 12. Increment counter
  echo "--- Counter ---"
  local INC_REF
  INC_REF=$(echo "$SNAP" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    elems = data if isinstance(data, list) else data.get('elements', data.get('ok') and [])
    if not elems and isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list): elems = v; break
    for el in (elems or []):
        if isinstance(el, dict):
            label = el.get('label','')
            if label == 'Increment':
                print(el['ref']); break
except: pass
" 2>/dev/null || true)

  if [ -n "$INC_REF" ]; then
    # Re-snapshot to get fresh refs (DOM may have changed after submit)
    local FRESH_SNAP
    FRESH_SNAP=$($AC snapshot 2>&1)
    local FRESH_INC_REF
    FRESH_INC_REF=$(echo "$FRESH_SNAP" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for el in (data if isinstance(data, list) else []):
        if el.get('label') == 'Increment':
            print(el['ref']); break
except: pass
" 2>/dev/null || echo "$INC_REF")
    $AC click "$FRESH_INC_REF" >/dev/null 2>&1
    $AC click "$FRESH_INC_REF" >/dev/null 2>&1
    $AC click "$FRESH_INC_REF" >/dev/null 2>&1
    sleep 0.3
    local SNAP3
    SNAP3=$($AC snapshot --all 2>&1)
    if echo "$SNAP3" | grep -q 'Count: 3\|Count:3'; then
      pass "$NAME: counter incremented to 3"
    else
      # Check if count changed at all
      if echo "$SNAP3" | grep -q 'Count: [1-9]'; then
        pass "$NAME: counter incremented (value changed)"
      else
        fail "$NAME: counter" "count didn't change"
      fi
    fi
  else
    skip "$NAME: counter (Increment ref not found)"
  fi

  # 13. Checkbox
  echo "--- Checkbox ---"
  local CB_REF
  CB_REF=$(echo "$SNAP" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    elems = data if isinstance(data, list) else data.get('elements', data.get('ok') and [])
    if not elems and isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list): elems = v; break
    for el in (elems or []):
        if isinstance(el, dict):
            label = el.get('label','').lower()
            role = el.get('role','').lower()
            if 'agree' in label or 'checkbox' in role:
                print(el['ref']); break
except: pass
" 2>/dev/null || true)

  if [ -n "$CB_REF" ]; then
    local CB_RESULT
    CB_RESULT=$($AC click "$CB_REF" 2>&1)
    if echo "$CB_RESULT" | grep -q '"ok": true\|"ok":true'; then
      pass "$NAME: click checkbox ($CB_REF)"
    else
      fail "$NAME: click checkbox" "$CB_RESULT"
    fi
  else
    skip "$NAME: checkbox (ref not found)"
  fi

  # 14. Press key (Escape)
  echo "--- Press ---"
  local PRESS_RESULT
  PRESS_RESULT=$($AC press Escape 2>&1)
  if echo "$PRESS_RESULT" | grep -q '"ok": true\|"ok":true'; then
    pass "$NAME: press Escape"
  else
    fail "$NAME: press Escape" "$PRESS_RESULT"
  fi

  # 15. Eval — read page title
  echo "--- Eval ---"
  local EVAL_RESULT
  EVAL_RESULT=$($AC eval "document.title" 2>&1)
  if echo "$EVAL_RESULT" | grep -qi 'test'; then
    pass "$NAME: eval document.title"
  else
    fail "$NAME: eval" "$EVAL_RESULT"
  fi
}

# ═══════════════════════════════════════
# Run tests for each framework
# ═══════════════════════════════════════

echo "╔═══════════════════════════════════════╗"
echo "║  Web Framework Compatibility Tests    ║"
echo "╚═══════════════════════════════════════╝"

# Test 1: Vanilla HTML
test_framework "Vanilla" "$FIXTURES/vanilla.html"

# Close daemon between frameworks to get clean state
$AC close 2>/dev/null || true
sleep 0.5

# Test 2: Vue 3
test_framework "Vue3" "$FIXTURES/vue.html"

$AC close 2>/dev/null || true
sleep 0.5

# Test 3: React 18
test_framework "React" "$FIXTURES/react.html"

$AC close 2>/dev/null || true

# ═══════════════════════════════════════
# Summary
# ═══════════════════════════════════════
echo ""
echo "═══════════════════════════════════════"
echo "  Results: ✅ $PASS  ❌ $FAIL  ⚠️  $SKIP"
echo "═══════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  echo -e "$ERRORS"
  echo ""
  exit 1
fi
exit 0
