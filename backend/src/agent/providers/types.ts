/**
 * Normalized conversation turn — the shape Reflect, extract-signals, and
 * multi-session-summary all consume. Provider readers (claude / openai /
 * gemini / ollama) map their native JSON into this.
 *
 * The reason this interface exists: we stopped parsing PTY byte streams
 * (`data/sessions/<id>/raw.log`) to reconstruct meaning. Each agent already
 * writes structured conversation JSON to disk; we read those instead.
 */

export type TurnRole = "user" | "assistant" | "tool";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; input: unknown; toolUseId?: string }
  | { type: "tool_result"; toolUseId?: string; output: string; isError?: boolean };

export interface NormalizedTurn {
  turnId: string;
  role: TurnRole;
  ts: string;
  blocks: ContentBlock[];
  /** Usage stats when the provider records them (tokens etc). */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  model?: string;
  stopReason?: string;
}

export interface ConversationMeta {
  sessionId: string;
  provider: AgentProviderId;
  startedAt?: string;
  endedAt?: string;
  turns: NormalizedTurn[];
  /** Number of user-submitted turns (the meaningful "turn" in UI). */
  userTurnCount: number;
  /** Concatenated first user message text — clipped for preview. */
  firstUserLine?: string;
  /** All tool-use calls by name (for curation Axis B). */
  toolCalls?: Array<{ name: string; turnId: string; ts: string }>;
}

export type AgentProviderId = "claude" | "openai" | "gemini" | "ollama" | "qwen-code" | "opencode";

export interface AgentProvider {
  id: AgentProviderId;
  /**
   * Return normalized conversation if this provider has stored one for the
   * given Atelier session id + project cwd. Null if not found / not handled.
   */
  readConversation(sessionId: string, projectCwd: string): Promise<ConversationMeta | null>;
  /** True if this provider's storage looks available on this machine. */
  isAvailable(): boolean;
}

export interface CliSpawnOptions {
  sessionId: string;
  systemPromptPath: string;
  cwd: string;
  mcpConfigPath: string;
  tools: string[];
}

export interface CliAdapter {
  id: AgentProviderId;
  isAvailable(): boolean;

  getInteractiveCommand(opts: CliSpawnOptions): {
    bin: string;
    args: string[];
    env: Record<string, string>;
    preSpawnWrites?: Array<{ path: string; contents: string }>;
  };

  runPrint(opts: CliSpawnOptions, userMessage: string, timeoutMs?: number): Promise<string>;
}
