/**
 * Agreement/disagreement signal extraction from raw.log.
 *
 * Per JOURNAL.md "Agreement/disagreement extraction logic" (MAJOR mechanism):
 *   Signal types: agreement, disagreement, redirect, adoption, silence-pivot, meta
 *   For each founder [in] message: detect type via keyword heuristics,
 *   find reacting_to (nearest preceding [out] block),
 *   tag sentiment (positive | negative | mixed) and confidence (low/medium/high).
 *
 * Per drafter.md "Reflection pass — my signature close":
 *   Writes per-category append-only:
 *     high-confidence → preferences.md / redirects.md / axioms.md / voice.md
 *     medium → same files tagged `medium-confidence`
 *     low → axioms.md only if explicit pattern-naming detected
 *
 * Per drafter.md "Loading personal brain at session start":
 *   founder dir is `brain/personal/<founder-lowercased>/`.
 *
 * Raw log format (per ws/hub.ts logRaw):
 *   `[in] <iso-ts> <text>` — founder input
 *   `[out] <iso-ts> <chunk>` — agent output
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAgentConfig, config } from "~/config";

export type SignalType =
  | "agreement"
  | "disagreement"
  | "redirect"
  | "adoption"
  | "silence-pivot"
  | "meta";

export type Sentiment = "positive" | "negative" | "mixed";
export type Confidence = "low" | "medium" | "high";

export interface Signal {
  timestamp: string;
  type: SignalType;
  sentiment: Sentiment;
  confidence: Confidence;
  founder_text: string;
  reacting_to: string; // truncated preceding [out] block
  pattern_named?: string; // if the founder explicitly named a pattern
}

interface RawEntry {
  direction: "in" | "out";
  ts: string;
  text: string;
}

// Parse raw.log into line entries. Each line is: `[in|out] <iso-ts> <text>`.
function parseRaw(raw: string): RawEntry[] {
  const out: RawEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\[(in|out)\]\s+(\S+)\s+([\s\S]*)$/.exec(line);
    if (!m) continue;
    out.push({ direction: m[1] as "in" | "out", ts: m[2], text: m[3] });
  }
  return out;
}

// Collapse consecutive [out] entries into single utterances (so reacting_to
// points at the whole agent turn, not a single chunk from streaming).
function collapseTurns(entries: RawEntry[]): RawEntry[] {
  const out: RawEntry[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.direction === e.direction) {
      last.text = last.text + " " + e.text;
    } else {
      out.push({ ...e });
    }
  }
  return out;
}

// Keyword heuristics per task spec. Returns null if the line is neither
// clearly agreement nor disagreement nor redirect nor meta (i.e. a neutral
// follow-up question or capture).
function classify(founderText: string): {
  type: SignalType;
  sentiment: Sentiment;
  confidence: Confidence;
  pattern_named?: string;
} | null {
  const t = founderText.toLowerCase().trim();
  if (!t) return null;

  // Explicit pattern-naming: "call this X", "lets name X", "the X pattern", "rule: X"
  const patternMatch =
    /(?:call (?:this|it)|let'?s name|we should name|the pattern (?:is|being)|rule:|axiom:|principle:)\s+([^.!?\n]+)/i.exec(
      founderText
    );
  const pattern_named = patternMatch ? patternMatch[1].trim() : undefined;

  // Explicit agreement (HIGH)
  const agreementStrong = /\b(exactly|nailed it|nailed|perfect|spot on|agreed|yes,? that's right|that's it|correct)\b/i;
  if (agreementStrong.test(founderText)) {
    return {
      type: "agreement",
      sentiment: "positive",
      confidence: pattern_named ? "high" : "high",
      pattern_named,
    };
  }
  // Soft agreement (MEDIUM)
  if (/^\s*(yes|yeah|yep|ok|okay|sure|fine)\b/i.test(founderText)) {
    return { type: "agreement", sentiment: "positive", confidence: "medium", pattern_named };
  }

  // Explicit disagreement (HIGH)
  const disagreementStrong = /\b(no[.,!]|wrong|not what|that's not|don'?t|stop|incorrect|disagree)\b/i;
  if (disagreementStrong.test(founderText)) {
    return {
      type: "disagreement",
      sentiment: "negative",
      confidence: "high",
      pattern_named,
    };
  }

  // Redirect — founder offers a different direction (MEDIUM by default)
  const redirectCue = /\b(instead|rather|actually|i'?d (?:go|prefer)|go with|try|let'?s (?:try|do)|think about|consider|what about)\b/i;
  if (redirectCue.test(founderText) && founderText.length > 40) {
    return {
      type: "redirect",
      sentiment: "mixed",
      confidence: pattern_named ? "high" : "medium",
      pattern_named,
    };
  }

  // Adoption-by-modification — founder reuses agent wording with tweaks (hard to detect w/o similarity; approximate by length + quote marks)
  if (/["'].{8,}["']/.test(founderText) && /\b(but|except|however|also|with)\b/i.test(founderText)) {
    return { type: "adoption", sentiment: "mixed", confidence: "low", pattern_named };
  }

  // Meta — founder comments on process / collaboration quality
  if (/\b(atelier|carlsbert|the agent|reflection|personal brain|canvas)\b/i.test(founderText) &&
      /\b(should|must|needs to|ought to|better if|why don't you)\b/i.test(founderText)) {
    return {
      type: "meta",
      sentiment: "mixed",
      confidence: pattern_named ? "high" : "medium",
      pattern_named,
    };
  }

  return null;
}

// Upgrade confidence when a similar signal has been seen within the session
// (3+ occurrences → escalate to high per drafter.md).
function escalateRepeats(signals: Signal[]): Signal[] {
  const counts = new Map<string, number>();
  for (const s of signals) {
    const key = `${s.type}:${s.founder_text.slice(0, 32).toLowerCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return signals.map((s) => {
    const key = `${s.type}:${s.founder_text.slice(0, 32).toLowerCase()}`;
    const n = counts.get(key) ?? 0;
    if (n >= 3 && s.confidence !== "high") return { ...s, confidence: "high" };
    if (n >= 2 && s.confidence === "low") return { ...s, confidence: "medium" };
    return s;
  });
}

export function extractSignalsFromRawLog(rawLog: string): Signal[] {
  const entries = collapseTurns(parseRaw(rawLog));
  const signals: Signal[] = [];
  let lastOut = "";
  for (const e of entries) {
    if (e.direction === "out") {
      lastOut = e.text;
      continue;
    }
    const c = classify(e.text);
    if (!c) continue;
    signals.push({
      timestamp: e.ts,
      type: c.type,
      sentiment: c.sentiment,
      confidence: c.confidence,
      founder_text: e.text.trim().slice(0, 500),
      reacting_to: lastOut.trim().slice(0, 400),
      pattern_named: c.pattern_named,
    });
  }
  return escalateRepeats(signals);
}

// Decide target brain file from signal type.
function targetFile(s: Signal): "preferences" | "redirects" | "axioms" | "voice" | null {
  switch (s.type) {
    case "agreement":
    case "adoption":
      return "preferences";
    case "disagreement":
    case "redirect":
      return "redirects";
    case "meta":
      return "voice";
    case "silence-pivot":
      return "redirects";
    default:
      return null;
  }
}

export interface WriteResult {
  written: number;
  skipped: number;
  files_touched: string[];
}

// Append signals to brain/personal/<founder>/{preferences,redirects,axioms,voice}.md.
// High: written plainly. Medium: same file, tagged `medium-confidence`.
// Low: only axioms.md if explicit pattern-naming.
export function writeSignalsToPersonalBrain(signals: Signal[]): WriteResult {
  const agent = loadAgentConfig();
  const founder = (agent.founder_name || "unknown").toLowerCase();
  const brainDir = resolve(config.atelierRoot, "brain/personal", founder);
  mkdirSync(brainDir, { recursive: true });

  const touched = new Set<string>();
  let written = 0;
  let skipped = 0;

  for (const s of signals) {
    // Low confidence: only axioms.md if founder explicitly named a pattern
    if (s.confidence === "low") {
      if (!s.pattern_named) {
        skipped++;
        continue;
      }
      const file = resolve(brainDir, "axioms.md");
      if (!existsSync(file)) writeFileSync(file, "# axioms\n");
      appendFileSync(
        file,
        `\n---\n**${s.timestamp}** · confidence: low · type: ${s.type} · low-confidence-pattern-named\n` +
          `Pattern: **${s.pattern_named}**\n\n` +
          `Founder: ${s.founder_text}\n\nReacting to: ${s.reacting_to}\n`
      );
      touched.add(file);
      written++;
      continue;
    }

    const cat = targetFile(s);
    if (!cat) {
      skipped++;
      continue;
    }
    const file = resolve(brainDir, `${cat}.md`);
    if (!existsSync(file)) writeFileSync(file, `# ${cat}\n`);
    const tag = s.confidence === "medium" ? " · medium-confidence" : "";
    const patternLine = s.pattern_named ? `\nPattern: **${s.pattern_named}**\n` : "";
    appendFileSync(
      file,
      `\n---\n**${s.timestamp}** · confidence: ${s.confidence}${tag} · type: ${s.type} · sentiment: ${s.sentiment}\n` +
        patternLine +
        `\nFounder: ${s.founder_text}\n\nReacting to: ${s.reacting_to}\n`
    );
    touched.add(file);
    written++;

    // High-confidence patterns with explicit naming → also stamp to axioms.md (escalation)
    if (s.confidence === "high" && s.pattern_named) {
      const ax = resolve(brainDir, "axioms.md");
      if (!existsSync(ax)) writeFileSync(ax, "# axioms\n");
      appendFileSync(
        ax,
        `\n---\n**${s.timestamp}** · escalated from ${cat}.md · type: ${s.type}\n` +
          `Pattern: **${s.pattern_named}**\n\n${s.founder_text}\n`
      );
      touched.add(ax);
    }
  }

  return { written, skipped, files_touched: Array.from(touched) };
}

// One-shot helper used by /session/reflect.
export function extractAndWriteSignals(rawLogPath: string): {
  signals: Signal[];
  write: WriteResult;
} {
  if (!existsSync(rawLogPath)) {
    return { signals: [], write: { written: 0, skipped: 0, files_touched: [] } };
  }
  const raw = readFileSync(rawLogPath, "utf-8");
  const signals = extractSignalsFromRawLog(raw);
  const write = writeSignalsToPersonalBrain(signals);
  return { signals, write };
}
