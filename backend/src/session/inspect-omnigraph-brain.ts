/**
 * Brain v2 inspector — surfaces the 3-layer brain artifacts as separate
 * documents (the contract is "do not mix"). Reuses `loadOmnigraphBrain` for
 * the merged-injection footprint so per-layer reads and the boot path can
 * never drift.
 *
 * Returns per-layer XML, bytes, mtime, and source attribution so the founder
 * can answer "what does the agent actually see at session boot".
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";
import { brainLayerFlagsFromEnv, loadOmnigraphBrain } from "./load-omnigraph-brain";

export interface BrainLayerView {
  exists: boolean;
  path: string;
  xml: string | null;
  bytes: number;
  mtime: string | null;
  source: "user" | "default-fallback" | null;
}

export interface BrainProjectLayerView {
  exists: boolean;
  path: string;
  xml: string | null;
  bytes: number;
  mtime: string | null;
  source: "shared" | "per-user-fallback" | null;
  projectName: string;
  isShared: boolean;
}

export interface BrainInspection {
  userId: string;
  effectiveUserId: string;
  global: BrainLayerView;
  personal: BrainLayerView;
  project: BrainProjectLayerView | null;
  injectFlags: { includeGlobal: boolean; includePersonal: boolean; includeProject: boolean };
  wrapperBytes: number;
  totalInjectedBytes: number;
  totalInjectedLayers: { global: boolean; personal: boolean; project: string | null };
}

function slugForProject(project: string): string {
  return project.toLowerCase().trim().replaceAll(" ", "-").replaceAll("/", "-");
}

function compiledDirFor(userId: string): string {
  return resolve(config.dataDir, "users", userId, "brain", "personal", "compiled");
}

function statSafe(p: string): { mtime: string; bytes: number } | null {
  try {
    if (!existsSync(p)) return null;
    const s = statSync(p);
    return { mtime: s.mtime.toISOString(), bytes: s.size };
  } catch { return null; }
}

function readSafe(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf-8");
  } catch { return null; }
}

export function inspectOmnigraphBrain(userId: string, projectName?: string | null): BrainInspection {
  const flags = brainLayerFlagsFromEnv();
  let compiled = compiledDirFor(userId);
  let effective = userId;

  // Mirror loader's fallback to "default" when the requested user has no
  // artifacts. Single source of truth lives in load-omnigraph-brain.ts; we
  // duplicate the path test (not the fallback decision) so per-layer reads
  // attribute correctly.
  if (
    userId !== "default" &&
    !existsSync(resolve(compiled, "light_ir.global.xml")) &&
    !existsSync(resolve(compiled, "light_ir.personal.xml"))
  ) {
    const fb = compiledDirFor("default");
    if (
      existsSync(resolve(fb, "light_ir.global.xml")) ||
      existsSync(resolve(fb, "light_ir.personal.xml"))
    ) {
      compiled = fb;
      effective = "default";
    }
  }

  const globalPath = resolve(compiled, "light_ir.global.xml");
  const personalPath = resolve(compiled, "light_ir.personal.xml");
  const gStat = statSafe(globalPath);
  const pStat = statSafe(personalPath);

  const sourceTag: "user" | "default-fallback" = effective === userId ? "user" : "default-fallback";

  const global: BrainLayerView = {
    exists: !!gStat,
    path: globalPath,
    xml: readSafe(globalPath),
    bytes: gStat?.bytes ?? 0,
    mtime: gStat?.mtime ?? null,
    source: gStat ? sourceTag : null,
  };
  const personal: BrainLayerView = {
    exists: !!pStat,
    path: personalPath,
    xml: readSafe(personalPath),
    bytes: pStat?.bytes ?? 0,
    mtime: pStat?.mtime ?? null,
    source: pStat ? sourceTag : null,
  };

  let project: BrainProjectLayerView | null = null;
  if (projectName) {
    const slug = slugForProject(projectName);
    const sharedPath = resolve(config.projectsDir, projectName, "brain.xml");
    const perUserPath = resolve(compiled, "projects", slug, "brain.xml");
    const sharedStat = statSafe(sharedPath);
    const perUserStat = statSafe(perUserPath);
    const usingShared = !!sharedStat;
    const usedPath = usingShared ? sharedPath : perUserPath;
    const usedStat = usingShared ? sharedStat : perUserStat;
    project = {
      exists: !!usedStat,
      path: usedPath,
      xml: readSafe(usedPath),
      bytes: usedStat?.bytes ?? 0,
      mtime: usedStat?.mtime ?? null,
      source: usedStat ? (usingShared ? "shared" : "per-user-fallback") : null,
      projectName,
      isShared: usingShared,
    };
  }

  // Reuse the real loader so the injected-footprint number can never drift
  // from what session boot actually sends to the CLI subprocess.
  const merged = loadOmnigraphBrain(userId, projectName ?? null, flags);
  const totalInjectedBytes = merged?.bytes ?? 0;
  const totalInjectedLayers = merged?.layersLoaded ?? { global: false, personal: false, project: null };

  // Wrapper size = merged total minus per-layer XML bytes contributing to
  // this injection. Approximate (whitespace etc.) but useful as a budget cue.
  const layerSum =
    (flags.includeGlobal && global.exists ? global.bytes : 0) +
    (flags.includePersonal && personal.exists ? personal.bytes : 0) +
    (flags.includeProject && project?.exists ? (project?.bytes ?? 0) : 0);
  const wrapperBytes = Math.max(0, totalInjectedBytes - layerSum);

  return {
    userId,
    effectiveUserId: effective,
    global,
    personal,
    project,
    injectFlags: flags,
    wrapperBytes,
    totalInjectedBytes,
    totalInjectedLayers,
  };
}
