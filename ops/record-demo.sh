#!/usr/bin/env bash
# record-demo.sh — capture the decompose→approve→build loop and emit docs/demo/demo-loop.gif
# Usage: ./ops/record-demo.sh
# Prereqs: ffmpeg, DISPLAY set (WSLg or VcXsrv), app running on :5174

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_MP4="$REPO_ROOT/docs/demo/demo-loop-raw.mp4"
OUT_GIF="$REPO_ROOT/docs/demo/demo-loop.gif"
CAPTURE_SECONDS=60   # max; press q in ffmpeg window to stop early
GEOMETRY="1280x800"  # browser window size — match exactly for crisp capture
X_OFFSET=0
Y_OFFSET=0

# --- preflight ---

if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg not found. Install it: sudo apt install ffmpeg" >&2
  exit 1
fi

if [[ -z "${DISPLAY:-}" ]]; then
  echo "ERROR: DISPLAY is not set. On WSL2, start VcXsrv or ensure WSLg is running." >&2
  echo "  VcXsrv: launch XLaunch on Windows, then: export DISPLAY=:0" >&2
  exit 1
fi

if ! curl -sf http://localhost:5174 >/dev/null 2>&1; then
  echo "WARNING: http://localhost:5174 not responding. Did you run 'npm run dev'?" >&2
  echo "  Start the app first, then re-run this script." >&2
  echo "  Proceeding anyway in case the app takes a moment..." >&2
fi

echo ""
echo "=== Atelier Demo Recorder ==="
echo ""
echo "Storyboard: ops/demo-storyboard.md"
echo "Output:     $OUT_GIF"
echo ""
echo "Before pressing Enter:"
echo "  1. Open http://localhost:5174 in Chrome/Firefox"
echo "  2. Resize the browser window to ${GEOMETRY}"
echo "  3. Navigate to the Now view — confirm agent prompt is visible"
echo "  4. Position the window at the top-left of your screen (x=${X_OFFSET}, y=${Y_OFFSET})"
echo ""
read -rp "Ready? Press Enter to start recording (press q in the ffmpeg window to stop early)..."
echo ""
echo "Recording starts in 3..."
sleep 1
echo "2..."
sleep 1
echo "1..."
sleep 1
echo "GO — follow ops/demo-storyboard.md"
echo ""

# Capture X11 desktop area
ffmpeg -y \
  -f x11grab \
  -video_size "$GEOMETRY" \
  -framerate 24 \
  -i "${DISPLAY}+${X_OFFSET},${Y_OFFSET}" \
  -t "$CAPTURE_SECONDS" \
  -vcodec libx264 \
  -preset ultrafast \
  -crf 18 \
  "$OUT_MP4"

echo ""
echo "Recording saved: $OUT_MP4"
echo "Converting to GIF (this takes ~30s)..."

# Two-pass GIF: palette → render — gives much smaller, sharper gif than naive convert
PALETTE="/tmp/atelier-demo-palette.png"

ffmpeg -y \
  -i "$OUT_MP4" \
  -vf "fps=15,scale=900:-1:flags=lanczos,palettegen=stats_mode=diff" \
  "$PALETTE"

ffmpeg -y \
  -i "$OUT_MP4" \
  -i "$PALETTE" \
  -filter_complex "fps=15,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5" \
  "$OUT_GIF"

GIF_SIZE=$(du -sh "$OUT_GIF" | cut -f1)
echo ""
echo "=== Done ==="
echo "GIF:  $OUT_GIF  ($GIF_SIZE)"
echo "MP4:  $OUT_MP4"
echo ""
echo "If the GIF is >4MB, trim the recording or reduce fps above and re-run."
echo "Commit: git add docs/demo/demo-loop.gif && git commit -m 'docs(demo): decompose→approve→build loop gif'"
