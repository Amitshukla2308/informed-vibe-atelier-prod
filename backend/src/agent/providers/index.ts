/**
 * Provider registry. Today we implement `claude`; stubs exist for openai,
 * gemini, ollama so the interface is the only thing that changes when we
 * wire those. Downstream code (Reflect, extract-signals, multi-session-
 * summary) consumes the normalized shape regardless of provider.
 */

import type { AgentProvider, AgentProviderId, ConversationMeta, CliAdapter } from "./types";
import { claudeProvider, claudeAdapter } from "./claude";
import { geminiProvider, geminiAdapter } from "./gemini";
import { qwenCodeProvider, qwenCodeAdapter } from "./qwen-code";
import { opencodeProvider, opencodeAdapter } from "./opencode";

// Stubs — placeholders that return null until their readers ship. Kept so any
// call site can already ask "do you handle <provider>?" without branching.
const openaiProvider: AgentProvider = {
  id: "openai",
  isAvailable: () => false,
  async readConversation() { return null; },
};
const ollamaProvider: AgentProvider = { id: "ollama", isAvailable: () => false, async readConversation() { return null; } };

const providers: Record<AgentProviderId, AgentProvider> = {
  claude: claudeProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider,
  "qwen-code": qwenCodeProvider,
  opencode: opencodeProvider,
};

export function getProvider(id: AgentProviderId): AgentProvider {
  return providers[id];
}

export async function readSessionConversation(
  sessionId: string,
  projectCwd: string,
  providerId: AgentProviderId = "claude",
): Promise<ConversationMeta | null> {
  return providers[providerId].readConversation(sessionId, projectCwd);
}

export function getCliAdapter(id: AgentProviderId): CliAdapter {
  if (id === "claude") return claudeAdapter;
  if (id === "gemini") return geminiAdapter;
  if (id === "qwen-code") return qwenCodeAdapter;
  if (id === "opencode") return opencodeAdapter;
  throw new Error(`CliAdapter not implemented for ${id}`);
}

export type { ConversationMeta, NormalizedTurn, AgentProviderId, CliAdapter, CliSpawnOptions } from "./types";
export { claudeJsonlPathFor, claudeProjectsRootPath, claudeAdapter } from "./claude";
export { geminiAdapter } from "./gemini";
export { qwenCodeAdapter } from "./qwen-code";
export { opencodeAdapter } from "./opencode";
