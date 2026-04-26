#!/bin/bash
# agent-control full test suite
# Run all platform tests that are available
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
TOTAL_PASS=0
TOTAL_FAIL=0
PLATFORMS_RUN=0
PLATFORMS_SKIP=0

echo "╔══════════════════════════════════════╗"
echo "║  agent-control full test suite       ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Web ──
echo "━━━ Web Platform ━━━"
if bash "$DIR/test-web.sh"; then
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
else
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
  TOTAL_FAIL=$((TOTAL_FAIL+1))
fi
echo ""

# ── macOS ──
echo "━━━ macOS Platform ━━━"
if bash "$DIR/test-macos.sh"; then
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
else
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
  TOTAL_FAIL=$((TOTAL_FAIL+1))
fi
echo ""

# ── iOS ──
echo "━━━ iOS Platform ━━━"
BOOTED=$(xcrun simctl list devices booted 2>/dev/null | grep -c "Booted" || true)
if [ "$BOOTED" -gt 0 ]; then
  if bash "$DIR/test-ios.sh"; then
    PLATFORMS_RUN=$((PLATFORMS_RUN+1))
  else
    PLATFORMS_RUN=$((PLATFORMS_RUN+1))
    TOTAL_FAIL=$((TOTAL_FAIL+1))
  fi
else
  echo "  ⏭️  Skipped (no booted Simulator)"
  PLATFORMS_SKIP=$((PLATFORMS_SKIP+1))
fi
echo ""

# ── Electron ──
echo "━━━ Electron Platform ━━━"
if bash "$DIR/test-electron.sh"; then
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
else
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
  TOTAL_FAIL=$((TOTAL_FAIL+1))
fi
echo ""

# ── Args Variants ──
echo "━━━ Args Variants (Electron) ━━━"
if bash "$DIR/test-args.sh"; then
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
else
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
  TOTAL_FAIL=$((TOTAL_FAIL+1))
fi
echo ""

# ── Android ──
echo "━━━ Android Platform ━━━"
if bash "$DIR/test-android.sh"; then
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
else
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
  TOTAL_FAIL=$((TOTAL_FAIL+1))
fi
echo ""

# ── Flutter ──
echo "━━━ Flutter Platform ━━━"
if bash "$DIR/test-flutter.sh"; then
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
else
  PLATFORMS_RUN=$((PLATFORMS_RUN+1))
  TOTAL_FAIL=$((TOTAL_FAIL+1))
fi
echo ""

# ── Summary ──
echo "╔══════════════════════════════════════╗"
echo "║  Final Summary                       ║"
echo "╠══════════════════════════════════════╣"
echo "║  Platforms tested: $PLATFORMS_RUN"
echo "║  Platforms skipped: $PLATFORMS_SKIP"
echo "║  Platform failures: $TOTAL_FAIL"
echo "╚══════════════════════════════════════╝"

if [ $TOTAL_FAIL -gt 0 ]; then
  exit 1
fi
