/**
 * Frozen seam — bug-fix only. No new features here.
 *
 * The Warp-UX successor lives in a separate Rust sidecar (see docs/ARCHITECTURE.md).
 */

/**
 * Terminal v2 — ttyd-direct per-session terminal server.
 *
 * One ttyd subprocess per Atelier session. ttyd spawns the provider CLI
 * directly as its PTY child (no tmux hop). Founder's browser embeds ttyd's
 * served page; xterm.js handles wheel scrollback natively.
 *
 * Why direct (vs ttyd-via-tmux):
 *   - tmux added a layer that intercepted wheel events and fought xterm.js
 *     for control. After three rounds of tmux configuration none of which
 *     produced clean desktop scroll, the simpler answer is to skip tmux.
 *   - xterm.js's default scrollback (with the inner CLI not in alt-screen
 *     mouse mode, or with mouse mode honored cleanly) gives the founder
 *     standard wheel-scrolls-history behavior.
 *   - Trade-off lost: pipe-pane raw.log + tmux session persistence across
 *     browser-tab-close. Acceptable for Phase A; reflection can switch to
 *     reading the CLI's native session storage.
 *
 * Status: behind a per-session toggle (Settings → Terminal Engine: Legacy | v2).
 */

import { spawn, spawnSync } from "node:child_process";
import { userSpawnEnv } from "~/auth/user-home";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface ActiveSession {
  sessionId: string;
  ttydPort: number;             // ttyd's bound port
  ttydPid: number;              // ttyd subprocess pid
  cwd: string;
  startedAt: string;
}

const ACTIVE: Map<string, ActiveSession> = new Map();

const TTYD_BIN = process.env.TTYD_BIN ?? "ttyd";

export interface TerminalV2StartInput {
  sessionId: string;
  cwd: string;
  /** Provider command to run inside tmux. Comes from the chosen CliAdapter's
   *  getInteractiveCommand(). Atelier composes this once; tmux runs it. */
  bin: string;
  args: string[];
  env: Record<string, string>;
  /** Optional pre-spawn writes — same contract as CliAdapter (e.g.
   *  .qwen/settings.json or .gemini/settings.json that the CLI auto-loads). */
  preSpawnWrites?: Array<{ path: string; contents: string }>;
  /** raw.log destination for the reflection pipeline. */
  rawLogPath: string;
  /** Authed user id — when present and non-"default", the spawn env points
   *  HOME at data/users/<userId> so the CLI's ~/.claude/{config,projects,memory}
   *  lands inside that user's slot rather than spilling into the host home. */
  userId?: string | null;
}

export interface TerminalV2StartResult {
  ok: true;
  sessionId: string;
  port: number;
  url: string;          // http://127.0.0.1:<port>/  (host-only — same machine)
  wsUrl: string;        // ws://127.0.0.1:<port>/ws  (host-only)
  // Relative path served through the Atelier backend proxy. Works from any
  // device that can reach Atelier (LAN, tunnel, phone). The frontend prefers
  // this over `url`; the absolute fields are kept for diagnostics.
  proxyUrl: string;     // /terminal-v2/proxy/<sessionId>/
}

export interface TerminalV2StartFailure {
  ok: false;
  reason: string;
}

export function isTerminalV2Available(): { available: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const ttydCheck = spawnSync(TTYD_BIN, ["--version"], { stdio: "pipe" });
  if (ttydCheck.status !== 0) reasons.push(`ttyd binary not found (set TTYD_BIN or brew install ttyd)`);
  return { available: reasons.length === 0, reasons };
}

/**
 * Boot-time orphan sweep. Kills any leftover ttyd processes from a previous
 * backend run that didn't clean up (crash / SIGKILL / reboot). Called from
 * boot/validate.ts so a fresh backend always starts with no zombie ttyds
 * holding ports + memory.
 *
 * Also kills legacy `atelier-*` tmux sessions that may exist from the
 * previous tmux-era of v2 — we no longer use tmux but old sessions might
 * be lingering. Defensive cleanup.
 */
export function sweepTerminalV2Orphans(): { killed_ttyd: number; killed_tmux: number } {
  let killed_ttyd = 0;
  let killed_tmux = 0;

  // ttyd orphans: pgrep -f 'ttyd .*-i 127.0.0.1' — matches the current spawn
  // signature. The previous pattern keyed off `-O` (--check-origin), which
  // we deliberately removed in commit f46d3e3 (reverse-proxy work). With the
  // old pattern, no new ttyd ever matched and zombies accumulated across
  // backend restarts, causing port collisions on the next start.
  const ttydPgrep = spawnSync("pgrep", ["-f", "ttyd .*-i 127.0.0.1"], { encoding: "utf-8" });
  if (ttydPgrep.status === 0 && ttydPgrep.stdout) {
    for (const pid of ttydPgrep.stdout.trim().split(/\s+/).filter(Boolean)) {
      try { process.kill(Number(pid), "SIGTERM"); killed_ttyd++; } catch { /* already gone */ }
    }
  }

  // Legacy tmux atelier-* sessions (from earlier ttyd-via-tmux era).
  const tmuxBin = process.env.TMUX_BIN ?? "tmux";
  const tmuxList = spawnSync(tmuxBin, ["list-sessions"], { encoding: "utf-8" });
  if (tmuxList.status === 0 && tmuxList.stdout) {
    for (const line of tmuxList.stdout.split("\n")) {
      const m = line.match(/^(atelier-\S+):/);
      if (!m) continue;
      const r = spawnSync(tmuxBin, ["kill-session", "-t", m[1]], { stdio: "pipe" });
      if (r.status === 0) killed_tmux++;
    }
  }

  return { killed_ttyd, killed_tmux };
}

function applyPreSpawnWrites(cwd: string, writes?: Array<{ path: string; contents: string }>): void {
  for (const w of writes ?? []) {
    const abs = resolve(cwd, w.path);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, w.contents);
  }
}

/**
 * Find a free TCP port. We let the OS pick by binding to 0 in a probe
 * subprocess — `ttyd -p 0` auto-binds and prints the port to stderr in
 * its startup banner; we parse that. (Avoids racing two parallel starts
 * on the same auto-port.)
 */
function readPortFromTtydStderr(line: string): number | null {
  // ttyd logs e.g.: "[2026-04-26 21:00:00] Listening on port: 38123"
  const m = line.match(/Listening on port:\s*(\d+)/i) || line.match(/listen on:\s*\d+\.\d+\.\d+\.\d+:(\d+)/i);
  return m ? Number(m[1]) : null;
}

// React 19 StrictMode double-mounts useEffects, and the frontend explicitly
// stop-then-starts the terminal on mount. Without a debounce, that produces
// two ttyd processes per session — one orphaned. Track recently-stopped
// sessions for a brief window and, if a start request comes in for the same
// sessionId within ~500ms of a stop, treat it as a no-op replay (legitimate
// "fresh on mount" semantics still fire after the window). The window also
// guards two parallel start calls landing before ACTIVE is populated (the
// port-binding race).
const RECENT_STOPS: Map<string, number> = new Map();
const RECENT_START_INFLIGHT: Map<string, number> = new Map();
const STRICT_MODE_DEBOUNCE_MS = 500;

export function startTerminalV2(input: TerminalV2StartInput): Promise<TerminalV2StartResult | TerminalV2StartFailure> {
  return new Promise((resolvePromise) => {
    const avail = isTerminalV2Available();
    if (!avail.available) {
      resolvePromise({ ok: false, reason: avail.reasons.join("; ") });
      return;
    }
    if (ACTIVE.has(input.sessionId)) {
      const a = ACTIVE.get(input.sessionId)!;
      resolvePromise({
        ok: true,
        sessionId: input.sessionId,
        port: a.ttydPort,
        url: `http://127.0.0.1:${a.ttydPort}/`,
        wsUrl: `ws://127.0.0.1:${a.ttydPort}/ws`,
        proxyUrl: `/terminal-v2/proxy/${input.sessionId}/`,
      });
      return;
    }
    // StrictMode double-mount guard: if this sessionId was stopped or started
    // within the debounce window, wait briefly and retry — by then ACTIVE will
    // hold the singleton from the first call.
    const now = Date.now();
    const recentStop = RECENT_STOPS.get(input.sessionId);
    const recentStart = RECENT_START_INFLIGHT.get(input.sessionId);
    if ((recentStop && now - recentStop < STRICT_MODE_DEBOUNCE_MS) ||
        (recentStart && now - recentStart < STRICT_MODE_DEBOUNCE_MS)) {
      // Wait out the window, then re-check ACTIVE. If the in-flight start
      // populated it, return that; otherwise fall through to a fresh spawn.
      setTimeout(() => {
        if (ACTIVE.has(input.sessionId)) {
          const a = ACTIVE.get(input.sessionId)!;
          resolvePromise({
            ok: true,
            sessionId: input.sessionId,
            port: a.ttydPort,
            url: `http://127.0.0.1:${a.ttydPort}/`,
            wsUrl: `ws://127.0.0.1:${a.ttydPort}/ws`,
            proxyUrl: `/terminal-v2/proxy/${input.sessionId}/`,
          });
          return;
        }
        // Re-enter via a new promise (the in-flight call failed or timed out).
        startTerminalV2(input).then(resolvePromise);
      }, STRICT_MODE_DEBOUNCE_MS + 50);
      return;
    }
    RECENT_START_INFLIGHT.set(input.sessionId, now);

    const cwd = input.cwd;
    if (!existsSync(cwd)) {
      resolvePromise({ ok: false, reason: `cwd does not exist: ${cwd}` });
      return;
    }
    applyPreSpawnWrites(cwd, input.preSpawnWrites);
    mkdirSync(resolve(input.rawLogPath, ".."), { recursive: true });

    // Spawn ttyd directly with the provider CLI as its PTY child. No tmux
    // hop, no mouse interception layer — xterm.js's native wheel handling
    // owns the scroll experience. TERM=xterm-256color ensures colored UI
    // libraries (Ink/tinygradient inside qwen-code) have a real terminal
    // type to render against rather than crashing on `dumb`.
    //
    // ttyd client options (functional only):
    //   scrollback=20000          — large history buffer
    //   fastScrollModifier=alt    — Alt+wheel for 5-row jumps
    //   rightClickSelectsWord=true
    const ttydArgs: string[] = [
      "-i", "127.0.0.1",
      "-p", "0",
      "-W",                          // writable
      "-m", "1",                     // single client per session
      // -O (--check-origin) is intentionally OMITTED. Atelier's reverse-proxy
      // WS upgrade carries the browser's Origin (http://localhost:5174 or the
      // tunnel host) but ttyd is bound to 127.0.0.1 — origin mismatch caused
      // ttyd to drop the upstream connection and the iframe to render an
      // empty/non-editable terminal. Auth is already enforced one layer up
      // by /terminal-v2/proxy/<sid>/, so ttyd's origin check is redundant.
      "-t", "scrollback=20000",
      "-t", "fastScrollModifier=alt",
      "-t", "rightClickSelectsWord=true",
      "--",
      input.bin, ...input.args,
    ];
    // Build the spawn env carefully: the parent shell may have NO_COLOR=1
    // set (which propagates through atelier-restart.sh → bun → us). NO_COLOR
    // breaks qwen-code's React-Ink theme system (forces a degraded path
    // whose ui.gradient has < 2 stops, crashing TinyGradient). We strip it
    // unconditionally at this layer too — defense-in-depth alongside the
    // qwen-code adapter's own env builder.
    // Per-user HOME isolation. When the authed user id is non-default, layer
    // userSpawnEnv() AFTER process.env and BEFORE input.env so the CLI's
    // ~/.claude/{config,projects,memory} lands under data/users/<uid>/.claude/.
    // Pre-auth installations passing userId === undefined / null / "default"
    // skip the override and continue using the host HOME — backward-compat.
    const userEnv = (input.userId && input.userId !== "default")
      ? userSpawnEnv(input.userId)
      : {};
    const mergedEnv: Record<string, string> = {
      TERM: "xterm-256color",
      ...process.env,
      ...userEnv,
      ...input.env,
    } as Record<string, string>;
    delete mergedEnv.NO_COLOR;
    delete mergedEnv.FORCE_COLOR_OFF;
    delete mergedEnv.NODE_DISABLE_COLORS;
    mergedEnv.FORCE_COLOR = mergedEnv.FORCE_COLOR ?? "1";

    const ttyd = spawn(
      TTYD_BIN,
      ttydArgs,
      {
        cwd,
        env: mergedEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let port = 0;
    let resolved = false;
    let stderrBuf = "";

    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (resolved) return;
      const p = readPortFromTtydStderr(text);
      if (p) {
        port = p;
        resolved = true;
        const session: ActiveSession = {
          sessionId: input.sessionId,
          ttydPort: port,
          ttydPid: ttyd.pid ?? 0,
          cwd,
          startedAt: new Date().toISOString(),
        };
        ACTIVE.set(input.sessionId, session);
        RECENT_START_INFLIGHT.delete(input.sessionId);
        resolvePromise({
          ok: true,
          sessionId: input.sessionId,
          port,
          url: `http://127.0.0.1:${port}/`,
          wsUrl: `ws://127.0.0.1:${port}/ws`,
          proxyUrl: `/terminal-v2/proxy/${input.sessionId}/`,
        });
      }
    };
    ttyd.stderr.on("data", onStderr);
    ttyd.stdout.on("data", onStderr); // ttyd 1.7+ logs to stdout in some builds

    ttyd.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        RECENT_START_INFLIGHT.delete(input.sessionId);
        resolvePromise({ ok: false, reason: `ttyd spawn error: ${err.message}` });
      }
    });
    ttyd.on("exit", (code) => {
      ACTIVE.delete(input.sessionId);
      if (!resolved) {
        resolved = true;
        RECENT_START_INFLIGHT.delete(input.sessionId);
        resolvePromise({ ok: false, reason: `ttyd exited with code ${code} before binding. stderr: ${stderrBuf.slice(-400)}` });
      }
    });

    // Hard timeout on port detection — if ttyd doesn't bind in 5s, give up.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        RECENT_START_INFLIGHT.delete(input.sessionId);
        try { ttyd.kill("SIGTERM"); } catch { /* ignore */ }
        resolvePromise({ ok: false, reason: `ttyd did not report a bound port within 5s. stderr: ${stderrBuf.slice(-400)}` });
      }
    }, 5_000);
  });
}

export function stopTerminalV2(sessionId: string): { ok: boolean; reason?: string } {
  RECENT_STOPS.set(sessionId, Date.now());
  const session = ACTIVE.get(sessionId);
  if (!session) return { ok: false, reason: "no active terminal-v2 for session" };
  // Kill ttyd → SIGHUP cascades to its PTY child (the CLI process).
  try { process.kill(session.ttydPid, "SIGTERM"); } catch { /* already gone */ }
  ACTIVE.delete(sessionId);
  return { ok: true };
}

export function listTerminalV2(): ActiveSession[] {
  return [...ACTIVE.values()];
}

export function getTerminalV2(sessionId: string): ActiveSession | null {
  return ACTIVE.get(sessionId) ?? null;
}

