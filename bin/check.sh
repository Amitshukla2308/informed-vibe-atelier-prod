#!/usr/bin/env bash
# bin/check.sh — Atelier fail-closed verification gate.
# Exit 0 = all sections green. Exit non-zero = something is broken; do not mark a card "done".
# Sections mirror STEWARDSHIP.md §5 (verify-before-done).
#
# Usage: ./bin/check.sh [--skip-smoke]

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKIP_SMOKE=0
for arg in "$@"; do [[ "$arg" == "--skip-smoke" ]] && SKIP_SMOKE=1; done

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; exit 1; }

# ── §1 Typecheck ──────────────────────────────────────────────────────────────
echo "§1 typecheck"
cd "$REPO"
bun run typecheck 2>&1 | tail -5
pass "typecheck"

# ── §2 Boot validation ────────────────────────────────────────────────────────
echo "§2 boot validation"
# TODO: bun run backend/src/boot/validate.ts and assert exit 0
# Stub: run validate directly when the backend's bun entry is available.
echo "  (stub — boot validation not yet wired; complete in P1)"

# ── §3 ttyd preflight ─────────────────────────────────────────────────────────
echo "§3 ttyd preflight"
TTYD_BIN="${TTYD_BIN:-ttyd}"
if "$TTYD_BIN" --version &>/dev/null; then
  pass "ttyd found: $("$TTYD_BIN" --version 2>&1 | head -1)"
else
  fail "ttyd not found. Install: 'sudo apt install ttyd' (Linux) or 'brew install ttyd' (Mac)"
fi

# ── §4 Secret / PII scan ──────────────────────────────────────────────────────
echo "§4 secret / PII scan"
# Patterns that must never appear in tracked files.
BAD_PATTERNS=(
  'sk-ant-'
  'ghp_'
  'AKIA'
  '-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY'
  '/home/beast'
  '/mnt/d/'
  'juspay'
  'barclays'
  'amitshukla2308@'
)
FOUND=0
for pat in "${BAD_PATTERNS[@]}"; do
  if git -C "$REPO" grep -rIl -E "$pat" -- ':!*.sh' 2>/dev/null | grep -q .; then
    echo "  ✗ secret/PII pattern found: $pat" >&2
    FOUND=1
  fi
done
[[ "$FOUND" -eq 0 ]] || exit 1
pass "no secrets or PII in tracked files"

# ── §5 PTY smoke (cold-env only) ──────────────────────────────────────────────
echo "§5 PTY smoke"
if [[ "$SKIP_SMOKE" -eq 1 ]]; then
  echo "  (skipped via --skip-smoke)"
else
  # TODO: run a Docker clean-container smoke test that asserts raw.log > 0.
  # Gate: verified only when NO linuxbrew ttyd / global claude / host auth on PATH.
  # On the maintainer's box this is structurally biased to pass — use a container.
  echo "  (stub — Docker clean-env smoke not yet wired; complete in P1 bin/check.sh task)"
fi

echo ""
echo "✓ check.sh green (stubs noted above are P1 work)"
