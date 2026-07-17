import { useEffect, useState } from "react";
import { completeOnboarding, listProjects, getMe, type ProjectListEntry } from "../lib/api";

type Step = "provider-setup" | "founder-name" | "agent-name" | "org" | "project";

const STEPS: Step[] = ["provider-setup", "founder-name", "agent-name", "org", "project"];

interface OnboardingData {
  founderName: string;
  agentName: string;
  orgName: string;
  projectName: string;
  projectDescription: string;
  provider: "claude" | "gemini" | "qwen-code" | "opencode";
}

interface Props {
  onDone: (agentName: string, founderName: string, activeProject: string) => void;
}

export function Onboarding({ onDone }: Props) {
  const [step, setStep] = useState<Step>("provider-setup");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<OnboardingData>({
    founderName: "", agentName: "", orgName: "", projectName: "", projectDescription: "", provider: "claude",
  });
  // Returning-founder support: a founder who already has projects (config was
  // reset/blank) shouldn't be forced to invent a NEW project just to get back
  // in. Fetch what already exists and offer to resume it.
  const [existingProjects, setExistingProjects] = useState<ProjectListEntry[]>([]);
  const [showNewProject, setShowNewProject] = useState(false);

  useEffect(() => {
    // Prefill the founder's name from their account so they don't re-type it.
    getMe().then(me => {
      const name = me.user?.display_name;
      const org = me.memberships?.[0]?.org_name;
      setData(d => ({
        ...d,
        founderName: d.founderName || name || "",
        orgName: d.orgName || org || "",
      }));
    }).catch(() => { /* best-effort prefill */ });
    // Discover existing projects (empty for a genuine first run).
    listProjects().then(r => setExistingProjects(r.projects ?? [])).catch(() => { /* fresh install */ });
  }, []);

  const stepIndex = STEPS.indexOf(step);

  // resumeName set → reuse an existing project (no description needed; the
  // backend reuses a project whose name already exists and does not scaffold).
  async function submit(resumeName?: string) {
    if (!data.agentName.trim()) {
      setError("Pick a name for your AI co-founder before continuing.");
      setStep("agent-name");
      return;
    }
    const projectName = resumeName ?? data.projectName;
    const projectDescription = resumeName ? "" : data.projectDescription;
    setSaving(true);
    setError(null);
    try {
      await completeOnboarding({
        agent_name: data.agentName.trim(),
        founder_name: data.founderName,
        org_name: data.orgName,
        project_name: projectName,
        project_description: projectDescription,
        provider: data.provider,
      });
      localStorage.setItem("atelier.provider", data.provider);
      onDone(data.agentName, data.founderName, projectName);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <div className="onb">
      <div className="onb-card">
        <div className="onb-brand">atelier</div>
        <div className="onb-tagline">a working environment for small founding teams with an AI co-founder</div>

        <div className="onb-steps">
          {STEPS.map((s, i) => (
            <span key={s} className={`dot ${i === stepIndex ? "active" : i < stepIndex ? "done" : ""}`} />
          ))}
        </div>

        {step === "provider-setup" && (
          <div>
            <h2>Select your AI provider</h2>
            <p>
              Atelier runs on top of powerful CLIs. It adds <em>scope gates</em>, a <em>Canvas</em>,
              and <em>memory across sessions</em> around the agent.
            </p>
            <div style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" }}>
               <button className={data.provider === "claude" ? "primary" : ""} onClick={() => setData({...data, provider: "claude"})}>Claude</button>
               <button className={data.provider === "gemini" ? "primary" : ""} onClick={() => setData({...data, provider: "gemini"})}>Gemini</button>
               <button className={data.provider === "qwen-code" ? "primary" : ""} onClick={() => setData({...data, provider: "qwen-code"})}>Qwen-Code</button>
               <button className={data.provider === "opencode" ? "primary" : ""} onClick={() => setData({...data, provider: "opencode"})}>OpenCode</button>
            </div>
            <p>
              If you're using <b>Claude</b>, run <code>claude login</code> first.<br/>
              If you're using <b>Gemini</b>, run <code>gemini auth login</code> first.<br/>
              If you're using <b>Qwen-Code</b>, point it at a local LM Studio / Ollama / vLLM endpoint via the provider config.<br/>
              If you're using <b>OpenCode</b>, run its login flow first per its docs.
            </p>
            <button className="primary" onClick={() => setStep("founder-name")}>I'm signed in — continue</button>
          </div>
        )}

        {step === "founder-name" && (
          <div>
            <h2>What should I call you?</h2>
            <p>Your name. The agent uses it, memory remembers it.</p>
            <input
              autoFocus
              placeholder="your name"
              value={data.founderName}
              onChange={e => setData({ ...data, founderName: e.target.value })}
              onKeyDown={e => e.key === "Enter" && data.founderName.trim() && setStep("agent-name")}
            />
            <button className="primary" disabled={!data.founderName.trim()} onClick={() => setStep("agent-name")}>Continue</button>
          </div>
        )}

        {step === "agent-name" && (
          <div>
            <h2>Name your agent</h2>
            <p>Pick a name for your AI co-founder. This is how they'll refer to themselves.</p>
            <div className="onb-flavor-quote">
              The soul is shared — same for everyone. Name + personality are yours, private to your config.
            </div>
            <input
              autoFocus
              required
              aria-required="true"
              placeholder="what would you like to call your agent"
              value={data.agentName}
              onChange={e => setData({ ...data, agentName: e.target.value })}
              onKeyDown={e => e.key === "Enter" && data.agentName.trim() && setStep("org")}
            />
            <button className="primary" disabled={!data.agentName.trim()} onClick={() => setStep("org")}>Continue</button>
          </div>
        )}

        {step === "org" && (
          <div>
            <h2>Create your org</h2>
            <p>You're the admin. You can invite a co-founder later — they request access and you approve.</p>
            <input
              autoFocus
              placeholder="org name"
              value={data.orgName}
              onChange={e => setData({ ...data, orgName: e.target.value })}
              onKeyDown={e => e.key === "Enter" && data.orgName.trim() && setStep("project")}
            />
            <button className="primary" disabled={!data.orgName.trim()} onClick={() => setStep("project")}>Continue</button>
          </div>
        )}

        {step === "project" && existingProjects.length > 0 && !showNewProject && (
          <div>
            <h2>Pick up where you left off</h2>
            <p>Resume one of your projects, or start a new one.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
              {existingProjects.map(p => (
                <button
                  key={p.name}
                  type="button"
                  disabled={saving}
                  onClick={() => submit(p.name)}
                  style={{
                    textAlign: "left", padding: "10px 14px", borderRadius: 4, cursor: "pointer",
                    background: "transparent", border: "1px solid var(--a-line, #1f2937)",
                    color: "var(--a-ink, #e6e8eb)", fontFamily: "var(--font-mono)", display: "flex", flexDirection: "column", gap: 3,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{p.name}{p.active ? "  ·  active" : ""}</span>
                  {p.description && (
                    <span style={{ fontSize: "var(--t-1)", color: "var(--a-mute, #6b7280)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {p.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="ghost"
              disabled={saving}
              onClick={() => setShowNewProject(true)}
            >
              + start a new project
            </button>
            {saving && <p style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", marginTop: 8, color: "var(--a-mute)" }}>Resuming…</p>}
            {error && <p style={{ color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", marginTop: 8 }}>{error}</p>}
          </div>
        )}

        {step === "project" && (existingProjects.length === 0 || showNewProject) && (
          <div>
            <h2>{existingProjects.length > 0 ? "New project" : "First project"}</h2>
            <p>What are we building, and what does <em>shipped</em> look like?</p>
            <input
              autoFocus
              placeholder="project name"
              value={data.projectName}
              onChange={e => setData({ ...data, projectName: e.target.value })}
            />
            <textarea
              placeholder="one paragraph — what is it, who is it for, what does shipped mean"
              value={data.projectDescription}
              onChange={e => setData({ ...data, projectDescription: e.target.value })}
            />
            <button
              className="primary"
              disabled={!data.projectName.trim() || !data.projectDescription.trim() || saving}
              onClick={() => submit()}
            >
              {saving ? "Setting up…" : "Enter Atelier"}
            </button>
            {existingProjects.length > 0 && (
              <button
                type="button"
                className="ghost"
                disabled={saving}
                onClick={() => setShowNewProject(false)}
                style={{ marginTop: 8 }}
              >
                ← back to your projects
              </button>
            )}
            {error && <p style={{ color: "var(--sem-red)", fontFamily: "var(--font-mono)", fontSize: "var(--t-2)", marginTop: 8 }}>{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
