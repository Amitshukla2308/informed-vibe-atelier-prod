import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Onboarding } from "./views/Onboarding";
import { WelcomeBack } from "./views/WelcomeBack";
import { Landing } from "./views/Landing";
import { SignIn } from "./views/SignIn";
import { Home } from "./views/Home";
import { Now } from "./views/Now";
import { Backlog } from "./views/Backlog";
import { Implementer } from "./views/Implementer";
import { Canvas } from "./views/Canvas";
import { Brain } from "./views/Brain";
import { Approvals } from "./views/Approvals";
import { World } from "./views/World";
import { Reflection } from "./views/Reflection";
import { Settings } from "./views/Settings";
import { Diagnostics } from "./views/Diagnostics";
import { Join } from "./views/Join";
import { getOnboardingState, getMe, logoutSoft, listOrgs, BASE_URL, type PreviousIdentity, type OrgListEntry } from "./lib/api";
import { subscribeNotifications } from "./lib/notifications-socket";
import { useRoute, navigate, pathToView, viewToPath, HOME_PATH } from "./lib/router";
import type { ChatStatus } from "./views/Chat";

type View = "home" | "now" | "backlog" | "implementer" | "canvas" | "brain" | "approvals" | "world" | "reflect" | "settings" | "diagnostics";
type AgentState = "idle" | "thinking" | "drafting" | "blocked";

function wsToAgentState(s: ChatStatus): AgentState {
  if (s === "ready") return "idle";
  if (s === "closed" || s === "error") return "blocked";
  return "thinking";
}

const Ico = {
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>,
  now: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
  backlog: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h12"/><circle cx="20" cy="18" r="1.2"/></svg>,
  implementer: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l8 5 8-5"/><path d="M4 6v12h16V6"/><path d="M4 18l8-6 8 6"/></svg>,
  canvas: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10"/></svg>,
  brain: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M9 3a4 4 0 0 0-4 4v2a3 3 0 0 0 0 6v2a4 4 0 0 0 4 4M15 3a4 4 0 0 1 4 4v2a3 3 0 0 1 0 6v2a4 4 0 0 1-4 4"/></svg>,
  approvals: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/><path d="M16 16l2 2 4-4"/></svg>,
  world: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>,
  reflect: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18v10H3z"/><path d="M8 19l4-4 4 4"/><path d="M7 9h10M7 12h6"/></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>,
};

type AppState =
  | { kind: "loading" }
  // isAuthed distinguishes a signed-in founder whose config is incomplete
  // (must be sent to onboarding to finish) from an anonymous stranger (who
  // should see marketing, not a setup form).
  | { kind: "onboarding"; isAuthed: boolean }
  | { kind: "welcome-back"; previous: PreviousIdentity }
  | { kind: "ready"; agentName: string; founderName: string; activeProject: string; orgName: string | null; pickupFlavor: string | null }
  | { kind: "error"; message: string };

// ──────────────────────────────────────────────────────────────────────────
// Routing decision — pure function. Maps (route, query flags, appState) to
// exactly one screen outcome. Tested mentally against every permutation:
//
//   inviteToken (?inv) is always highest priority (a stranger lands on Join).
//   Loading suppresses everything until /state resolves.
//   Public paths /landing /signin render unconditionally (no auth preempts).
//   Root "/" → landing (with adminSignin escape to onboarding).
//   welcome-back state preempts authed paths; landing/signin still reachable.
//   onboarding state requires ?signin=admin to show Onboarding;
//     otherwise → landing (so unconfigured strangers see marketing, not a form).
//   ready state on an authed path → shell; on unknown path → /home.
//
// Adding a screen? Add it here, not as a parallel branch in render.
// ──────────────────────────────────────────────────────────────────────────
type Screen =
  | { kind: "loading" }
  | { kind: "join"; inviteToken: string }
  | { kind: "landing"; isAuthed: boolean }
  | { kind: "signin" }
  | { kind: "welcome-back"; previous: PreviousIdentity }
  | { kind: "onboarding" }
  | { kind: "shell"; view: View };

type LandingPreference = "canvas" | "home";

function decideScreen(args: {
  route: string;
  inviteToken: string | null;
  adminSignin: boolean;
  appState: AppState;
  landingPreference: LandingPreference;
  resetIntent: boolean;
}): Screen {
  const { route, inviteToken, adminSignin, appState, landingPreference, resetIntent } = args;

  // -1. Password-reset link short-circuit. Old emails point at `/?reset=<token>`,
  //     new emails at `/signin?reset=<token>`. `resetIntent` is captured ONCE on
  //     App mount from window.location.search and held in state — SignIn's own
  //     useEffect strips the query from the URL bar for privacy, so a fresh
  //     `URLSearchParams` read on later renders would be empty. The captured
  //     flag keeps decideScreen returning signin for the entire session, until
  //     a successful reset triggers a full page reload.
  if (resetIntent) {
    return { kind: "signin" };
  }

  // 0. Wait for /state to resolve before deciding anything authed.
  //    Public paths still render below — they don't need /state.
  if (appState.kind === "loading") {
    if (route === "/landing" || route === "/" || route === "") {
      return { kind: "landing", isAuthed: false };
    }
    if (route === "/signin") return { kind: "signin" };
    if (inviteToken) return { kind: "join", inviteToken };
    return { kind: "loading" };
  }

  // 1. Invite link wins over everything (stranger flow).
  if (inviteToken) return { kind: "join", inviteToken };

  // 2. Public paths render regardless of auth state.
  if (route === "/signin") return { kind: "signin" };
  if (route === "/landing") {
    return { kind: "landing", isAuthed: appState.kind === "ready" };
  }


  // 3. Root "/" — branch by state:
  //    a) ?signin=admin escape → onboarding (host first-time setup).
  //    b) we have a previous_identity (just-logged-out, or returning user) →
  //       WelcomeBack so "continue as X" is one click. Otherwise the user
  //       is forced through Landing → Get Started → Onboarding and creates
  //       a duplicate identity by accident.
  //    c) anything else → Landing.
  if (route === "/" || route === "") {
    // Show onboarding when explicitly requested (?signin=admin, any non-ready
    // state — preserves the host-setup escape) OR when the visitor is a
    // signed-in founder who simply hasn't finished setup. The latter must
    // never be bounced to marketing (they'd loop on sign-in).
    if ((adminSignin || (appState.kind === "onboarding" && appState.isAuthed)) && appState.kind !== "ready") {
      return { kind: "onboarding" };
    }
    if (appState.kind === "welcome-back") {
      return { kind: "welcome-back", previous: appState.previous };
    }
    // F1: an authed founder revisiting "/" should land in their workspace,
    // not get re-marketed at /landing. The default landing surface is Canvas
    // (the workspace's center of gravity); preference is one of:
    //   - "canvas" (default): root → /canvas
    //   - "home"  : root → /home (founders who explicitly opted back via
    //              the one-time landing toast)
    // Persisted in localStorage(`atelier.landing`); set by LandingToast.
    if (appState.kind === "ready") {
      return { kind: "shell", view: landingPreference === "home" ? "home" : "canvas" };
    }
    return { kind: "landing", isAuthed: false };
  }

  // 4. Welcome-back preempts authed paths (soft logout flow).
  if (appState.kind === "welcome-back") {
    return { kind: "welcome-back", previous: appState.previous };
  }

  // 5. Onboarding state: a signed-in founder with an incomplete config is sent
  //    to Onboarding to finish (this is the path a returning user lands on
  //    after sign-in → /home). ?signin=admin also forces it. An UNauthenticated
  //    visitor with no config still sees Landing (marketing, not a form).
  if (appState.kind === "onboarding") {
    if (adminSignin || appState.isAuthed) return { kind: "onboarding" };
    return { kind: "landing", isAuthed: false };
  }

  // 6. Ready: render shell with the requested view, fall back to home.
  if (appState.kind === "ready") {
    const view = pathToView(route) as View;
    return { kind: "shell", view };
  }

  // 7. Defensive fallback — shouldn't be reached.
  return { kind: "landing", isAuthed: false };
}

/** Canonical URL the browser SHOULD show given a screen. Used for one-shot
 *  URL normalization (e.g. "/" gets rewritten to "/landing" silently). */
function canonicalPathFor(screen: Screen): string | null {
  switch (screen.kind) {
    case "landing":      return "/landing";
    case "signin":       return "/signin";
    case "welcome-back": return "/";
    case "shell":        return viewToPath(screen.view);
    case "onboarding":   return "/";
    // join, loading: no canonical URL — keep whatever the user typed.
    default: return null;
  }
}

function readInviteFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("inv");
}

function isAdminSigninRequest(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("signin") === "admin";
}

export default function App() {
  // Invite takeover: if URL has ?inv=<token>, show Join full-page regardless
  // of identity state. Cleared after successful claim.
  const [inviteToken, setInviteToken] = useState<string | null>(() => readInviteFromUrl());
  const [adminSignin] = useState<boolean>(() => isAdminSigninRequest());
  // Captured ONCE on mount. SignIn strips ?reset= from the URL after consuming
  // it, so we can't re-read window.location.search on later renders. This flag
  // keeps decideScreen returning signin until a full page reload (which happens
  // on successful reset via window.location.assign("/home")).
  const [resetIntent] = useState<boolean>(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("reset")
  );
  const [appState, setAppState] = useState<AppState>({ kind: "loading" });
  const route = useRoute();
  const view = pathToView(route) as View;
  const setView = (v: View) => navigate(viewToPath(v));
  const [theme, setTheme] = useState(() => {
    // One-time migration: if user is on a legacy default theme, promote them
    // to the new omnigraph look. Bump THEME_EPOCH to re-migrate later.
    const THEME_EPOCH = "2026-04-25-omnigraph";
    const epoch = localStorage.getItem("atelier.theme.epoch");
    const stored = localStorage.getItem("atelier.theme");
    if (epoch !== THEME_EPOCH) {
      localStorage.setItem("atelier.theme.epoch", THEME_EPOCH);
      // Only override if user was on the silent-default 'paper' or had nothing.
      if (!stored || stored === "paper") {
        localStorage.setItem("atelier.theme", "omnigraph");
        return "omnigraph";
      }
    }
    return stored || "omnigraph";
  });
  const [density, setDensity] = useState(() => localStorage.getItem("atelier.density") || "comfy");
  // Layout tab inside /canvas (Canvas reframe 2026-05-04, decisions §3):
  // tabs are by question, not visualization. "kanban" = Work (state board,
  // founder default), "shape" = Plan (architecture), "radial" = work tree,
  // "activity" = firehose. Key bumped to .v2 so pre-reframe persisted "shape"
  // values don't override the new founder-default Work landing.
  const [canvasLayout, setCanvasLayout] = useState<"shape" | "radial" | "kanban" | "activity">(() => {
    const saved = localStorage.getItem("atelier.canvas.v2");
    if (saved === "shape" || saved === "radial" || saved === "kanban" || saved === "activity") return saved;
    return "kanban";
  });
  // Landing preference for an authed founder hitting "/". Default "canvas"
  // (the workspace's center of gravity). When the founder explicitly opts
  // back to home via the one-time landing toast, the choice is recorded
  // here. `null` means no choice yet → toast surfaces on first canvas land.
  const [landingChoice, setLandingChoice] = useState<LandingPreference | null>(() => {
    const v = localStorage.getItem("atelier.landing.choice");
    return v === "canvas" || v === "home" ? v : null;
  });
  const landingPreference: LandingPreference = landingChoice ?? "canvas";
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const [orgs, setOrgs] = useState<OrgListEntry[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(() =>
    localStorage.getItem("atelier.activeOrgId"));
  const [wsStatus, setWsStatus] = useState<ChatStatus>("connecting");
  const [canvasInitialNode, setCanvasInitialNode] = useState<string | null>(null);
  const tweaksRef = useRef<HTMLDivElement>(null);

  // Background-task notifications (reflection worker → ribbon slot)
  interface BgTask { id: string; kind: string; summary: string; startedAt: number; doneAt?: number; ok?: boolean; }
  const [bgTasks, setBgTasks] = useState<BgTask[]>([]);

  // Background-task notifications. Subscribes to the shared notifications socket
  // (see ./lib/notifications-socket) — single underlying WS, multiple listeners.
  // ImplementerLiveFeed subscribes to the same module, so we no longer race-open
  // two sockets under StrictMode.
  useEffect(() => {
    if (appState.kind !== "ready") return;
    const unsub = subscribeNotifications((parsed) => {
      if (!parsed || typeof parsed !== "object") return;
      const msg = parsed as { type?: string; sessionId?: string; nodeId?: string; kind?: string; summary?: string; ok?: boolean };
      // Disambiguator preference: sessionId (reflection worker) → nodeId
      // (implementer auto-poller, which has no sessionId) → wall clock as a
      // last-resort uniquifier. Without nodeId fallback, auto-poller `done`
      // events couldn't find their `started` chip and chips accumulated forever.
      const id = msg.sessionId ?? msg.nodeId ?? String(Date.now());
      if (msg.type === "task.started") {
        setBgTasks(prev => {
          // Cap visible chips at 5 newest so an aggressive poller can never
          // push siblings (Shape/Radial/Kanban tabs, account menu) off-screen.
          const filtered = prev.filter(t => t.id !== id);
          const next = [...filtered, { id, kind: msg.kind ?? "task", summary: msg.summary ?? "", startedAt: Date.now() }];
          return next.length > 5 ? next.slice(next.length - 5) : next;
        });
      } else if (msg.type === "task.done") {
        setBgTasks(prev => prev.map(t => t.id === id ? { ...t, doneAt: Date.now(), ok: !!msg.ok } : t));
        // Auto-clear after 4s
        setTimeout(() => setBgTasks(prev => prev.filter(t => t.id !== id)), 4000);
      }
    });
    return () => { unsub(); };
  }, [appState.kind]);

  useEffect(() => {
    if (!tweaksOpen) return;
    function onDoc(e: MouseEvent) {
      const el = e.target as HTMLElement;
      if (tweaksRef.current?.contains(el)) return;
      if (el.closest(".ribbon-tweaks")) return;
      setTweaksOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [tweaksOpen]);

  // Load orgs whenever the menu opens (or auth state flips to ready)
  useEffect(() => {
    if (appState.kind !== "ready" && !accountOpen) return;
    listOrgs().then(o => {
      setOrgs(o);
      if (!activeOrgId && o.length > 0) {
        setActiveOrgId(o[0].id);
        localStorage.setItem("atelier.activeOrgId", o[0].id);
      }
    }).catch(() => { /* ignore — gracefully empty */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState.kind, accountOpen]);

  // Close account menu on outside click + Escape
  useEffect(() => {
    if (!accountOpen) return;
    function onDoc(e: MouseEvent) {
      const el = e.target as HTMLElement;
      if (accountRef.current?.contains(el)) return;
      if (el.closest(".ribbon-account-trigger")) return;
      setAccountOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setAccountOpen(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountOpen]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("atelier.theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
    localStorage.setItem("atelier.density", density);
  }, [density]);

  // Note: view is intentionally NOT persisted to localStorage. Every fresh boot lands on Home
  // (control center), from which the founder chooses where to go.

  useEffect(() => {
    // Identity precedence:
    //   /me  — auth'd user record (display_name, email). Source of truth for
    //          who is signed in on THIS device.
    //   /onboarding/state — agent config (agent_name, active_project, org_name).
    //          Source of project/agent context. Its founder_name field is
    //          legacy (single-user era) and must NOT be displayed when /me
    //          returns a user — otherwise multi-user installs would always
    //          show the legacy admin's name to everyone.
    Promise.all([
      getMe().catch(() => ({ user: null, memberships: [] as { org_id: string; org_name: string; role: string }[] })),
      getOnboardingState().catch(() => null),
    ]).then(([me, s]) => {
      const isAuthed = !!me?.user;
      if (!s) {
        setAppState({ kind: "onboarding", isAuthed });
        return;
      }
      if (s.configured && s.agent_name && s.active_project) {
        // Prefer /me for the human's name + the org from /me's memberships.
        const meUser = me?.user ?? null;
        const founderName = meUser?.display_name ?? s.founder_name ?? "";
        // First admin/founder/member membership the user has → that's the org
        // we display; switcher in the menu lets them swap.
        const myOrg = me?.memberships?.[0]?.org_name ?? s.org_name ?? null;
        setAppState({
          kind: "ready",
          agentName: s.agent_name,
          founderName,
          activeProject: s.active_project,
          orgName: myOrg,
          pickupFlavor: s.pickup_flavor ?? null,
        });
      } else if (s.previous_identity) {
        setAppState({ kind: "welcome-back", previous: s.previous_identity });
      } else {
        setAppState({ kind: "onboarding", isAuthed });
      }
    }).catch(() => {
      // Backend unreachable — drop to Landing instead of a stuck error screen.
      setAppState({ kind: "onboarding", isAuthed: false });
    });
  }, []);

  // F4: refetch active_project when the window gets focus. Catches out-of-band
  // project switches — another tab calling /projects/switch, an external
  // script, the CLI flipping config.yaml. Without this, the SPA's view of
  // the active project goes stale until full reload.
  useEffect(() => {
    function onFocus() {
      getOnboardingState().then((s) => {
        const next = s?.active_project;
        if (next) {
          setAppState((prev) =>
            prev.kind === "ready" && prev.activeProject !== next
              ? { ...prev, activeProject: next }
              : prev,
          );
        }
      }).catch(() => { /* ignore — focus refetch is best-effort */ });
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Routing decision — single source of truth. Inputs (route, query flags,
  // appState) flow through one function and produce one of seven screen
  // outcomes. Render below is a pure switch; URL side-effects are batched
  // into one useEffect so we never render-then-redirect.
  //
  // Permutation table: see decideScreen() body. The order of checks IS the
  // priority. If you add a new screen, add it there, not as a parallel
  // branch in render.
  // ──────────────────────────────────────────────────────────────────────────
  const screen = decideScreen({ route, inviteToken, adminSignin, appState, landingPreference, resetIntent });

  // URL normalization in one place. If the decision implies a different
  // canonical URL than what's in the address bar, replaceState. No
  // navigate-and-return-null patterns; render proceeds with the decision.
  useEffect(() => {
    const want = canonicalPathFor(screen);
    if (want && window.location.pathname !== want) {
      window.history.replaceState({}, "", want + window.location.search);
    }
  }, [screen.kind]);

  switch (screen.kind) {
    case "loading":
      return <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", fontFamily:"var(--font-mono)", color:"var(--a-mute)", letterSpacing:"0.1em", background:"var(--a-page)" }}>atelier</div>;

    case "join":
      return (
        <Join
          inviteToken={screen.inviteToken}
          onClaimed={() => {
            const url = new URL(window.location.href);
            url.searchParams.delete("inv");
            window.history.replaceState({}, "", url.toString());
            setInviteToken(null);
            window.location.reload();
          }}
        />
      );

    case "landing":
      return <Landing isAuthed={screen.isAuthed} />;

    case "signin":
      return <SignIn />;

    case "welcome-back":
      return (
        <WelcomeBack
          previous={screen.previous}
          onResume={(p) => {
            setAppState({
              kind: "ready",
              agentName: p.agent_name,
              founderName: p.founder_name ?? "",
              activeProject: p.active_project,
              orgName: p.org_name ?? null,
              pickupFlavor: null,
            });
            navigate(HOME_PATH);
            getOnboardingState().then(s => {
              setAppState(prev => prev.kind === "ready" ? { ...prev, pickupFlavor: s.pickup_flavor ?? null } : prev);
            }).catch(() => {});
          }}
          onStartFresh={() => {
            setAppState({ kind: "onboarding" });
            navigate("/?signin=admin");
          }}
        />
      );

    case "onboarding":
      return (
        <Onboarding
          onDone={(agentName, founderName, activeProject) => {
            setAppState({ kind: "ready", agentName, founderName, activeProject, orgName: null, pickupFlavor: null });
            navigate(HOME_PATH);
            getOnboardingState().then(s => {
              setAppState(prev => prev.kind === "ready" ? { ...prev, orgName: s.org_name ?? null } : prev);
            }).catch(() => {});
          }}
        />
      );

    case "shell":
      // fall through to the existing shell render below — it depends on the
      // assertion that appState.kind === "ready", which decideScreen guards.
      break;
  }

  // Type narrowing: by construction screen.kind === "shell" implies
  // appState.kind === "ready". This guard makes TS see it too.
  if (appState.kind !== "ready") return null;

  const { agentName, founderName, activeProject, orgName, pickupFlavor } = appState;
  const agentState = wsToAgentState(wsStatus);

  const railItems: { key: View; label: string; icon: React.ReactNode }[] = [
    { key: "home",        label: "home",        icon: Ico.home },
    { key: "now",         label: "now",         icon: Ico.now },
    { key: "backlog",     label: "backlog",     icon: Ico.backlog },
    { key: "implementer", label: "implementer", icon: Ico.implementer },
    { key: "canvas",      label: "canvas",      icon: Ico.canvas },
    { key: "brain",     label: "brain",     icon: Ico.brain },
    { key: "approvals", label: "approvals", icon: Ico.approvals },
    { key: "world",     label: "world",     icon: Ico.world },
    { key: "reflect",   label: "reflect",   icon: Ico.reflect },
    { key: "settings",  label: "settings",  icon: Ico.settings },
  ];

  async function handleLogout() {
    // Revoke γ cookie + clear legacy flag in one call. Best-effort; failures
    // are non-fatal because the worst case is a stale cookie that the next
    // request rejects on its own.
    try { await logoutSoft(); } catch { /* ignore */ }
    getOnboardingState()
      .then(s => {
        if (s.previous_identity) {
          setAppState({ kind: "welcome-back", previous: s.previous_identity });
        } else {
          setAppState({ kind: "onboarding" });
        }
      })
      .catch(() => setAppState({ kind: "onboarding" }));
    // Navigate to "/". decideScreen will then route to either WelcomeBack
    // (if previous_identity exists — the common case for a logged-out
    // returning user) or Landing (if everything is wiped). This is the
    // load-bearing line: returning users see "continue as you" instead of
    // being forced through onboarding.
    navigate("/");
  }

  function handleActiveProjectChanged(name: string) {
    setAppState(prev => prev.kind === "ready" ? { ...prev, activeProject: name } : prev);
  }

  function handleOrgNameChanged(name: string) {
    setAppState(prev => prev.kind === "ready" ? { ...prev, orgName: name } : prev);
  }

  return (
    <div className="shell">
      <header className="brand" role="banner">atelier</header>
      {landingChoice === null && screen.kind === "shell" && screen.view === "canvas" && (
        <LandingMovedToast
          onChoose={(choice) => {
            localStorage.setItem("atelier.landing.choice", choice);
            setLandingChoice(choice);
            if (choice === "home") navigate(HOME_PATH);
          }}
        />
      )}

      <div className="ribbon" role="navigation" aria-label="Workspace ribbon">
        <div className="ribbon-crumb">
          <span className="proj">{activeProject}</span>
        </div>
        <div className="ribbon-divider ribbon-crumb-meta" />
        <div className="ribbon-session" data-state={agentState}>
          <span className="lamp" />
          <span>{agentName} · {agentState}</span>
        </div>
        <div className="ribbon-divider ribbon-crumb-meta" />
        <div className="ribbon-crumb-meta">session · live</div>
        <div className="ribbon-right">
          {bgTasks.length > 0 && (
            <div className="ribbon-bgtasks" title="background tasks">
              {bgTasks.map(t => (
                <span key={t.id} className="ribbon-bgtask" data-done={t.doneAt ? "1" : "0"} data-ok={t.ok === false ? "0" : "1"}>
                  <span className="bgtask-dot" />
                  {t.doneAt ? (t.ok === false ? "failed" : "done") : t.summary}
                </span>
              ))}
            </div>
          )}
          {view === "canvas" && (
            <div style={{ display: "flex", gap: 4, background: "var(--a-paper)", padding: 3, borderRadius: 4, border: "1px solid var(--a-line)" }}>
              {/* Canvas reframe (2026-05-04 + Plan redesign 2026-05-05):
                  tabs by question, not visualization. radial retired as a
                  top-level peer — it now lives inside Plan as a sub-toggle
                  alongside Tree (default) and 3D. */}
              {([
                { key: "shape", label: "plan" },
                { key: "kanban", label: "work" },
                { key: "activity", label: "activity" },
              ] as const).map(t => (
                <button
                  key={t.key}
                  className={`tweak-chip ${canvasLayout === t.key ? "on" : ""}`}
                  onClick={() => { setCanvasLayout(t.key); localStorage.setItem("atelier.canvas.v2", t.key); }}
                >{t.label}</button>
              ))}
              {canvasLayout === "kanban" && (
                <button
                  className="tweak-chip"
                  title="Fire one auto-poller tick now (skip the 30s wait). Honors auto_run/dry_run."
                  onClick={async () => {
                    try {
                      const r = await fetch(`${BASE_URL}/implementer/auto-poller/tick`, { method: "POST" });
                      const d = await r.json().catch(() => ({}));
                      console.log("[nudge]", d);
                    } catch (e) { console.warn("[nudge] failed", e); }
                  }}
                  style={{ marginLeft: 6, borderColor: "var(--sem-blue)", color: "var(--sem-blue)" }}
                >nudge</button>
              )}
            </div>
          )}
          {view === "canvas" && <div className="ribbon-divider" />}
          <button
            className="ribbon-tweaks"
            onClick={() => setTweaksOpen(o => !o)}
            title="Open Tweaks (theme, density, debug)"
            style={{ marginLeft: 4 }}
          >tweaks</button>
          <button
            type="button"
            className="ribbon-role ribbon-account-trigger"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setAccountOpen(o => !o); }}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
          >
            <span className="dot" />{founderName || "you"}
            <span className="account-caret" aria-hidden>▾</span>
          </button>
        </div>
      </div>

      {accountOpen && createPortal(
        <div className="account-menu" ref={accountRef} role="menu">
          <div className="account-head">
            <div className="account-name">{founderName}</div>
            {orgName && <div className="account-org">{orgName}</div>}
          </div>
          {orgs.length > 0 && (
            <div className="account-section">
              <div className="account-section-label">Workspaces</div>
              {orgs.map(o => (
                <button
                  key={o.id}
                  className={`account-item account-item-org ${activeOrgId === o.id ? "is-active" : ""}`}
                  onClick={() => {
                    setActiveOrgId(o.id);
                    localStorage.setItem("atelier.activeOrgId", o.id);
                    setAccountOpen(false);
                    // Hard reload so backend/agent picks up the new active org context.
                    window.location.reload();
                  }}
                >
                  <span className="account-item-icon">{activeOrgId === o.id ? "●" : "○"}</span>
                  <span className="account-item-text">{o.name}</span>
                  <span className="account-item-meta">{o.role}</span>
                </button>
              ))}
            </div>
          )}
          {orgs.length > 0 && <div className="account-divider" />}
          <div className="account-section">
            <button className="account-item" onClick={() => { setAccountOpen(false); setView("settings"); }}>
              <span className="account-item-icon">⚙</span>
              <span>Account &amp; settings</span>
            </button>
          </div>
          <div className="account-divider" />
          <div className="account-section">
            <button
              className="account-item account-item-danger"
              onClick={() => { setAccountOpen(false); handleLogout(); }}
            >
              <span className="account-item-icon">⎋</span>
              <span>Sign out</span>
            </button>
          </div>
        </div>,
        document.body
      )}

      <aside className="rail" aria-label="Primary navigation">
        <div className="rail-items" role="navigation" aria-label="Primary rail">
          {railItems.map(r => (
            <button key={r.key} className={`rail-item ${view === r.key ? "active" : ""}`} onClick={() => setView(r.key)}>
              {r.icon}
              <span>{r.label}</span>
            </button>
          ))}
        </div>
        <div className="rail-foot">{founderName}</div>
      </aside>

      <main className={`view ${view !== "now" && view !== "canvas" && view !== "implementer" && view !== "brain" ? "view--scroll" : ""}`}>
        {/* Now stays mounted across navigation — preserves WS session + chat history */}
        <div style={{ position: "absolute", inset: 0, display: view === "now" ? "block" : "none" }}>
          <Now
            agentName={agentName}
            founderName={founderName}
            activeProject={activeProject}
            pickupFlavor={pickupFlavor}
            onWsStatus={setWsStatus}
            onOpenCanvas={(nodeId) => {
              setCanvasInitialNode(nodeId ?? null);
              setView("canvas");
            }}
            onEndSession={() => setView("reflect")}
          />
        </div>
        {view === "home" && (
          <Home
            agentName={agentName}
            founderName={founderName}
            activeProject={activeProject}
            orgName={orgName}
            onEnterWorkspace={() => setView("now")}
            onActiveProjectChanged={handleActiveProjectChanged}
            onOrgNameChanged={handleOrgNameChanged}
            onGoto={(v) => setView(v)}
          />
        )}
        {view === "canvas" && (
          <Canvas
            project={activeProject}
            baseUrl={BASE_URL}
            layout={canvasLayout}
            initialSelectedId={canvasInitialNode}
          />
        )}
        {view === "backlog" && (
          <Backlog
            project={activeProject}
            onOpenInCanvas={(nodeId) => { setCanvasInitialNode(nodeId); setView("canvas"); }}
          />
        )}
        {view === "implementer" && <Implementer project={activeProject} />}
        {view === "brain" && <Brain baseUrl={BASE_URL} project={activeProject} />}
        {view === "approvals" && <Approvals project={activeProject} />}
        {view === "world" && <World />}
        {view === "reflect" && <Reflection project={activeProject} onNavigateToNow={() => setView("now")} />}
        {view === "settings" && (
          <Settings
            agentName={agentName}
            founderName={founderName}
            activeProject={activeProject}
            theme={theme}
            setTheme={setTheme}
            density={density}
            setDensity={setDensity}
          />
        )}
        {view === "diagnostics" && <Diagnostics />}
      </main>

      {tweaksOpen && (
        <div className="tweaks" ref={tweaksRef}>
          <div className="tweaks-head">
            <h4>Tweaks</h4>
            <button className="close" onClick={() => setTweaksOpen(false)}>close</button>
          </div>
          <div className="tweaks-body">
            <div className="tweak-row">
              <div className="tweak-label">aesthetic</div>
              <div className="tweak-chips">
                {["omnigraph","paper","midnight","ash","fog","oat","deep","executive","hybrid","sage"].map(t => (
                  <button key={t} className={`tweak-chip ${theme === t ? "on" : ""}`} onClick={() => setTheme(t)}>{t}</button>
                ))}
              </div>
            </div>
            <div className="tweak-row">
              <div className="tweak-label">density</div>
              <div className="tweak-chips">
                {["comfy","compact"].map(d => (
                  <button key={d} className={`tweak-chip ${density === d ? "on" : ""}`} onClick={() => setDensity(d)}>{d}</button>
                ))}
              </div>
            </div>
            <div className="tweak-row">
              <div className="tweak-label">canvas</div>
              <div className="tweak-chips">
                {([
                  { key: "shape", label: "plan" },
                  { key: "kanban", label: "work" },
                  { key: "activity", label: "activity" },
                ] as const).map(t => (
                  <button key={`tweak-${t.key}`} className={`tweak-chip ${canvasLayout === t.key ? "on" : ""}`} onClick={() => { setCanvasLayout(t.key); localStorage.setItem("atelier.canvas.v2", t.key); }}>{t.label}</button>
                ))}
              </div>
            </div>
            <div className="tweak-row">
              <div className="tweak-label">screen</div>
              <div className="tweak-chips">
                {(["home","now","backlog","canvas","brain","approvals","world","reflect","settings"] as View[]).map(s => (
                  <button key={s} className={`tweak-chip ${view === s ? "on" : ""}`} onClick={() => { setView(s); setTweaksOpen(false); }}>{s}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="tweaks-foot">local only · survives reload</div>
        </div>
      )}
    </div>
  );
}

/**
 * One-shot toast surfaced when an authed founder lands on Canvas because
 * Canvas is now the default landing surface. Two choices, both persisted
 * to localStorage so this never appears again:
 *   - "stay" → keeps Canvas as landing (silent on subsequent visits)
 *   - "back to home" → records the home preference and navigates there
 */
function LandingMovedToast({ onChoose }: { onChoose: (choice: LandingPreference) => void }) {
  // Auto-dismiss after 12s — same effect as "stay on canvas" (the user is
  // already on /canvas, so persisting that choice is a no-op for them; the
  // toast just stops nagging on every reload). Founders who actually want
  // /home back can click "back to /home"; the rest get out of the way.
  useEffect(() => {
    const t = window.setTimeout(() => onChoose("canvas"), 12000);
    return () => window.clearTimeout(t);
  }, [onChoose]);
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        maxWidth: 320,
        padding: "10px 12px",
        borderRadius: 6,
        background: "var(--a-paper-2, #1a1a1a)",
        border: "1px solid var(--a-line)",
        boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
        color: "var(--a-ink)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--t-1)",
        lineHeight: 1.45,
        // Below modals (1000) and the canvas drawer panel (60) so it never
        // overlaps the founder's primary work surface; sits above page chrome.
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <button
        type="button"
        onClick={() => onChoose("canvas")}
        title="Dismiss"
        aria-label="Dismiss"
        style={{
          position: "absolute", top: 4, right: 6,
          background: "transparent", border: 0, color: "var(--a-mute)",
          cursor: "pointer", fontSize: "0.85rem", lineHeight: 1, padding: 2,
        }}
      >×</button>
      <div style={{ paddingRight: 14 }}>
        We moved your landing surface to <strong style={{ color: "var(--a-accent)" }}>/canvas</strong>.
        Diagnostics still live at <code>/settings/diagnostics</code>.
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button className="impl-btn-secondary" onClick={() => onChoose("home")} style={{ fontSize: "0.7rem" }}>back to /home</button>
        <button className="impl-btn-primary" onClick={() => onChoose("canvas")} style={{ fontSize: "0.7rem" }}>got it</button>
      </div>
    </div>,
    document.body
  );
}
