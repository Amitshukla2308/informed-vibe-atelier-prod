import { useEffect, useState } from "react";
import { Particles } from "./Particles";

const ROTOR = [
  "One canvas. One agent. Two modes — orientation while shape is forming, execution once it's set.",
  "The plan, the decisions, the risks, the ship dates — together. Not scattered across five tools.",
  "The agent walks in already knowing you, the project, and the shape of what's around it.",
];

const PILLARS: { title: string; body: string; foot: string }[] = [
  {
    title: "The Canvas",
    body:
      "One graph for the project — themes, stories, tasks, decisions, risks, ship dates. Five filtered lenses on the same substrate. No second tracker, no separate notion that has to be reconciled later.",
    foot: "build · decisions · risks · discovery · docs",
  },
  {
    title: "Onboarder & Drafter",
    body:
      "The agent has modes. The Onboarder meets you when nothing exists yet and drafts shape — themes, risks, a ship date — for you to redirect. Once shape is set, the Drafter takes execution from there, holding scope without a thousand confirmations.",
    foot: "orientation → execution · explicit handoff",
  },
  {
    title: "The Brain",
    body:
      "Personal, project, and world layers compile between sessions. The agent walks into every conversation already knowing your patterns, the last decision, and the shape of what's around it.",
    foot: "personal · project · world · domain",
  },
];

interface LandingProps {
  isAuthed?: boolean;
}

export function Landing({ isAuthed = false }: LandingProps) {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setPhase(p => (p + 1) % ROTOR.length), 5400);
    return () => window.clearInterval(id);
  }, []);

  // URL normalization is handled in App.tsx: "/" → /landing on mount,
  // and unknown authed paths fall through to /home. Landing itself just
  // renders at /landing; no per-mount rewriting here.

  function jump(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function startHostFlow() {
    if (isAuthed) {
      window.location.assign("/home");
    } else {
      // Unauth'd visitors land on /signin — the first user there auto-bootstraps
      // as admin, returning users sign in, new collaborators request access.
      window.location.assign("/signin");
    }
  }

  return (
    <div className="lp">
      <Particles className="lp-stars" count={320} linkDistance={92} speed={0.05} />
      <div className="lp-vignette" aria-hidden />

      <header className="lp-nav lp-glass">
        <div className="lp-mark">
          <span className="lp-mark-dot" />
          <span className="lp-mark-word">atelier</span>
        </div>
        <nav className="lp-nav-links" aria-label="Primary">
          <button onClick={() => jump("concept")}>The product</button>
          <button onClick={() => jump("why")}>Why it exists</button>
          <button onClick={() => jump("who")}>Who it's for</button>
          {isAuthed
            ? <button className="lp-nav-cta" onClick={() => window.location.assign("/home")}>Workspace →</button>
            : <>
                <button onClick={() => window.location.assign("/signin")}>Link a device</button>
                <button className="lp-nav-cta" onClick={startHostFlow}>Get started →</button>
              </>
          }
        </nav>
      </header>

      <main className="lp-main" id="main-content">
      <section className="lp-hero" aria-label="Atelier introduction">
        <div className="lp-hero-eyebrow">
          A working environment for founding teams
        </div>

        <h1 className="lp-wordmark" aria-label="Atelier">
          atelier
        </h1>

        <div className="lp-hero-rotor lp-glass" aria-live="polite">
          {ROTOR.map((line, i) => (
            <p key={i} className={`lp-rotor-line ${i === phase ? "is-on" : ""}`}>
              {line}
            </p>
          ))}
        </div>

        <p className="lp-hero-lede">
          One AI co-founder. Direction from technical and non-technical founders alike.
          Autonomous progress between sessions. The right level of visibility for
          everyone in the room.
        </p>

        <div className="lp-hero-cta">
          <button className="lp-cta-primary" onClick={startHostFlow}>
            <span>{isAuthed ? "Enter your workspace" : "Get started"}</span>
            <span className="lp-cta-arrow">→</span>
          </button>
          <button className="lp-cta-ghost lp-glass" onClick={() => jump("concept")}>
            See how it works
          </button>
        </div>
      </section>

      <section id="concept" className="lp-section">
        <div className="lp-section-head">
          <h2 className="lp-section-title">Three pieces, on purpose.</h2>
          <p className="lp-section-sub">
            Atelier is small. The whole product is three load-bearing ideas — every
            other surface in the app exists in service of these three.
          </p>
        </div>

        <div className="lp-pillars">
          {PILLARS.map((p) => (
            <article key={p.title} className="lp-pillar lp-glass-strong">
              <h3 className="lp-pillar-title">{p.title}</h3>
              <p className="lp-pillar-body">{p.body}</p>
              <div className="lp-pillar-foot">{p.foot}</div>
            </article>
          ))}
        </div>
      </section>

      <section id="why" className="lp-section lp-why">
        <div className="lp-why-grid">
          <div className="lp-why-left">
            <h2 className="lp-section-title">
              Most AI-built projects die in <em>almost-done</em> purgatory.
            </h2>
          </div>
          <div className="lp-why-right">
            <p>
              The pattern is consistent. Early sessions feel magical: the codebase
              fits in one window of clarity, every ask maps to the whole project, and
              the agent keeps up. Then the codebase grows past what one person can
              hold in mind while chatting.
            </p>
            <p>
              Asks become vague. The agent guesses. It touches the wrong file, or
              the right file the wrong way. Trust erodes. The next prompt has even
              less context. The project slows, then stalls.
            </p>
            <p className="lp-why-claim">
              Atelier's mechanism is precision before code. Scope gates. The canvas.
              A Drafter that proposes structure before touching the implementation.
              The ceremony that feels like overhead is the only path past
              "almost done."
            </p>
          </div>
        </div>
      </section>

      <section id="who" className="lp-section">
        <div className="lp-section-head">
          <h2 className="lp-section-title">Who it's for.</h2>
        </div>

        <div className="lp-who-rows lp-glass">
          <div className="lp-who-row">
            <div className="lp-who-tag">Solo founder</div>
            <div className="lp-who-text">
              You're the only one in the room. The Drafter is your second pair of
              hands; the Brain is the memory you don't have time to keep.
            </div>
          </div>
          <div className="lp-who-row">
            <div className="lp-who-tag">Two-founder team</div>
            <div className="lp-who-text">
              One technical, one not. The agent translates between you, takes
              direction from both, and shows each side the level of detail that
              matters to them — never the same wall of code for everyone.
            </div>
          </div>
          <div className="lp-who-row">
            <div className="lp-who-tag">Small founding crew</div>
            <div className="lp-who-text">
              A handful of people, invited in. Each gets a role-shaped view of the
              same canvas. Decisions are visible. Nothing happens in a side channel.
            </div>
          </div>
          <div className="lp-who-row lp-who-row--counter">
            <div className="lp-who-tag">Not built for</div>
            <div className="lp-who-text">
              Hosted SaaS use. Enterprise rollouts. Anyone who'd rather hand the
              agent the keys than watch where it puts them. Atelier is self-hosted,
              on purpose, and stays that way.
            </div>
          </div>
        </div>
      </section>

      <section id="enter" className="lp-section">
        <div className="lp-section-head">
          <h2 className="lp-section-title">Two ways in.</h2>
        </div>

        <div className="lp-enter-grid">
          <div className="lp-enter-card lp-glass-strong">
            <div className="lp-enter-kicker">By invitation</div>
            <h3 className="lp-enter-title">Join an existing instance</h3>
            <p className="lp-enter-body">
              Most founders arrive through a link from someone already running an
              Atelier instance. The link drops you onto the project's canvas with a
              role waiting and the agent already briefed.
            </p>
          </div>

          <div className="lp-enter-card lp-glass-strong">
            <div className="lp-enter-kicker">Self-hosted</div>
            <h3 className="lp-enter-title">Run your own</h3>
            <p className="lp-enter-body">
              Clone the repo, run two commands, expose it through a tunnel. Your
              data lives on your machine. The agent runs against your keys or your
              local models. No managed cloud, no telemetry.
            </p>
            <button className="lp-enter-cta" onClick={startHostFlow}>
              {isAuthed ? "Enter workspace" : "Start your instance"} <span className="lp-cta-arrow">→</span>
            </button>
          </div>
        </div>
      </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-foot-row">
          <div className="lp-foot-mark">
            <span className="lp-foot-mark-dot" />
            atelier
          </div>
          <div className="lp-foot-tag">
            A working environment for founding teams
          </div>
        </div>
        <div className="lp-foot-row lp-foot-row--meta">
          <div className="lp-foot-meta">© 2026 · Self-hosted</div>
          <div className="lp-foot-meta">
            <a href="/signin" className="lp-foot-link">Sign in →</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default Landing;
