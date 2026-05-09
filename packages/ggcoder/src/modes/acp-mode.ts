/**
 * ACP (Agent Client Protocol) mode for GG Coder.
 *
 * Implements the ACP Agent interface so OpenAB (and any ACP client) can
 * communicate with GG Coder over stdio JSON-RPC.
 *
 * @see https://agentclientprotocol.com
 */

import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../core/agent-session.js";
import { AuthStorage } from "../core/auth-storage.js";
import { ensureAppDirs, loadSavedSettings } from "../config.js";
import { MODELS } from "../core/model-registry.js";
import { initLogger } from "../core/logger.js";
import type { ToolKind } from "@agentclientprotocol/sdk";

const _require = createRequire(import.meta.url);
const PKG_VERSION = (_require("../../package.json") as { version: string }).version;

// ── Types ──────────────────────────────────────────────────

export interface AcpModeOptions {
  provider?: Provider;
  model?: string;
  cwd?: string;
}

interface SessionState {
  session: AgentSession;
  abortController: AbortController;
  lastActiveAt: number;
  isPrompting: boolean;
}

// Match OpenAB's pool defaults: 4-hour TTL, 10 concurrent sessions max.
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_SESSIONS = 10;

// ── Tool name → ACP ToolKind mapping ───────────────────────

function toolKind(name: string): ToolKind {
  switch (name) {
    case "bash":
      return "execute";
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "find":
    case "grep":
      return "search";
    case "web_search":
    case "web_fetch":
      return "fetch";
    default:
      return "other";
  }
}

function toolTitle(name: string, args: Record<string, unknown>): string {
  const detail =
    (args.command as string) ??
    (args.file_path as string) ??
    (args.path as string) ??
    (args.pattern as string) ??
    "";
  return detail ? `${name}: ${String(detail).slice(0, 120)}` : name;
}

// ── GG Coder ACP Agent ─────────────────────────────────────

class GGCoderAgent implements acp.Agent {
  private connection: acp.AgentSideConnection;
  private sessions = new Map<string, SessionState>();
  private defaultProvider: Provider;
  private defaultModel: string;
  private defaultCwd: string;
  private apiKey?: string;

  constructor(connection: acp.AgentSideConnection, opts: AcpModeOptions) {
    this.connection = connection;
    this.defaultProvider = opts.provider ?? "anthropic";
    this.defaultModel = opts.model ?? "claude-opus-4-7";
    this.defaultCwd = opts.cwd ?? process.cwd();
  }

  // ── Agent interface ──────────────────────────────────────

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      authMethods: [
        {
          id: "api_key",
          name: "API Key",
          description: "Provide an API key for the configured provider",
          _meta: {
            "api-key": {
              provider: this.defaultProvider,
            },
          },
        },
      ],
      agentInfo: {
        name: "ggcoder",
        title: "GG Coder",
        version: PKG_VERSION,
      },
      agentCapabilities: {
        loadSession: false,
      },
    };
  }

  async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    // Extract API key from _meta if present (OpenAB sends it here)
    const meta = (params as unknown as { _meta?: Record<string, unknown> })._meta;
    const apiKey = typeof meta?.["api-key"] === "string" ? (meta["api-key"] as string) : undefined;

    if (apiKey) {
      this.apiKey = apiKey;
    }

    // Try loading from auth storage if no key in meta
    if (!this.apiKey) {
      try {
        const paths = await ensureAppDirs();
        const authStorage = new AuthStorage(paths.authFile);
        await authStorage.load();
        const creds = await authStorage.resolveCredentials(this.defaultProvider);
        this.apiKey = creds.accessToken;
      } catch {
        // No stored credentials — the session will fail if provider requires auth
      }
    }

    return {};
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    const cwd = params.cwd ?? this.defaultCwd;
    const ac = new AbortController();

    // Resolve provider/model from saved settings
    let provider = this.defaultProvider;
    let model = this.defaultModel;
    try {
      const saved = loadSavedSettings();
      if (saved.provider) provider = saved.provider as Provider;
      if (saved.model) model = saved.model;
    } catch {
      // Use defaults
    }

    const thinkingLevel: ThinkingLevel | undefined = undefined;

    const session = new AgentSession({
      provider,
      model,
      cwd,
      thinkingLevel,
      signal: ac.signal,
    });

    // Wire agent events → ACP session updates
    this.wireSessionEvents(sessionId, session);

    await session.initialize();

    this.sessions.set(sessionId, {
      session,
      abortController: ac,
      lastActiveAt: Date.now(),
      isPrompting: false,
    });
    this.evictStaleSessions();

    // Build available models list for ACP
    const availableModels = MODELS.map((m) => ({
      modelId: `${m.provider}:${m.id}` as unknown as acp.ModelId,
      name: m.name,
    }));
    const currentModelId = `${provider}:${model}` as unknown as acp.ModelId;

    return {
      sessionId,
      modes: {
        availableModes: [{ id: "code", name: "Code" }],
        currentModeId: "code",
      },
      models: {
        availableModels,
        currentModelId,
      },
    };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const state = this.sessions.get(params.sessionId);
    if (!state) {
      throw new acp.RequestError(-32602, `Session not found: ${params.sessionId}`);
    }

    state.lastActiveAt = Date.now();
    state.isPrompting = true;
    const { session, abortController } = state;

    // Reset abort controller for new prompt
    if (abortController.signal.aborted) {
      const newAc = new AbortController();
      state.abortController = newAc;
      session.setSignal(newAc.signal);
    }

    try {
      // Extract text from ACP prompt blocks
      const promptBlocks = params.prompt ?? [];
      const textBlocks = promptBlocks.filter(
        (b): b is { type: "text"; text: string } => b.type === "text",
      );
      const text = textBlocks.map((b) => b.text).join("");

      if (!text) {
        return { stopReason: "end_turn" };
      }

      await session.prompt(text);

      return { stopReason: "end_turn" };
    } catch (err) {
      if (abortController.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw err;
    } finally {
      state.isPrompting = false;
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const state = this.sessions.get(params.sessionId);
    if (state) {
      state.abortController.abort();
      this.cleanupSession(params.sessionId);
    }
  }

  private cleanupSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.session.eventBus.removeAllListeners();
      this.sessions.delete(sessionId);
    }
  }

  private evictStaleSessions(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;

    // First pass: evict idle sessions past TTL (skip active ones).
    for (const [id, state] of this.sessions) {
      if (!state.isPrompting && state.lastActiveAt < cutoff) {
        this.cleanupSession(id);
      }
    }

    // Second pass: if still at capacity, evict the LRU idle session.
    while (this.sessions.size >= MAX_SESSIONS) {
      let lruId: string | undefined;
      let lruTime = Infinity;
      for (const [id, state] of this.sessions) {
        if (!state.isPrompting && state.lastActiveAt < lruTime) {
          lruTime = state.lastActiveAt;
          lruId = id;
        }
      }
      if (!lruId) break; // all remaining sessions are active — cannot evict
      this.cleanupSession(lruId);
    }
  }

  async setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    // We only support "code" mode — no-op
    return {};
  }

  // ── Private helpers ──────────────────────────────────────

  private wireSessionEvents(sessionId: string, session: AgentSession): void {
    // Track toolCallId across start→end so the ACP update references the same ID.
    const pendingToolIds = new Map<string, string>();

    session.eventBus.on("text_delta", (p: { text: string }) => {
      this.connection
        .sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: p.text },
          },
        })
        .catch(() => {});
    });

    session.eventBus.on("thinking_delta", (p: { text: string }) => {
      this.connection
        .sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: p.text },
          },
        })
        .catch(() => {});
    });

    session.eventBus.on(
      "tool_call_start",
      (p: { toolCallId: string; name: string; args: Record<string, unknown> }) => {
        const acpId = p.toolCallId ?? randomUUID();
        if (p.toolCallId) pendingToolIds.set(p.toolCallId, acpId);
        this.connection
          .sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: acpId,
              title: toolTitle(p.name, p.args),
              kind: toolKind(p.name),
              status: "in_progress",
            },
          })
          .catch(() => {});
      },
    );

    session.eventBus.on(
      "tool_call_end",
      (p: { toolCallId: string; result: string; isError: boolean; durationMs: number }) => {
        const acpId =
          (p.toolCallId && pendingToolIds.get(p.toolCallId)) ?? p.toolCallId ?? randomUUID();
        if (p.toolCallId) pendingToolIds.delete(p.toolCallId);
        this.connection
          .sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: acpId,
              status: p.isError ? "failed" : "completed",
              rawOutput: p.result ? p.result : undefined,
            },
          })
          .catch(() => {});
      },
    );

    session.eventBus.on("error", ({ error }: { error: Error }) => {
      this.connection
        .sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Error: ${error.message}` },
          },
        })
        .catch(() => {});
    });
  }
}

// ── Entry point ────────────────────────────────────────────

/**
 * Run GG Coder in ACP mode — stdio JSON-RPC compatible with OpenAB.
 */
export async function runAcpMode(opts: AcpModeOptions = {}): Promise<void> {
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, {
    version: PKG_VERSION,
    provider: opts.provider ?? "anthropic",
    model: opts.model ?? "claude-opus-4-7",
  });

  // ndJsonStream(output, input):
  //   output = WritableStream we write TO   → stdout
  //   input  = ReadableStream we read FROM  → stdin
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);

  // Start the ACP agent-side connection
  const conn = new acp.AgentSideConnection((conn) => new GGCoderAgent(conn, opts), stream);

  // Keep process alive until connection closes
  await conn.closed;
}
