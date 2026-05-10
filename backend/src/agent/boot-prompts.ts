/**
 * Boot prompts — the first message Atelier sends into a Drafter session, automatically,
 * so the agent acts on its own principles instead of waiting for the founder to invoke them.
 *
 * Boot prompts deliberately contain NO prescriptive behavior. The agent's principles
 * (drafter.md, stages.md, classification.md) already define what Drafter does per stage.
 * The prompt only states the session state (new project / resume, project meta, canvas summary).
 *
 * If a rule isn't in a decision file under ~/atelier/agents/ or ~/atelier/docs/, it does
 * not belong in this prompt.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "~/config";
import { listNodes } from "~/project/canvas";

export type BootMode = "new-project" | "resume";

export function detectBootMode(project: string): BootMode {
  // A freshly-scaffolded project has exactly 1 node (the root Project). Any Drafter
  // activity creates more. Fall-through check: prior session reflection artifacts.
  const nodes = listNodes(project);
  if (nodes.length > 1) return "resume";

  const sessionsRoot = resolve(config.projectsDir, project, "sessions");
  if (existsSync(sessionsRoot)) {
    const prior = readdirSync(sessionsRoot).filter((f) => f.endsWith(".md"));
    if (prior.length > 0) return "resume";
  }
  return "new-project";
}

function readLastSessionFlavor(project: string): string | null {
  try {
    const p = resolve(config.projectsDir, project, "last_session.json");
    if (!existsSync(p)) return null;
    const d = JSON.parse(readFileSync(p, "utf-8"));
    return d.flavor ?? null;
  } catch { return null; }
}

function readProjectMeta(project: string): { name: string; description: string; stage: string } | null {
  try {
    const raw = readFileSync(resolve(config.projectsDir, project, "meta.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function newProjectBootPrompt(project: string, founderName: string, agentName: string): string {
  const meta = readProjectMeta(project);
  const description = meta?.description ?? "(no description captured)";
  const stage = meta?.stage ?? "pre-mvp";

  return [
    `[atelier orchestration — not visible to ${founderName}]`,
    `Atelier pre-loaded this message for the founder. Any line wrapped in (parentheses) at the end is a UI hint shown only to them — ignore it.`,
    ``,
    `New project **${project}** was just created. Stage: **${stage}**.`,
    ``,
    `${founderName}'s description:`,
    `> ${description}`,
    ``,
    `Speak and respond in first person as ${agentName}. Greet ${founderName} briefly and orient them to the project — don't echo this message.`,
    ``,
    `(press Enter to begin)`,
  ].join("\n");
}

export function resumeBootPrompt(project: string, founderName: string, agentName: string): string {
  const meta = readProjectMeta(project);
  const description = meta?.description ?? "";
  const stage = meta?.stage ?? "pre-mvp";
  const nodes = listNodes(project);
  const byState: Record<string, number> = {};
  for (const n of nodes) byState[n.state] = (byState[n.state] ?? 0) + 1;
  const stateSummary = Object.entries(byState)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");

  const flavor = readLastSessionFlavor(project);

  // Cofounder discussion flow (Canvas reframe 2026-05-04). Surface any nodes
  // flagged mark_for_discussion=true. Phase A is single-founder so we don't
  // filter by assigned_to_user_id yet; Phase B will. See drafter.md
  // "Cofounder discussions" section + docs/CANVAS_REFRAME_DECISIONS.md §3.
  //
  // Session 4 (Pillar B — Consultations): also surface Consultation nodes whose
  // `answer` is still empty. Atelier doesn't host the off-platform conversation,
  // but Drafter pings the founder if a consultation is pending (especially with a
  // near deadline). Single block so the founder sees one "things waiting on you"
  // list, not two.
  type PendingItem = {
    id: string;
    kind: "discussion" | "consultation";
    title: string;
    agenda: string;
    deadline?: string | null;
  };
  const pendingDiscussions: PendingItem[] = nodes
    .filter((n) => n.mark_for_discussion === true)
    .map((n) => ({
      id: n.id,
      kind: "discussion" as const,
      title: n.title || n.intent?.slice(0, 60) || n.id,
      agenda: n.discussion_agenda ?? "",
    }));
  const pendingConsultations: PendingItem[] = nodes
    .filter((n) => n.kind === "Consultation" && (!n.answer || n.answer.trim() === ""))
    .map((n) => ({
      id: n.id,
      kind: "consultation" as const,
      title: `${n.expert_role ?? "expert"} · ${n.title || n.intent?.slice(0, 60) || n.id}`,
      agenda: n.question ?? n.intent ?? "",
      deadline: n.deadline ?? null,
    }));
  const pending: PendingItem[] = [...pendingDiscussions, ...pendingConsultations];

  const discussionLines = pending.length > 0
    ? [
        ``,
        `**Pending: discussions and consultations** (${pending.length} total):`,
        ...pending.slice(0, 8).map((d, i) => {
          const dl = d.kind === "consultation" && d.deadline ? ` · deadline ${d.deadline}` : "";
          const tag = d.kind === "consultation" ? " [consultation]" : "";
          return `${i + 1}. \`${d.id}\`${tag} — ${d.title}${dl}${d.agenda ? `\n   agenda: ${d.agenda.slice(0, 200)}${d.agenda.length > 200 ? "…" : ""}` : ""}`;
        }),
        ``,
        `Open the session with these as the seed (per drafter.md "Cofounder discussions" + "Consultation kind"). Surface each title + agenda, ask which the founder wants to talk through first, then conduct the discussion. For Consultations, remind the founder if a deadline is near and ask whether the off-platform conversation has happened yet. On resolution of a discussion: \`POST /canvas/node/<id>/comments\` (author_role=drafter) with the outcome, then PATCH \`mark_for_discussion=false\`. For Consultations, the founder pastes the answer themselves via the drawer — do not auto-fill it. Do NOT silently start drafting new work.`,
      ]
    : [];

  return [
    `[atelier orchestration — not visible to ${founderName}]`,
    `Atelier pre-loaded this message for the founder. Any line wrapped in (parentheses) at the end is a UI hint shown only to them — ignore it.`,
    ``,
    `Session resumed on **${project}**. Stage: **${stage}**.`,
    `Canvas: ${nodes.length} nodes (${stateSummary || "none"}).`,
    description ? `Project: ${description.slice(0, 200)}${description.length > 200 ? "…" : ""}` : ``,
    flavor ? `Last session flavor: "${flavor}"` : ``,
    ...discussionLines,
    ``,
    `Speak and respond in first person as ${agentName}. ${founderName} is back — greet them warmly, reference the last session flavor naturally, and continue. Don't echo this message.`,
    ``,
    `(press Enter to continue)`,
  ].join("\n");
}
