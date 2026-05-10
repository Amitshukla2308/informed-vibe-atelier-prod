import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BASE_URL,
  continueSessions as apiContinue,
  deleteSessionArtifact,
  getSessionDetail,
  listSessions,
  listWorldEvents,
  reflectSessionNow,
  updateSessionArtifact,
  type ContinueMode,
  type NormalizedTurn,
  type SessionEntry,
  type WorldEvent,
} from "../lib/api";

interface Props {
  project: string;
  onNavigateToNow?: () => void;
}

type Zone = { id: string; fresh: boolean };

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function Reflection({ project, onNavigateToNow }: Props) {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [events, setEvents] = useState<WorldEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, { artifact: string | null; rawExcerpt: string; turns: NormalizedTurn[]; turnSource: "provider" | "raw-log-reconstruction" | "none" }>>({});
  const [reflecting, setReflecting] = useState<Set<string>>(new Set());
  const [continueMode, setContinueMode] = useState<ContinueMode>("summarize");
  const [modalOpen, setModalOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalBusy, setModalBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      listSessions(project).catch(() => []),
      listWorldEvents(7).catch(() => []),
    ])
      .then(([s, e]) => { setSessions(s); setEvents(e); })
      .finally(() => setLoading(false));
  }, [project]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 12_000);
    return () => clearInterval(poll);
  }, [load]);

  const [showEmpty, setShowEmpty] = useState(false);
  // A session is "empty / noise" if nobody ever pressed Enter (turnCount counts real
  // Enter-submitted messages, not keystrokes). Those are WS-opens from hard refreshes,
  // React dev double-mounts, and tabs closed before use. Hidden by default; shown
  // behind a toggle so the list reads meaningfully without hiding truth.
  const isNoise = (s: SessionEntry) => s.turnCount === 0;
  const empties = useMemo(() => sessions.filter(isNoise), [sessions]);
  const visibleSessions = useMemo(() => showEmpty ? sessions : sessions.filter(s => !isNoise(s)), [sessions, showEmpty]);
  const unreflected = useMemo(() => sessions.filter(s => !s.reflected && !isNoise(s)), [sessions]);
  const reflected = useMemo(() => sessions.filter(s => s.reflected), [sessions]);

  // Signal-only curation — until the curation prompt runs, derive "worth revisiting"
  // from heuristics: reflected sessions with the most recent flavor, tagged high if a
  // world event lists any node; medium if reflected < 3 days ago; else low.
  const worthRevisiting: Zone[] = useMemo(() => {
    // Stub until the curation worker runs. Shape matches what the real output
    // will carry so the view doesn't change when Phase D goes live.
    return [];
  }, []);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        if (next.size >= 5) return prev; // cap at 5
        next.add(id);
      }
      return next;
    });
  }

  async function openSession(id: string) {
    setOpenDetail(id);
    if (detailCache[id]) return;
    try {
      const d = await getSessionDetail(project, id);
      setDetailCache(c => ({ ...c, [id]: { artifact: d.artifact, rawExcerpt: d.rawExcerpt, turns: d.turns ?? [], turnSource: d.turnSource ?? "none" } }));
    } catch { /* ignore */ }
  }

  async function runReflectNow(id: string) {
    setReflecting(prev => new Set(prev).add(id));
    try {
      await reflectSessionNow(id);
      load();
    } catch (e) {
      console.warn(`reflect ${id} failed`, e);
    } finally {
      setReflecting(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function submitContinuation() {
    setModalBusy(true);
    setModalError(null);
    try {
      const ids = Array.from(selected);
      const mode: ContinueMode = ids.length === 1 ? continueMode : "summarize";
      await apiContinue(project, ids, mode);
      setModalOpen(false);
      setSelected(new Set());
      onNavigateToNow?.();
    } catch (e) {
      setModalError(String(e));
    } finally {
      setModalBusy(false);
    }
  }

  const selectedCount = selected.size;

  return (
    <div className="reflection-root">
      <header className="reflection-head">
        <div>
          <div className="kicker">reflection · {project}</div>
          <h1>Your journey, re-read.</h1>
          <div className="subtitle">Sessions, what they changed about our understanding, and what the world did since.</div>
          <div className="small" style={{ marginTop: 10 }}>
            {loading ? "loading…" : `${sessions.length - empties.length} real sessions · ${reflected.length} reflected · ${unreflected.length} unreflected${empties.length > 0 ? ` · ${empties.length} empty (hidden)` : ""}`}
          </div>
          <div style={{ marginTop: 14, padding: "10px 14px", background: "var(--a-paper)", border: "1px solid var(--a-line)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase", lineHeight: 1.7, maxWidth: 620 }}>
            <strong style={{ color: "var(--a-ink)" }}>reflecting a session</strong> writes a six-lens summary (engineer · architect · strategist · economist · scientist · product) to <code>projects/{project}/sessions/</code> and extracts signals — preferences, redirects, axioms, voice — into your personal brain at <code>brain/personal/&lt;you&gt;/</code>. future sessions load those signals silently.
            <br /><br />
            <strong style={{ color: "var(--a-ink)" }}>the brain deltas surface</strong> here and in the brain view once the per-session signal-to-source tracking lands (next pass).
          </div>
        </div>
        <div className="reflection-stats">
          {[
            { val: String(sessions.length - empties.length), label: "real sessions" },
            { val: String(reflected.length), label: "reflected" },
            { val: String(unreflected.length), label: "unreflected" },
            { val: String(events.length), label: "world events · 7d" },
          ].map(s => (
            <div key={s.label} className="stat">
              <div className="v">{s.val}</div>
              <div className="l">{s.label}</div>
            </div>
          ))}
        </div>
      </header>

      {/* R3.7 — Skeleton stack while initial sessions list is fetching, only on first load
          (when there's nothing to render yet). Disappears once any data lands or fetch finishes. */}
      {loading && sessions.length === 0 && (
        <section style={{ marginTop: 28 }} aria-busy="true" aria-label="Loading sessions">
          <div className="skeleton-line" style={{ width: "30%", height: 12 }} />
          <div className="skeleton-block" style={{ width: "100%", height: 64, marginTop: 12 }} />
          <div className="skeleton-block" style={{ width: "100%", height: 64, marginTop: 8 }} />
          <div className="skeleton-block" style={{ width: "100%", height: 64, marginTop: 8 }} />
        </section>
      )}

      {/* ZONE 1 — Worth revisiting (signal-only curation; stubbed until Phase D runs) */}
      <section className="reflection-flavor">
        <div className="label">worth revisiting · signal-only</div>
        {worthRevisiting.length === 0 ? (
          // Empty-state CTA: explain what would surface a session here, link to where work happens.
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-mute)", textTransform: "lowercase", lineHeight: 1.7 }}>
            <span>nothing to revisit yet.</span>{" "}
            sessions surface here when their reflected signals match a fresh world event or a new axiom in the brain. reflect a few sessions below to seed the brain.
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {worthRevisiting.map(z => (
              <li key={z.id}>{z.id}</li>
            ))}
          </ul>
        )}
      </section>

      {/* ZONE 2 — Unreflected */}
      {unreflected.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>
            unreflected · {unreflected.length} session{unreflected.length === 1 ? "" : "s"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {unreflected.map(s => (
              <div key={s.sessionId} style={{
                background: "var(--a-paper)",
                border: "1px solid var(--a-line)",
                borderRadius: 4,
                padding: "10px 14px",
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
              }}>
                <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", flex: 1, minWidth: 0 }}>
                  <input
                    type="checkbox"
                    checked={selected.has(s.sessionId)}
                    onChange={() => toggle(s.sessionId)}
                    style={{ marginTop: 3 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)" }}>
                      session {shortId(s.sessionId)} · {timeAgo(s.endedAt)} · {s.turnCount} turns · ~{Math.round((s.approxTokens ?? 0) / 1000)}k tokens
                    </div>
                    <div style={{ fontSize: "var(--t-2)", color: "var(--a-ink)", marginTop: 3, fontFamily: "var(--font-serif)", lineHeight: 1.35, wordBreak: "break-word" }}>
                      {s.firstUserLine ? `"${s.firstUserLine}"` : <span style={{ color: "var(--a-mute)", fontStyle: "italic", fontFamily: "var(--font-mono)" }}>no user message captured</span>}
                    </div>
                  </div>
                </label>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => openSession(s.sessionId)}
                    style={{
                      fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", textTransform: "lowercase",
                      padding: "6px 10px", background: "transparent", border: "1px solid var(--a-line)",
                      borderRadius: 3, color: "var(--a-ink)", cursor: "pointer",
                    }}
                  >open</button>
                  <button
                    type="button"
                    onClick={() => runReflectNow(s.sessionId)}
                    disabled={reflecting.has(s.sessionId)}
                    aria-busy={reflecting.has(s.sessionId)}
                    aria-label={reflecting.has(s.sessionId) ? "Reflecting this session, takes about 15 seconds" : "Reflect this session now (takes about 15 seconds)"}
                    style={{
                      fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", textTransform: "lowercase",
                      padding: "6px 12px", background: "transparent",
                      border: `1px solid ${reflecting.has(s.sessionId) ? "var(--a-accent)" : "var(--a-line)"}`,
                      borderRadius: 3,
                      color: reflecting.has(s.sessionId) ? "var(--a-accent)" : "var(--a-ink)",
                      cursor: reflecting.has(s.sessionId) ? "wait" : "pointer",
                      opacity: reflecting.has(s.sessionId) ? 0.85 : 1,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {reflecting.has(s.sessionId) ? (
                      <>
                        <span
                          aria-hidden="true"
                          style={{
                            width: 9,
                            height: 9,
                            border: "1.5px solid var(--a-accent)",
                            borderTopColor: "transparent",
                            borderRadius: "50%",
                            display: "inline-block",
                            animation: "atelier-spin 0.8s linear infinite",
                          }}
                        />
                        reflecting… (~15s)
                      </>
                    ) : "reflect now · ~15s"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ZONE 3 — Brain & World deltas (stubbed until Brain/World infra ships) */}
      <section style={{ marginTop: 32, padding: 16, background: "var(--a-paper)", border: "1px dashed var(--a-line)", borderRadius: 6 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>
          brain + world deltas · last 7 days
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-mute)", textTransform: "lowercase", lineHeight: 1.7 }}>
          personal brain is ingesting signals as sessions reflect · {events.length} world events in the last 7 days{events.length > 0 ? "." : " · waiting on live watchers."}
          <br />
          detailed deltas appear here when Brain (personal axiom + redirect files) and World (watcher events) ship end-to-end.
        </div>
      </section>

      {/* ZONE 4 — All sessions chronological */}
      <section style={{ marginTop: 32, marginBottom: selectedCount > 0 ? 100 : 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            all sessions · {visibleSessions.length}{empties.length > 0 ? ` · ${empties.length} empty hidden` : ""}
          </div>
          {empties.length > 0 && (
            <button
              onClick={() => setShowEmpty(x => !x)}
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", background: "transparent", border: "none", color: "var(--a-accent)", cursor: "pointer", textTransform: "lowercase" }}
            >
              {showEmpty ? "hide empty" : `show ${empties.length} empty`}
            </button>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {visibleSessions.map(s => {
            const isSelected = selected.has(s.sessionId);
            return (
              <div
                key={s.sessionId}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto auto auto auto",
                  gap: 14,
                  alignItems: "center",
                  padding: "8px 14px",
                  background: isSelected ? "var(--a-accent-soft)" : "var(--a-paper)",
                  border: "1px solid " + (isSelected ? "var(--a-accent)" : "var(--a-line)"),
                  borderRadius: 3,
                  fontFamily: "var(--font-mono)", fontSize: "var(--t-1)",
                }}
              >
                <input type="checkbox" aria-label={`Select session ${shortId(s.sessionId)}`} checked={isSelected} onChange={() => toggle(s.sessionId)} disabled={s.turnCount === 0} />
                <div style={{ color: "var(--a-ink)", minWidth: 0, wordBreak: "break-word" }}>
                  <strong style={{ textTransform: "lowercase" }}>{shortId(s.sessionId)}</strong>
                  {s.flavor
                    ? <span style={{ color: "var(--a-mute)", marginLeft: 10, fontStyle: "italic" }}>· {s.flavor}</span>
                    : s.firstUserLine
                      ? <span style={{ color: "var(--a-mute)", marginLeft: 10 }}>· "{s.firstUserLine}"</span>
                      : <span style={{ color: "var(--a-faint)", marginLeft: 10, textTransform: "lowercase" }}>· empty</span>
                  }
                </div>
                <span style={{ color: "var(--a-mute)" }}>{s.turnCount} turns</span>
                <span style={{ color: "var(--a-mute)" }}>{timeAgo(s.startedAt)}</span>
                <span style={{
                  color: s.reflected ? "var(--sem-green)" : "var(--sem-amber)",
                  textTransform: "lowercase",
                }}>
                  {s.reflected ? "reflected" : "unreflected"}
                </span>
                <button
                  onClick={() => openSession(s.sessionId)}
                  style={{
                    fontFamily: "var(--font-mono)", fontSize: "var(--t-1)",
                    padding: "4px 10px", background: "transparent",
                    border: "1px solid var(--a-line)", borderRadius: 3,
                    cursor: "pointer", color: "var(--a-ink)", textTransform: "lowercase",
                  }}
                >
                  open
                </button>
              </div>
            );
          })}
          {sessions.length === 0 && !loading && (
            // Empty-state CTA: explicit + linked. Sessions are created in /now,
            // but until you press enter on a real prompt, none persist here.
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-mute)", textTransform: "lowercase", padding: 24, textAlign: "center", lineHeight: 1.7 }}>
              <div style={{ color: "var(--a-ink)", marginBottom: 8 }}>no sessions yet.</div>
              every conversation you have with the agent in <strong>now</strong> becomes a session here once it has at least one real turn. reflect them later to extract signals into your brain.
              <div style={{ marginTop: 14 }}>
                <button
                  type="button"
                  onClick={() => onNavigateToNow?.()}
                  style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", textTransform: "lowercase", padding: "8px 16px", background: "var(--a-accent)", border: "1px solid var(--a-accent)", borderRadius: 3, color: "var(--a-paper)", cursor: "pointer" }}
                >start a session in now →</button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Sticky multi-select footer */}
      {selectedCount > 0 && (
        <div style={{
          position: "sticky", bottom: 0,
          background: "var(--a-paper)",
          borderTop: "1px solid var(--a-line-2)",
          padding: "14px 24px",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          boxShadow: "0 -6px 18px rgba(26,23,20,0.08)",
          marginLeft: -40, marginRight: -40, marginBottom: -40,
        }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", color: "var(--a-ink)", textTransform: "lowercase" }}>
            <strong>{selectedCount}</strong> session{selectedCount === 1 ? "" : "s"} selected
            {selectedCount === 5 && <span style={{ color: "var(--a-mute)", marginLeft: 10 }}>· max</span>}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => setSelected(new Set())}
              style={{
                fontFamily: "var(--font-mono)", fontSize: "var(--t-2)",
                padding: "6px 14px", background: "transparent",
                border: "1px solid var(--a-line)", borderRadius: 3,
                cursor: "pointer", color: "var(--a-ink)", textTransform: "lowercase",
              }}
            >
              clear
            </button>
            <button
              onClick={() => setModalOpen(true)}
              style={{
                fontFamily: "var(--font-mono)", fontSize: "var(--t-2)",
                padding: "6px 14px", background: "var(--a-accent)",
                border: "1px solid var(--a-accent)", borderRadius: 3,
                cursor: "pointer", color: "var(--a-paper)", textTransform: "lowercase",
              }}
            >
              continue with selected →
            </button>
          </div>
        </div>
      )}

      {/* Session detail drawer */}
      {openDetail && (
        <SessionDrawer
          sessionId={openDetail}
          project={project}
          entry={sessions.find(s => s.sessionId === openDetail)}
          artifact={detailCache[openDetail]?.artifact ?? null}
          rawExcerpt={detailCache[openDetail]?.rawExcerpt ?? ""}
          turns={detailCache[openDetail]?.turns ?? []}
          turnSource={detailCache[openDetail]?.turnSource ?? "none"}
          onClose={() => setOpenDetail(null)}
          onArtifactChanged={() => { load(); setDetailCache(c => { const { [openDetail]: _drop, ...rest } = c; return rest; }); }}
        />
      )}

      {/* Continuation modal */}
      {modalOpen && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(26,23,20,0.4)",
          zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center",
        }} onClick={() => !modalBusy && setModalOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            background: "var(--a-paper)", border: "1px solid var(--a-line-2)",
            borderRadius: 6, padding: 26, width: 480, maxWidth: "94vw",
            boxShadow: "0 18px 48px rgba(26,23,20,0.18)",
          }}>
            <div className="kicker">continue with {selectedCount} session{selectedCount === 1 ? "" : "s"}</div>
            <h3 style={{ margin: "6px 0 14px", fontFamily: "var(--font-serif)", fontWeight: 600 }}>
              Pool selected context into your next session
            </h3>
            {selectedCount === 1 ? (
              <>
                <p style={{ fontSize: "var(--t-2)", color: "var(--a-ink)", lineHeight: 1.5, marginBottom: 14 }}>
                  With one session selected you can either resume Claude's exact conversation, or let the agent summarize the decisions + open threads and start a fresh session from that brief.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
                  <label style={{ display: "flex", gap: 10, cursor: "pointer", padding: 10, border: "1px solid " + (continueMode === "summarize" ? "var(--a-accent)" : "var(--a-line)"), borderRadius: 4 }}>
                    <input type="radio" checked={continueMode === "summarize"} onChange={() => setContinueMode("summarize")} />
                    <div>
                      <strong style={{ fontSize: "var(--t-3)" }}>summarize</strong>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", marginTop: 2 }}>
                        agent distills decisions, threads, contradictions · fresh session w/ brief in system prompt
                      </div>
                    </div>
                  </label>
                  <label style={{ display: "flex", gap: 10, cursor: "pointer", padding: 10, border: "1px solid " + (continueMode === "resume" ? "var(--a-accent)" : "var(--a-line)"), borderRadius: 4 }}>
                    <input type="radio" checked={continueMode === "resume"} onChange={() => setContinueMode("resume")} />
                    <div>
                      <strong style={{ fontSize: "var(--t-3)" }}>resume</strong>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", marginTop: 2 }}>
                        pick up claude's exact conversation · same session id
                      </div>
                    </div>
                  </label>
                </div>
              </>
            ) : (
              <p style={{ fontSize: "var(--t-2)", color: "var(--a-ink)", lineHeight: 1.5, marginBottom: 18 }}>
                Multiple sessions will be summarized — the agent extracts decisions, open threads, recurring patterns, and contradictions across all {selectedCount}, and files a pooled brief into your next session's system prompt.
                <br /><br />
                <strong style={{ color: "var(--a-accent)" }}>This is session context pooling</strong> — a feature no other tool offers. Up to 5 past sessions treated as one journey, not N isolated transcripts.
              </p>
            )}
            {modalError && <div style={{ color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", marginBottom: 10 }}>{modalError}</div>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setModalOpen(false)} disabled={modalBusy} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: "6px 14px", background: "transparent", border: "1px solid var(--a-line)", borderRadius: 3, cursor: "pointer", color: "var(--a-ink)", textTransform: "lowercase" }}>cancel</button>
              <button onClick={submitContinuation} disabled={modalBusy} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: "6px 14px", background: "var(--a-accent)", border: "1px solid var(--a-accent)", borderRadius: 3, cursor: modalBusy ? "wait" : "pointer", color: "var(--a-paper)", textTransform: "lowercase" }}>
                {modalBusy ? (selectedCount > 1 ? "summarizing…" : "preparing…") : "continue →"}
              </button>
            </div>
            <div style={{ marginTop: 14, fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--a-faint)", textTransform: "lowercase", letterSpacing: "0.04em" }}>
              next session opens in now · brief loaded via silent-context (not visible in terminal)
            </div>
          </div>
        </div>
      )}

      {/* Silence unused import warning when Phase D curation call is stubbed */}
      {false && <span>{BASE_URL}</span>}
    </div>
  );
}

// ── Session detail drawer ─────────────────────────────────────────────────────

interface DrawerProps {
  sessionId: string;
  project: string;
  entry?: SessionEntry;
  artifact: string | null;
  rawExcerpt: string;
  turns: NormalizedTurn[];
  turnSource: "provider" | "raw-log-reconstruction" | "none";
  onClose: () => void;
  onArtifactChanged: () => void;
}

/** Parse a six-lens / session artifact markdown into (heading → body) sections.
 *  Also extracts YAML frontmatter (produced by OmniGraph reflect; absent from
 *  legacy claude --print artifacts).
 *  Strips the machine-readable `atelier:session-id` HTML comment from the output.
 */
function parseSections(md: string): { frontmatter: Record<string, string>; sections: Array<{ heading: string; body: string }> } {
  let cleaned = md.replace(/^<!--[^\n]*-->\s*\n?/g, "");
  const frontmatter: Record<string, string> = {};
  // YAML frontmatter — `---\n key: value\n ... \n---\n`
  const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(cleaned);
  if (fmMatch) {
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const m = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
      if (m) frontmatter[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    cleaned = cleaned.slice(fmMatch[0].length);
  }
  const parts = cleaned.split(/^##\s+/m);
  const sections: Array<{ heading: string; body: string }> = [];
  if (parts[0]?.trim()) sections.push({ heading: "preamble", body: parts[0].trim() });
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    const nl = seg.indexOf("\n");
    if (nl === -1) { sections.push({ heading: seg.trim(), body: "" }); continue; }
    sections.push({ heading: seg.slice(0, nl).trim(), body: seg.slice(nl + 1).trim() });
  }
  return { frontmatter, sections };
}

const SIX_LENSES = ["Engineer", "Architect", "Strategist", "Economist", "Scientist", "Product"];

function formatTs(ts: string): string {
  if (!ts) return "";
  try { return new Date(ts).toLocaleTimeString(); } catch { return ts; }
}

function TurnCard({ turn }: { turn: NormalizedTurn }) {
  const isUser = turn.role === "user";
  const tint = isUser ? "var(--a-accent)" : "var(--a-line-2)";
  return (
    <div style={{ border: `1px solid var(--a-line)`, borderLeft: `3px solid ${tint}`, borderRadius: 4, padding: "10px 14px", background: isUser ? "var(--a-paper-2)" : "var(--a-paper)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase", marginBottom: 6 }}>
        <span><strong style={{ color: isUser ? "var(--a-accent)" : "var(--a-ink)" }}>{turn.role}</strong>{turn.model ? <span style={{ marginLeft: 8, color: "var(--a-faint)" }}>· {turn.model}</span> : null}</span>
        <span>{formatTs(turn.ts)}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {turn.blocks.map((b, i) => {
          if (b.type === "text") {
            return <div key={i} style={{ fontFamily: "var(--font-serif)", fontSize: "var(--t-3)", lineHeight: 1.55, color: "var(--a-ink)", whiteSpace: "pre-wrap" }}>{b.text}</div>;
          }
          if (b.type === "thinking") {
            return <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", fontStyle: "italic", borderLeft: "2px dashed var(--a-line)", paddingLeft: 8 }}>thinking · {b.text.length > 0 ? b.text.slice(0, 180) + (b.text.length > 180 ? "…" : "") : "(reasoning redacted)"}</div>;
          }
          if (b.type === "tool_use") {
            return (
              <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-ink)", background: "var(--a-page)", padding: "6px 10px", borderRadius: 3 }}>
                <strong style={{ color: "var(--a-accent)" }}>→ {b.name}</strong>
                <span style={{ color: "var(--a-mute)", marginLeft: 10 }}>{JSON.stringify(b.input).slice(0, 120)}</span>
              </div>
            );
          }
          if (b.type === "tool_result") {
            return (
              <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: b.isError ? "var(--sem-red)" : "var(--a-mute)", background: "var(--a-page)", padding: "6px 10px", borderRadius: 3, whiteSpace: "pre-wrap", maxHeight: 140, overflow: "hidden" }}>
                <strong>{b.isError ? "✗ error" : "← result"}</strong>
                <div style={{ marginTop: 2 }}>{b.output.slice(0, 320)}{b.output.length > 320 ? "…" : ""}</div>
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function SessionDrawer({ sessionId, project, entry, artifact, rawExcerpt, turns, turnSource, onClose, onArtifactChanged }: DrawerProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(artifact ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setEditText(artifact ?? ""); setEditing(false); setConfirmDiscard(false); setErr(null); }, [artifact, sessionId]);

  async function save() {
    setSaving(true); setErr(null);
    try {
      await updateSessionArtifact(project, sessionId, editText);
      setEditing(false);
      onArtifactChanged();
    } catch (e) { setErr(String(e)); }
    finally { setSaving(false); }
  }

  async function discard() {
    setSaving(true); setErr(null);
    try {
      await deleteSessionArtifact(project, sessionId);
      onArtifactChanged();
      onClose();
    } catch (e) { setErr(String(e)); setSaving(false); }
  }

  const parsed = artifact ? parseSections(artifact) : { frontmatter: {}, sections: [] };
  const { frontmatter, sections } = parsed;
  const isOmnigraphArtifact = !!frontmatter.produced_by && frontmatter.produced_by.includes("omnigraph");

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(26,23,20,0.35)",
      zIndex: 40, display: "flex", justifyContent: "flex-end",
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 620, maxWidth: "100vw",
        background: "var(--a-paper)",
        borderLeft: "1px solid var(--a-line)",
        height: "100vh", overflowY: "auto",
        padding: "22px 26px 40px",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <div className="kicker" style={{ marginBottom: 2 }}>
              session · {sessionId.slice(0, 8)} · {entry?.turnCount ?? 0} turns
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
              {entry?.reflected ? <span style={{ color: "var(--sem-green)" }}>reflected</span> : <span style={{ color: "var(--sem-amber)" }}>unreflected</span>}
              {" · "}
              {entry?.startedAt ? new Date(entry.startedAt).toLocaleString() : "—"}
            </div>
          </div>
          <button onClick={onClose} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", padding: "3px 10px", background: "transparent", border: "1px solid var(--a-line)", borderRadius: 3, cursor: "pointer", color: "var(--a-mute)", textTransform: "lowercase" }}>close</button>
        </div>

        {artifact && !editing && (
          <>
            {/* Frontmatter strip — only present on OmniGraph-produced artifacts. */}
            {isOmnigraphArtifact && (
              <div style={{ marginBottom: 12, padding: "10px 14px", background: "color-mix(in srgb, var(--a-accent) 6%, var(--a-paper-2))", borderLeft: "3px solid var(--a-accent)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-ink)", lineHeight: 1.7 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ color: "var(--a-accent)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", fontSize: 10 }}>omnigraph</span>
                  <span style={{ color: "var(--a-mute)" }}>· {frontmatter.produced_by ?? "?"}</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, color: "var(--a-mute)", textTransform: "lowercase" }}>
                  {frontmatter.lens_count && <span><strong style={{ color: "var(--a-ink)" }}>{frontmatter.lens_count}</strong> lenses</span>}
                  {frontmatter.project && <span>project · <strong style={{ color: "var(--a-ink)" }}>{frontmatter.project}</strong></span>}
                  {frontmatter.provider && <span>provider · {frontmatter.provider}</span>}
                  {frontmatter.atelier_user_id && <span>user · <code style={{ fontSize: "var(--t-1)" }}>{frontmatter.atelier_user_id.slice(0, 8)}…</code></span>}
                </div>
              </div>
            )}
            <div style={{ marginBottom: 12, padding: "8px 12px", background: "var(--a-paper-2)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase", lineHeight: 1.6 }}>
              {isOmnigraphArtifact
                ? <>six-lens crystallization from omnigraph reflect — engineer/architect/strategist/economist/scientist/product. extracted directly from the structured claude-code session. edit to refine.</>
                : <>these sections feed the next session through <code>silent-context</code> + personal brain. edit to refine, discard to throw the artifact out.</>
              }
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {sections.map((s, i) => {
                const isLens = SIX_LENSES.some(l => s.heading.toLowerCase().startsWith(l.toLowerCase()));
                return (
                  <div key={i} style={{
                    background: "var(--a-page)",
                    border: "1px solid var(--a-line)",
                    borderLeft: isLens ? "3px solid var(--a-accent-soft)" : "1px solid var(--a-line)",
                    borderRadius: 4,
                    padding: "10px 14px",
                  }}>
                    <div style={{ fontFamily: isLens ? "var(--font-serif)" : "var(--font-mono)", fontSize: isLens ? "var(--t-3)" : 10, color: isLens ? "var(--a-ink)" : "var(--a-mute)", textTransform: isLens ? "none" : "uppercase", letterSpacing: isLens ? "-0.01em" : "0.1em", fontWeight: isLens ? 600 : 500, marginBottom: 6 }}>
                      {s.heading}
                    </div>
                    <div style={{ fontFamily: "var(--font-serif)", fontSize: "var(--t-2)", color: "var(--a-ink)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                      {s.body || <em style={{ color: "var(--a-faint)" }}>(empty — extraction may be thin for this lens)</em>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <button onClick={() => setEditing(true)} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", padding: "6px 12px", background: "transparent", border: "1px solid var(--a-line)", borderRadius: 3, cursor: "pointer", color: "var(--a-ink)", textTransform: "lowercase" }}>edit</button>
              {!confirmDiscard ? (
                <button onClick={() => setConfirmDiscard(true)} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", padding: "6px 12px", background: "transparent", border: "1px solid var(--sem-red)", borderRadius: 3, cursor: "pointer", color: "var(--sem-red)", textTransform: "lowercase" }}>discard</button>
              ) : (
                <>
                  <button onClick={discard} disabled={saving} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", padding: "6px 12px", background: "var(--sem-red)", border: "1px solid var(--sem-red)", borderRadius: 3, cursor: saving ? "wait" : "pointer", color: "var(--a-paper)", textTransform: "lowercase" }}>yes, delete artifact</button>
                  <button onClick={() => setConfirmDiscard(false)} disabled={saving} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", padding: "6px 12px", background: "transparent", border: "1px solid var(--a-line)", borderRadius: 3, cursor: "pointer", color: "var(--a-ink)", textTransform: "lowercase" }}>cancel</button>
                </>
              )}
            </div>
          </>
        )}

        {artifact && editing && (
          <>
            <div style={{ marginBottom: 8, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
              editing · plain markdown · session-id tag at top preserved automatically
            </div>
            <textarea
              aria-label="Edit reflection artifact (markdown)"
              value={editText}
              onChange={e => setEditText(e.target.value)}
              style={{ width: "100%", minHeight: 400, fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", padding: 12, border: "1px solid var(--a-line)", borderRadius: 4, background: "var(--a-page)", color: "var(--a-ink)", resize: "vertical", lineHeight: 1.5 }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button onClick={save} disabled={saving} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", padding: "6px 14px", background: "var(--a-accent)", border: "1px solid var(--a-accent)", borderRadius: 3, cursor: saving ? "wait" : "pointer", color: "var(--a-paper)", textTransform: "lowercase" }}>{saving ? "saving…" : "save edit"}</button>
              <button onClick={() => { setEditing(false); setEditText(artifact); }} disabled={saving} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", padding: "6px 14px", background: "transparent", border: "1px solid var(--a-line)", borderRadius: 3, cursor: "pointer", color: "var(--a-ink)", textTransform: "lowercase" }}>cancel</button>
            </div>
          </>
        )}

        {!artifact && (
          turns.length > 0 ? (
            <>
              <div style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 4, background: "var(--a-paper-2)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase", lineHeight: 1.6 }}>
                {turnSource === "provider" ? (
                  <>no reflection artifact yet · <strong>{turns.length} conversation turn{turns.length === 1 ? "" : "s"}</strong> from claude's structured log · click <strong>reflect now</strong> above to produce a six-lens summary</>
                ) : (
                  <>legacy session · <strong>{turns.length} user turn{turns.length === 1 ? "" : "s"}</strong> reconstructed from raw.log · agent side can't be cleanly rebuilt from pty bytes · reflect-now still works (it reads raw.log in full)</>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {turns.map(t => <TurnCard key={t.turnId} turn={t} />)}
              </div>
              {turnSource === "raw-log-reconstruction" && (
                <details style={{ marginTop: 16 }}>
                  <summary style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", cursor: "pointer", textTransform: "lowercase" }}>
                    show raw pty excerpt (agent side, messy)
                  </summary>
                  <pre style={{
                    fontFamily: "var(--font-mono)", fontSize: "var(--t-2)",
                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                    background: "var(--a-paper-2)", padding: 14, borderRadius: 4,
                    color: "var(--a-ink)", lineHeight: 1.5, marginTop: 8,
                  }}>
                    {rawExcerpt || "(nothing captured)"}
                  </pre>
                </details>
              )}
            </>
          ) : (
            <>
              <div style={{ marginBottom: 10, fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", color: "var(--a-mute)", textTransform: "lowercase" }}>
                nothing readable · this session may have connected but never submitted a message
              </div>
              <pre style={{
                fontFamily: "var(--font-mono)", fontSize: "var(--t-2)",
                whiteSpace: "pre-wrap", wordBreak: "break-word",
                background: "var(--a-paper-2)", padding: 14, borderRadius: 4,
                color: "var(--a-ink)", lineHeight: 1.5,
              }}>
                {rawExcerpt || "(nothing captured)"}
              </pre>
            </>
          )
        )}

        {err && <div style={{ color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-1)", marginTop: 10 }}>{err}</div>}
      </div>
    </div>
  );
}
