import { useEffect, useState } from "react";

/** Tiny path-based router. No deps, no context. The whole app reads `useRoute()`
 *  and calls `navigate(path)` to push history. Vite serves index.html for every
 *  unmatched path in dev, so deep-link refresh works out of the box.
 *
 *  We only care about the pathname here — query string is read independently
 *  by callers that need it (?inv=, ?signin=, ?node=).
 */

export function useRoute(): string {
  const [path, setPath] = useState<string>(() =>
    typeof window === "undefined" ? "/" : window.location.pathname
  );

  useEffect(() => {
    function onPop() { setPath(window.location.pathname); }
    window.addEventListener("popstate", onPop);
    window.addEventListener("atelier:navigate", onPop as EventListener);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("atelier:navigate", onPop as EventListener);
    };
  }, []);

  return path;
}

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const url = new URL(path, window.location.origin);
  if (window.location.pathname === url.pathname && window.location.search === url.search) return;
  if (opts.replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
  window.dispatchEvent(new Event("atelier:navigate"));
}

/** Stable mapping pathname ↔ authed view. Anything not in this map falls back
 *  to "home". The reverse direction is used when rail buttons are clicked. */
export const VIEW_PATHS: Record<string, string> = {
  "/home":         "home",
  "/now":          "now",
  "/backlog":      "backlog",
  "/implementer":  "implementer",
  "/canvas":       "canvas",
  "/brain":        "brain",
  "/approvals":    "approvals",
  "/world":        "world",
  "/reflect":      "reflect",
  "/settings":     "settings",
  "/settings/diagnostics": "diagnostics",
};

export function pathToView(pathname: string): string {
  return VIEW_PATHS[pathname] ?? "home";
}

// Reverse of VIEW_PATHS, computed once. Lets viewToPath produce the canonical
// pathname even for non-trivial mappings like diagnostics → /settings/diagnostics.
const PATH_FOR_VIEW: Record<string, string> = Object.fromEntries(
  Object.entries(VIEW_PATHS).map(([path, view]) => [view, path])
);

export function viewToPath(view: string): string {
  return PATH_FOR_VIEW[view] ?? `/${view}`;
}

export const LANDING_PATH = "/landing";
export const HOME_PATH = "/home";

/** Public paths that bypass every auth state branch. Rendered identically
 *  whether the visitor is signed in, soft-logged-out, or unconfigured. */
export const PUBLIC_PATHS = new Set<string>(["/landing", "/signin"]);

export function isLandingPath(pathname: string): boolean {
  return pathname === "/landing";
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

export function isAuthedPath(pathname: string): boolean {
  return pathname in VIEW_PATHS;
}
