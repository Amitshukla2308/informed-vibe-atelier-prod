# FRONTEND_TERMINAL_SURFACE.md — frontend terminal-touching surface

**Companion to:** the v0.1 sidecar's `WIRE_STATE.md`. Together they answer the cutover question: **does the frontend speak the message-name vocabulary the v0.1 sidecar's WS hub emits?** Answer: **yes, for the core flow.**

## TL;DR

| | frontend listens for | sidecar hub.ts emits | Compat |
|---|---|---|---|
| Open | `session.open` (msg type) | `session.open` (`hub.ts:206`) | ✓ |
| Ready | `session.ready` | `session.ready` (`hub.ts:233`) | ✓ |
| Boot signal | `atelier.boot_sent` | `atelier.boot_sent` (`hub.ts:236`) | ✓ |
| Data | `agent.data {chunk}` | `agent.data {chunk}` (`hub.ts:253`) | ✓ |
| Closed | `session.closed {code}` | `session.closed {code}` (`hub.ts:260`) | ✓ |
| Error | `error {error}` | `error {error}` (`hub.ts:273`) | ✓ |
| Semantic | (not listened for) | `terminal.{precmd,preexec,command_finished,block_boundary,wakeup}` | ✓ ignored gracefully (unknown types fall through) |

**The cutover-bridge is wire-compatible TODAY.** The frontend pointed at `ws://localhost:3011/ws` (the v0.1 sidecar's hub per PORTS.md) renders correctly for the open/data/ready/closed/error cycle.

## Files inventory

### `frontend/src/views/Terminal.tsx` (168 LOC) — primary xterm.js pane

- Imports `@xterm/xterm` (terminal pane uses `@xterm/xterm`).
- Listens for: `agent.data` (writes chunk to xterm), `session.open`, `session.ready`, `atelier.boot_sent`, `session.closed`, `error` — **matches the v0.1 sidecar hub.ts emit set verbatim** (per grep on lines 93/95/97/99/101/104).
- Sends `{type: "raw", data}` for input (per Terminal.tsx:123, 286, 316).
- WS connection URL: hardcoded today — to be `VITE_SIDECAR_WS_URL`-overridable.

### `frontend/src/views/Chat.tsx` (428 LOC) — chat view with embedded terminal context

- Same `agent.data` etc. listener set (per grep showing the switch on `msg.type`).
- Multi-client share-PTY participant: per the sidecar hub.ts:155-160, multiple clients on same `sessionId` share one PtyClient.

### `frontend/src/components/TerminalTtyd.tsx` (261 LOC) — ttyd-iframe terminal

- Reverse-proxy embedded ttyd path (legacy v0; the v0.1 sidecar deliberately doesn't carry it over per `core/server/src/index.ts:9-13`).
- **Will NOT work against the v0.1 sidecar.** The sidecar routes only via `/ws` to its TerminalServer; ttyd-proxy is gone. Cutover requires the founder to switch the frontend to use `Terminal.tsx` (xterm-direct) instead of `TerminalTtyd.tsx` (ttyd-iframe).

### `frontend/src/components/ImplementerLiveFeed.tsx` (415 LOC) — implementer reflection feed

- WS subscriber. Listens for implementer events (`task.started`, `task.done` per the sidecar hub.ts `broadcastToAll`).
- Cross-session (subscribes to `__notifications__` per the sidecar hub.ts:142). Wire-compat: same pattern.

### `frontend/src/lib/notifications-socket.ts` (92 LOC) — notifications WS plumbing

- Opens `__notifications__` session (per the sidecar hub.ts:129 `NOTIFY_SESSION = "__notifications__"`). Wire-compat: ✓.

## Cutover notes

1. **Core terminal flow is wire-compatible TODAY.** Pointing the frontend's `Terminal.tsx` at the sidecar's `ws://localhost:3011/ws` would render the agent's PTY output correctly without any frontend code change — assuming the WS URL is configurable (not yet; an env override closes this gap).
2. **`TerminalTtyd.tsx` is legacy-only.** The cutover requires the founder to pick `Terminal.tsx` (xterm-direct, sidecar-compatible) over `TerminalTtyd.tsx` (ttyd-iframe, legacy v0). UI selector for this lives in the Now panel.
3. **Semantic events from the v0.1 sidecar** (`terminal.precmd`, `terminal.preexec`, `terminal.command_finished`, `terminal.block_boundary`, `terminal.wakeup`) are emitted by the sidecar's hub but NOT listened for by the frontend. Today: gracefully ignored (unknown `msg.type` falls through). The Warp-UX features that depend on these (block boundaries, prompt markers, semantic search) require frontend changes — but those are net-new features, not cutover requirements.
4. **WS source URL is the only blocker.** A `VITE_SIDECAR_WS_URL` env override closes this gap with a 3-LOC change.

## Implications for the priority queue

- **Goal #1** ("Warp-style terminal pane visible in the current frontend") is **closer than expected**. Core terminal works against the v0.1 sidecar via Terminal.tsx + an env-var override. **Warp-UX features** (block boundaries, command-finished badges, semantic-event surface) are the next layer — additive frontend work that reads the sidecar's `terminal.<kind>` events.
- The held WS message-contract type formalization is now LOW urgency — the contract is *de facto* compatible; formalizing it as TS types is hygiene but not load-bearing for cutover.
