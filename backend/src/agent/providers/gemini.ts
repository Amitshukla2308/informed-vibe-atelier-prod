import { resolve } from "node:path";
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { AgentProvider, ConversationMeta, ContentBlock, NormalizedTurn, CliAdapter, CliSpawnOptions } from "./types";

export function cwdToGeminiDirName(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex");
}

function geminiTmpDir(cwd: string): string {
  return resolve(process.env.HOME ?? "/", ".gemini/tmp", cwdToGeminiDirName(cwd));
}

function getGeminiBin(): string {
  return process.env.GEMINI_BIN ?? resolve(process.env.HOME ?? "/", ".npm-global/bin/gemini");
}

interface GeminiMessage {
  id: string;
  timestamp: string;
  type: string;
  role?: string;
  content: string;
}

interface GeminiSessionData {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiMessage[];
}

export const geminiAdapter: CliAdapter = {
  id: "gemini",

  isAvailable() {
    try {
      return existsSync(getGeminiBin());
    } catch {
      return false;
    }
  },

  getInteractiveCommand(opts: CliSpawnOptions) {
    const settingsJson: any = {
      tools: {
        core: opts.tools.length > 0 ? opts.tools : []
      }
    };
    
    if (opts.mcpConfigPath && existsSync(opts.mcpConfigPath)) {
       try {
         const parsed = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
         if (parsed.mcpServers) settingsJson.mcpServers = parsed.mcpServers;
       } catch {}
    }

    const geminiDir = resolve(opts.cwd, ".gemini");
    if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });

    return {
      bin: getGeminiBin(),
      args: ["--yolo"],
      env: { 
        ...process.env,
        GEMINI_SYSTEM_MD: opts.systemPromptPath
      } as Record<string, string>,
      preSpawnWrites: [
        { path: ".gemini/settings.json", contents: JSON.stringify(settingsJson, null, 2) }
      ]
    };
  },

  runPrint(opts: CliSpawnOptions, userMessage: string, timeoutMs = 90_000): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const bin = getGeminiBin();
      if (!existsSync(bin)) {
        rejectPromise(new Error(`gemini binary not found at ${bin}`));
        return;
      }

      const args = ["-p", "--output-format", "stream-json", "--yolo"];
      if (userMessage) {
        args.push(userMessage);
      }

      const settingsJson: any = {
        tools: {
          core: opts.tools.length > 0 ? opts.tools : []
        }
      };
      if (opts.mcpConfigPath && existsSync(opts.mcpConfigPath)) {
         try {
           const parsed = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
           if (parsed.mcpServers) settingsJson.mcpServers = parsed.mcpServers;
         } catch {}
      }

      const geminiDir = resolve(opts.cwd, ".gemini");
      if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });
      const settingsPath = resolve(geminiDir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify(settingsJson, null, 2), "utf-8");

      const { spawn } = require("node:child_process");
      const child = spawn(bin, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GEMINI_SYSTEM_MD: opts.systemPromptPath },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error(`gemini -p timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("error", (e: Error) => {
        clearTimeout(timer);
        rejectPromise(e);
      });
      child.on("exit", (code: number) => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) {
           let fullText = "";
           const lines = stdout.split("\n");
           for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const event = JSON.parse(line);
                if (event.type === "message" && event.role === "assistant" && event.content) {
                  fullText += event.content;
                }
              } catch {}
           }
           if (!fullText) fullText = stdout.trim(); // fallback if stream-json parsing fails
           resolvePromise(fullText.trim());
        } else {
          rejectPromise(new Error(`gemini -p exited ${code}: ${stderr.slice(0, 500)}`));
        }
      });
    });
  }
};

export const geminiProvider: AgentProvider = {
  id: "gemini",

  isAvailable() {
    return geminiAdapter.isAvailable();
  },

  async readConversation(sessionId: string, projectCwd: string): Promise<ConversationMeta | null> {
    const { config } = require("~/config");
    const metaPath = resolve(config.dataDir, "sessions", sessionId, "meta.json");
    let providerSessionId = sessionId;
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        if (meta.providerSessionId) providerSessionId = meta.providerSessionId;
      } catch {}
    }

    const chatsDir = resolve(geminiTmpDir(projectCwd), "chats");
    if (!existsSync(chatsDir)) return null;

    const files = readdirSync(chatsDir).filter(f => f.endsWith(".json"));
    let targetFile = "";

    for (const f of files) {
       const p = resolve(chatsDir, f);
       try {
         const data = JSON.parse(readFileSync(p, "utf-8"));
         if (data.sessionId === providerSessionId) {
            targetFile = p;
            break;
         }
       } catch {}
    }

    if (!targetFile && files.length > 0) {
       const sorted = files.map(f => {
         const p = resolve(chatsDir, f);
         return { path: p, mtime: statSync(p).mtimeMs };
       }).sort((a, b) => b.mtime - a.mtime);
       targetFile = sorted[0].path;
    }

    if (!targetFile) return null;

    let data: GeminiSessionData;
    try {
      data = JSON.parse(readFileSync(targetFile, "utf-8"));
    } catch {
      return null;
    }

    const turns: NormalizedTurn[] = [];
    let userTurnCount = 0;
    for (const msg of data.messages) {
       if (msg.type === "user" || msg.role === "user") {
          userTurnCount++;
          turns.push({
             turnId: msg.id,
             role: "user",
             ts: msg.timestamp,
             blocks: [{ type: "text", text: msg.content }]
          });
       } else if (msg.type === "assistant" || msg.role === "assistant") {
          turns.push({
             turnId: msg.id,
             role: "assistant",
             ts: msg.timestamp,
             blocks: [{ type: "text", text: msg.content }]
          });
       }
    }

    if (turns.length === 0) return null;

    const firstUserText = turns.find(t => t.role === "user")?.blocks[0];
    const firstUserLine = firstUserText && firstUserText.type === "text" 
      ? firstUserText.text.replace(/\s+/g, " ").slice(0, 140) 
      : undefined;

    return {
      sessionId,
      provider: "gemini",
      startedAt: data.startTime,
      endedAt: data.lastUpdated,
      turns,
      userTurnCount,
      firstUserLine,
      toolCalls: [] 
    };
  }
};