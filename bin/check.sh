#!/usr/bin/env bash
# bin/check.sh — Atelier fail-closed verification gate.
# Exit 0 = all sections green. Exit non-zero = broken; do not mark a card "done".
# Sections mirror STEWARDSHIP.md §5 (verify-before-done).
#
# Usage:
#   ./bin/check.sh                   — run all sections (§5 requires docker; no credentials needed)
#   ./bin/check.sh --skip-smoke      — skip §5 Docker smoke (maintainer-box acceptable)
#   ./bin/check.sh --rebuild-smoke-image — force rebuild of the cached smoke Docker image
#
# §1  typecheck            tsc --noEmit across backend + frontend
# §2  boot validation      validate.ts checks ttyd / CLI / dirs / config (fail-closed)
# §3  ttyd preflight       ttyd binary responds to --version
# §4  secret/PII scan      no secrets or personal data in tracked files
# §5  PTY smoke            Docker clean-container (NO creds): static-ttyd + fresh Bun,
#                          claude --version in PTY → raw.log > 0; validate.ts exits
#                          non-zero with "claude login" guidance. True unauthenticated
#                          cold-clone proof — no host credentials injected.

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKIP_SMOKE=0
REBUILD_SMOKE=0
for arg in "$@"; do
  [[ "$arg" == "--skip-smoke"          ]] && SKIP_SMOKE=1
  [[ "$arg" == "--rebuild-smoke-image" ]] && REBUILD_SMOKE=1
done

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; exit 1; }

# ── TTYD_BIN auto-detect ──────────────────────────────────────────────────────
# Resolve once and export so validate.ts (§2) and §3 both see the same binary.
# Needed on machines where ttyd lives outside standard PATH (e.g., linuxbrew on
# WSL2 where ~/.bashrc isn't sourced when the script runs non-interactively).
if [[ -z "${TTYD_BIN:-}" ]]; then
  if command -v ttyd &>/dev/null; then
    TTYD_BIN="ttyd"
  else
    for _loc in \
        /home/linuxbrew/.linuxbrew/bin/ttyd \
        /opt/homebrew/bin/ttyd \
        "$HOME/.linuxbrew/bin/ttyd" \
        /usr/local/bin/ttyd; do
      if [[ -x "$_loc" ]]; then TTYD_BIN="$_loc"; break; fi
    done
    TTYD_BIN="${TTYD_BIN:-ttyd}"  # fall back; §2/§3 will fail with a clear message
  fi
fi
export TTYD_BIN

# ── §1 Typecheck ──────────────────────────────────────────────────────────────
echo "§1 typecheck"
cd "$REPO"
if ! bun run typecheck 2>&1 | tail -10; then
  fail "typecheck failed — run 'bun run typecheck' for full output"
fi
pass "typecheck"

# ── §2 Boot validation ────────────────────────────────────────────────────────
echo "§2 boot validation"
cd "$REPO/backend"
if ! bun run src/boot/validate.ts; then
  fail "boot validation failed — fix the issues listed above, then re-run"
fi
cd "$REPO"
pass "boot validation"

# ── §3 ttyd preflight ─────────────────────────────────────────────────────────
echo "§3 ttyd preflight"
TTYD_BIN="${TTYD_BIN:-ttyd}"
if "$TTYD_BIN" --version &>/dev/null; then
  pass "ttyd found: $("$TTYD_BIN" --version 2>&1 | head -1)"
else
  fail "ttyd not found. Install via static binary (Linux): curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd  |  Mac: brew install ttyd"
fi

# ── §4 Secret / PII scan ──────────────────────────────────────────────────────
echo "§4 secret / PII scan"
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

# ── §5 PTY smoke — Docker clean-container gate ────────────────────────────────
# Rationale: the maintainer's box has linuxbrew ttyd 1.7.7, global claude, and
# live credentials — so running check.sh locally is structurally biased to pass
# even when a cold clone would fail for a stranger. This section spawns a clean
# Debian container (no linuxbrew, fresh Bun, static-binary ttyd, fresh claude
# install) and verifies the cold-clone guarantee:
#   (a) static ttyd --version works at /usr/local/bin/ttyd (not linuxbrew)
#   (b) PTY run produces raw.log > 0 bytes (no-silent-CLI proof)
#   (c) validate.ts fails loudly with "run: claude login" in an unauth'd env
#       (clean fail-with-guidance is the correct behaviour; silent exit is not)
# NOTE: ttyd is NOT in Debian bookworm-slim's apt repos — we install via the
# upstream static binary (x86_64) which works on any glibc Linux, no apt needed.
echo "§5 PTY smoke"
if [[ "$SKIP_SMOKE" -eq 1 ]]; then
  echo "  (skipped via --skip-smoke)"
else
  # ── Pre-flight: docker only (no credentials needed — §5 tests the unauth path) ──
  if ! command -v docker &>/dev/null; then
    fail "§5 requires docker (install docker, or pass --skip-smoke to skip)"
  fi

  SMOKE_IMAGE="atelier-check-smoke:v5"
  TMP_CTX=$(mktemp -d)
  trap 'rm -rf "$TMP_CTX"' EXIT

  # ── Build the clean smoke image (cached by tag; rebuild with --rebuild-smoke-image) ──
  if [[ "$REBUILD_SMOKE" -eq 1 ]] || ! docker image inspect "$SMOKE_IMAGE" &>/dev/null; then
    echo "  building clean smoke image (debian:bookworm-slim + static-binary ttyd + bun + claude)..."
    echo "  (first build ~3–5 min due to npm downloads; subsequent runs use the cache)"
    # Copy backend package files for dep pre-caching in the image layer.
    cp "$REPO/backend/package.json" "$TMP_CTX/package.json"
    cp "$REPO/backend/bun.lock"     "$TMP_CTX/bun.lock"
    cat > "$TMP_CTX/Dockerfile" << 'DOCKERFILE'
FROM debian:bookworm-slim
# curl + ca-certificates + unzip: Bun installer.
# nodejs/npm: Claude CLI global install.
# bsdutils: provides 'script' for PTY smoke.
# ttyd is NOT in Debian bookworm-slim apt repos; install the upstream static binary.
# Note: build-essential + python3 (node-gyp) were only needed for node-pty, which is
# no longer a dependency — the terminal is ttyd-direct via node:child_process.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates unzip nodejs npm bsdutils \
    && rm -rf /var/lib/apt/lists/*
# Install ttyd 1.7.7 static binary (works on any glibc x86_64 Linux, no apt needed)
RUN curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
      -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && ttyd --version
# Install Bun (fresh install, no linuxbrew)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"
# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code
# Pre-cache backend node_modules so the inner test skips bun install
WORKDIR /pkg
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
DOCKERFILE
    docker build -q -t "$SMOKE_IMAGE" "$TMP_CTX" \
      || fail "docker build failed — check docker daemon and network, then retry"
    echo "  image built and cached as $SMOKE_IMAGE"
  else
    echo "  using cached smoke image ($SMOKE_IMAGE)"
  fi

  # ── Inner test script ────────────────────────────────────────────────────────
  # Written to a file so it's mountable and doesn't require shell-quoting heroics.
  cat > "$TMP_CTX/smoke-inner.sh" << 'SMOKE_INNER'
#!/usr/bin/env bash
set -euo pipefail

# ① Confirm static ttyd is at /usr/local/bin/ttyd (not linuxbrew)
echo "  smoke/ttyd"
TTYD_PATH=$(which ttyd 2>/dev/null || echo "")
if [[ -z "$TTYD_PATH" ]]; then
  echo "✗ ttyd not found in container PATH" >&2; exit 10
fi
if [[ "$TTYD_PATH" == *"linuxbrew"* || "$TTYD_PATH" == *".homebrew"* ]]; then
  echo "✗ ttyd resolved to linuxbrew path in container: $TTYD_PATH" >&2; exit 10
fi
if [[ "$TTYD_PATH" != "/usr/local/bin/ttyd" ]]; then
  echo "✗ expected static ttyd at /usr/local/bin/ttyd, got: $TTYD_PATH" >&2; exit 10
fi
TTYD_VER=$(ttyd --version 2>&1 | head -1)
echo "    ttyd: $TTYD_VER (path: $TTYD_PATH)"

# ② Copy repo to writable location (skip node_modules — image provides them)
echo "  smoke/setup"
mkdir -p /work
tar --exclude='./backend/node_modules' \
    --exclude='./.git' \
    --exclude='./node-compile-cache' \
    --exclude='./data' \
    -C /atelier -cf - . | tar -xf - -C /work/
# Use pre-cached backend deps from the image layer (installed at build time)
rm -rf /work/backend/node_modules
ln -sf /pkg/node_modules /work/backend/node_modules
# Create gitignored data dirs that validate.ts requires
mkdir -p /work/data/sessions /work/data/tmp

# ③ Locate claude binary (npm global → /usr/local/bin/claude or npm bin path)
CLAUDE_BIN=$(which claude 2>/dev/null \
  || find /usr/local/bin /usr/bin -maxdepth 1 -name claude -perm -u+x 2>/dev/null | head -1 \
  || echo "")
if [[ -z "$CLAUDE_BIN" || ! -x "$CLAUDE_BIN" ]]; then
  echo "✗ claude binary not found in container (PATH=$PATH)" >&2; exit 20
fi
export CLAUDE_BIN

# ④ Boot validation in the clean container env (unauthenticated — expected to fail).
# In a clean/unauthenticated container there are no credentials, so validate.ts MUST
# exit non-zero with an actionable "run: claude login" message.
# A silent exit (no message) would be the regression; a loud fail-with-guidance is correct.
echo "  smoke/validate (unauthenticated — expect loud fail-with-guidance, NO creds mounted)"
cd /work/backend
VALIDATE_OUT=$(bun run src/boot/validate.ts 2>&1 || true)
echo "$VALIDATE_OUT"
if echo "$VALIDATE_OUT" | grep -q "claude login"; then
  echo "    validate.ts: loud fail-with-guidance confirmed (contains 'claude login')"
elif echo "$VALIDATE_OUT" | grep -q "All boot checks passed"; then
  # No credentials were mounted — if validate.ts reports "all passed" something is
  # wrong (credential auto-discovery bypassed the check). Treat as a regression.
  echo "✗ validate.ts reported all-passed in an unauthenticated container — credentials leaked in?" >&2
  exit 12
else
  echo "✗ validate.ts exited without actionable guidance — silent failure is the regression" >&2
  echo "  Output was: $VALIDATE_OUT" >&2
  echo "  Expected: output containing 'claude login' (run: claude login)" >&2
  exit 11
fi

# ⑤ PTY smoke: run claude in a pty via 'script', assert raw.log > 0
# 'script' allocates a pty via openpty() even when stdin is not a terminal.
# A CLI that SIGHUPs or crashes in <11 ms produces 0 bytes here — the
# canonical false-done detector from the node-pty era.
echo "  smoke/pty"
RAW_LOG="/tmp/smoke_raw.log"
rm -f "$RAW_LOG"
timeout 15 script -q -c "$CLAUDE_BIN --version 2>&1" "$RAW_LOG" || true
if [[ -s "$RAW_LOG" ]]; then
  BYTES=$(wc -c < "$RAW_LOG")
  PREVIEW=$(head -c 120 "$RAW_LOG" | tr -dc '[:print:][:space:]' | head -c 80)
  echo "    raw.log: ${BYTES} bytes"
  echo "    preview: $PREVIEW"
  echo "✓ PTY smoke passed"
  exit 0
else
  echo "✗ PTY smoke: raw.log empty — claude produced no output in clean container pty" >&2
  echo "  CLAUDE_BIN=$CLAUDE_BIN" >&2
  echo "  PATH=$PATH" >&2
  exit 30
fi
SMOKE_INNER
  chmod +x "$TMP_CTX/smoke-inner.sh"

  # ── Run smoke in the clean container ──────────────────────────────────────
  echo "  running Docker clean-container smoke..."
  if docker run --rm \
      -v "$REPO:/atelier:ro" \
      -v "$TMP_CTX/smoke-inner.sh:/smoke-inner.sh:ro" \
      "$SMOKE_IMAGE" \
      bash /smoke-inner.sh; then
    pass "Docker clean-container PTY smoke (NO creds mounted): static-ttyd at /usr/local/bin/ttyd + raw.log > 0 bytes + validate.ts loud-fail-with-guidance confirmed"
  else
    fail "Docker clean-container PTY smoke failed (see output above)"
  fi
fi

echo ""
echo "✓ check.sh green"
