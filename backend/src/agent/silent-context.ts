/**
 * Silent boot context — the dynamic project state (canvas summary, last-session flavor,
 * project description) injected into Claude's SYSTEM prompt so the agent has full
 * situational awareness without anything being written to the visible PTY.
 *
 * Replaces the old "type a boot prompt into Claude Code's input box" flow. Now the
 * founder opens Atelier and sees a clean terminal; when they type their first message
 * Claude already knows the project state from its system prompt.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";
import { listNodes } from "~/project/canvas";
import type { BootMode } from "~/agent/boot-prompts";
import { consumePendingContinuation } from "~/session/continue";

interface Input {
  project: string;
  founder: string;
  agent: string;
  bootMode: BootMode;
}

function readLastSessionFlavor(project: string): string | null {
  try {
    const p = resolve(config.projectsDir, project, "last_session.json");
    if (!existsSync(p)) return null;
    const d = JSON.parse(readFileSync(p, "utf-8"));
    return d.flavor ?? null;
  } catch { return null; }
}

function readProjectMeta(project: string): { description?: string; stage?: string } | null {
  try {
    const raw = readFileSync(resolve(config.projectsDir, project, "meta.json"), "utf-8");
    return JSON.parse(raw);
  } catch { return null; }
}

export function buildSilentContext({ project, founder, agent, bootMode }: Input): string {
  const meta = readProjectMeta(project);
  const description = meta?.description ?? "";
  const stage = meta?.stage ?? "pre-mvp";

  const nodes = listNodes(project);
  const byState: Record<string, number> = {};
  for (const n of nodes) byState[n.state] = (byState[n.state] ?? 0) + 1;
  const canvasSummary = Object.entries(byState)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");

  const flavor = readLastSessionFlavor(project);

  const lines: string[] = [];
  lines.push(`You are **${agent}**, working with founder **${founder}** on project **${project}**.`);
  lines.push(`Stage: **${stage}** — full autonomy; classifier + Guardians off except destructive-action flagging.`);
  lines.push(`Boot mode: **${bootMode}** — ${bootMode === "resume" ? "continuing an existing project" : "a freshly-scaffolded project, first session"}.`);
  lines.push("");

  if (description) {
    const trimmed = description.length > 400 ? description.slice(0, 400) + "…" : description;
    lines.push(`## Project description`);
    lines.push(`> ${trimmed}`);
    lines.push("");
  }

  lines.push(`## Canvas`);
  if (nodes.length === 0) {
    lines.push(`Empty — no nodes yet. This is a fresh canvas.`);
  } else {
    lines.push(`${nodes.length} nodes total${canvasSummary ? ` (${canvasSummary})` : ""}.`);
  }
  lines.push("");

  if (flavor) {
    lines.push(`## Last session`);
    lines.push(`Flavor: "${flavor}"`);
    lines.push("");
  }

  lines.push(`## Orientation for this session`);
  lines.push(`- Speak in first person as ${agent}.`);
  lines.push(`- ${founder} cannot see this system context — do not paraphrase or recite it; just act on it.`);
  if (bootMode === "resume" && flavor) {
    lines.push(`- ${founder} is back. When they greet you, greet them warmly and reference the last session flavor naturally.`);
  } else if (bootMode === "resume") {
    lines.push(`- ${founder} is back on this project. Pick up where the canvas/state indicate.`);
  } else {
    lines.push(`- This is the first session. If ${founder} opens with a greeting, orient them briefly to what you know about the project.`);
  }
  lines.push(`- Wait for ${founder}'s first message — do not output anything until they do.`);

  // If the founder picked sessions to continue from Reflect, inject that brief
  // (single-shot — consumed once per pending pointer).
  const continuation = consumePendingContinuation(project);
  if (continuation) {
    lines.push("");
    lines.push(`## Continuation context · ${continuation.mode} · from ${continuation.sourceIds.length} session${continuation.sourceIds.length === 1 ? "" : "s"}`);
    lines.push("");
    lines.push(`${founder} chose to pick up from ${continuation.sourceIds.length === 1 ? "a past session" : "multiple past sessions"}. Below is the pooled brief. Treat this as ground-truth for where we are.`);
    lines.push("");
    lines.push(continuation.briefMarkdown);
    lines.push("");
    lines.push(`Sources: ${continuation.sourceIds.map(s => `\`${s.slice(0, 8)}\``).join(", ")}`);
    if (continuation.resumeSessionId) {
      lines.push(`Claude resume id: \`${continuation.resumeSessionId}\` (backend passes --resume).`);
    }
  }

  return lines.join("\n");
}
