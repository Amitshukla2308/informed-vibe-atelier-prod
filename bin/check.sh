#!/usr/bin/env bash
# bin/check.sh — Atelier fail-closed verification gate.
# Exit 0 = all sections green. Exit non-zero = broken; do not mark a card "done".
# Sections mirror STEWARDSHIP.md §5 (verify-before-done).
#
# Usage:
#   ./bin/check.sh                   — run all sections (§5 requires docker + credentials)
#   ./bin/check.sh --skip-smoke      — skip §5 Docker smoke (maintainer-box acceptable)
#   ./bin/check.sh --rebuild-smoke-image — force rebuild of the cached smoke Docker image
#
# §1  typecheck            tsc --noEmit across backend + frontend
# §2  boot validation      validate.ts checks ttyd / CLI / dirs / config (fail-closed)
# §3  ttyd preflight       ttyd binary responds to --version
# §4  secret/PII scan      no secrets or personal data in tracked files
# §5  PTY smoke            Docker clean-container: apt-ttyd + fresh Bun, claude runs in
#                          a PTY → raw.log > 0. Kills the maintainer-box false-positive
#                          where linuxbrew ttyd + host PATH masked the cold-clone state.

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
  fail "ttyd not found. Install: 'sudo apt install ttyd' (Linux) or 'brew install ttyd' (Mac)"
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
# Debian container (no linuxbrew, fresh Bun, apt ttyd, fresh claude install) and
# verifies the core assertion: the CLI runs in a PTY and produces output
# (raw.log > 0). The 0-byte raw.log was the canonical false-done signal in the
# SIGHUP-on-node-pty era; this gate ensures we never regress silently.
echo "§5 PTY smoke"
if [[ "$SKIP_SMOKE" -eq 1 ]]; then
  echo "  (skipped via --skip-smoke)"
else
  # ── Pre-flight: docker + credentials ────────────────────────────────────────
  if ! command -v docker &>/dev/null; then
    fail "§5 requires docker (install docker, or pass --skip-smoke to skip)"
  fi
  CREDS_FILE="${CLAUDE_CREDENTIALS_FILE:-$HOME/.claude/.credentials.json}"
  if [[ ! -f "$CREDS_FILE" ]]; then
    fail "§5 requires claude credentials at $CREDS_FILE (set CLAUDE_CREDENTIALS_FILE, or pass --skip-smoke)"
  fi

  SMOKE_IMAGE="atelier-check-smoke:v1"
  TMP_CTX=$(mktemp -d)
  trap 'rm -rf "$TMP_CTX"' EXIT

  # ── Build the clean smoke image (cached by tag; rebuild with --rebuild-smoke-image) ──
  if [[ "$REBUILD_SMOKE" -eq 1 ]] || ! docker image inspect "$SMOKE_IMAGE" &>/dev/null; then
    echo "  building clean smoke image (debian:bookworm-slim + apt ttyd + bun + claude)..."
    echo "  (first build ~3–5 min due to apt + npm downloads; subsequent runs use the cache)"
    # Copy backend package files for dep pre-caching in the image layer.
    cp "$REPO/backend/package.json" "$TMP_CTX/package.json"
    cp "$REPO/backend/bun.lock"     "$TMP_CTX/bun.lock"
    cat > "$TMP_CTX/Dockerfile" << 'DOCKERFILE'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ttyd curl ca-certificates nodejs npm \
    && rm -rf /var/lib/apt/lists/*
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

# ① Confirm apt ttyd is on PATH (not linuxbrew)
echo "  smoke/ttyd"
TTYD_PATH=$(which ttyd 2>/dev/null || echo "")
if [[ -z "$TTYD_PATH" ]]; then
  echo "✗ ttyd not found in container PATH" >&2; exit 10
fi
if [[ "$TTYD_PATH" == *"linuxbrew"* || "$TTYD_PATH" == *".homebrew"* ]]; then
  echo "✗ ttyd resolved to linuxbrew path in container: $TTYD_PATH" >&2; exit 10
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

# ④ Boot validation in the clean container env
echo "  smoke/validate"
cd /work/backend
if ! bun run src/boot/validate.ts 2>&1; then
  echo "✗ validate.ts failed in clean container" >&2; exit 11
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
      -v "$CREDS_FILE:/root/.claude/.credentials.json:ro" \
      -v "$TMP_CTX/smoke-inner.sh:/smoke-inner.sh:ro" \
      "$SMOKE_IMAGE" \
      bash /smoke-inner.sh; then
    pass "Docker clean-container PTY smoke: raw.log > 0 bytes in apt-ttyd + fresh-Bun env"
  else
    fail "Docker clean-container PTY smoke failed (see output above)"
  fi
fi

echo ""
echo "✓ check.sh green"
