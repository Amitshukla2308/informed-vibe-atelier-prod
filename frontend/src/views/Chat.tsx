/**
 * Legacy chat view — superseded by Terminal.tsx (PTY/xterm) inside Now.tsx.
 *
 * This file is kept only to host the `ChatStatus` type that five callers
 * import (App, Now, Terminal, TerminalIframe, TerminalTtyd). Renaming the
 * type to a shared module would touch all five files; preserving the import
 * path here is the lower-risk move.
 *
 * The 428-LOC component body was removed in the dead-code pass (2026-05-06)
 * after the spec audit confirmed nothing imports `Chat` itself — only the
 * `ChatStatus` type. If a chat surface is ever resurrected, build it as a
 * fresh component in a new file rather than reviving the legacy code.
 */

export type ChatStatus = "connecting" | "open" | "ready" | "closed" | "error";
