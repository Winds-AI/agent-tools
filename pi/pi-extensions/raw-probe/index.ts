/**
 * raw-probe — ask any Pi-configured model a direct question through its
 * provider API, with no tools and no agent loop: the pure model response,
 * including thinking blocks when the provider returns them unencrypted.
 * An optional system prompt may be passed per call.
 *
 * Tool loading (Option A — loader pattern):
 *   - `search_tools` is the only tool active by default. It is invoked ONLY
 *     on explicit user request (encoded in its description + promptSnippet).
 *   - `raw_probe` and `list_raw_models` are registered but inactive. The
 *     agent activates them on demand via `search_tools`, so they never touch
 *     the system prompt and provider prompt caching stays stable.
 *
 * Use case: when designing an agent around a specific model, probe the raw
 * model first — what it natively knows, how it reasons, how it behaves —
 * then write the prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** Tools registered by this extension but inactive until search_tools loads them. */
const LAZY_TOOLS = new Set(["raw_probe", "list_raw_models"]);

/** Render an AssistantMessage to text: thinking blocks first, then the answer. */
function renderResponse(msg: AssistantMessage): string {
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "thinking") {
      parts.push(
        block.redacted
          ? "<thinking>\n[thinking redacted by provider — not available]\n</thinking>"
          : `<thinking>\n${block.thinking}\n</thinking>`,
      );
    } else if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "toolCall") {
      parts.push(
        `[unexpected tool call: ${block.name} ${JSON.stringify(block.arguments)}]`,
      );
    }
  }
  if (msg.stopReason === "error" && msg.errorMessage) {
    parts.push(`[error: ${msg.errorMessage}]`);
  }
  return parts.join("\n\n").trim() || "(empty response)";
}

export default function (pi: ExtensionAPI): void {
  // ---------------------------------------------------------------------------
  // raw_probe — the core tool: ask a raw model a direct question, no tools.
  // Registered inactive; activated on demand through search_tools.
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "raw_probe",
    label: "Raw Probe",
    description:
      "Ask a raw model a direct question through its provider API, with no tools, no agent loop, and no injected prompt system — pure model response, including thinking blocks when the model returns them unencrypted. " +
      "Specify the model as 'provider/model-id' (e.g. 'openai-codex/gpt-5.4-mini', 'opencode-go/kimi-k2.6'). " +
      "Use raw_probe to probe what a model natively knows, how it reasons, and how it behaves before writing its agent prompt.",
    parameters: Type.Object({
      model: Type.String({
        description:
          "Model to query as 'provider/model-id', e.g. 'openai-codex/gpt-5.4-mini'",
      }),
      prompt: Type.String({
        description:
          "The direct question to ask the raw model (single turn, no conversation history)",
      }),
      systemPrompt: Type.Optional(
        Type.String({
          description: "Optional system prompt to include in the request",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const slash = params.model.indexOf("/");
      if (slash <= 0 || slash === params.model.length - 1) {
        throw new Error(
          `Invalid model '${params.model}'. Use 'provider/model-id', e.g. 'openai-codex/gpt-5.4-mini'`,
        );
      }
      const provider = params.model.slice(0, slash);
      const modelId = params.model.slice(slash + 1);

      const model = ctx.modelRegistry.find(provider, modelId);
      if (!model) {
        throw new Error(
          `Model not found: ${params.model}. Load list_raw_models via search_tools to see which models are available.`,
        );
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        throw new Error(`No API key or subscription auth configured for ${params.model}.`);
      }

      let msg;
      try {
        msg = await ctx.modelRegistry.complete(
          model,
          {
            systemPrompt: params.systemPrompt,
            messages: [{ role: "user", content: params.prompt, timestamp: Date.now() }],
          },
          { signal },
        );
      } catch (e) {
        throw new Error(`raw_probe failed for ${params.model}: ${(e as Error).message ?? String(e)}`);
      }

      return {
        content: [{ type: "text", text: renderResponse(msg) }],
        details: {
          stopReason: msg.stopReason,
          responseModel: msg.responseModel ?? msg.model,
          hasThinking: msg.content.some((b) => b.type === "thinking"),
          hasRedactedThinking: msg.content.some(
            (b) => b.type === "thinking" && b.redacted,
          ),
          errorMessage: msg.errorMessage,
        },
      };
    },
  });

  // ---------------------------------------------------------------------------
  // list_raw_models — enumerate models callable through raw_probe.
  // Registered inactive; activated on demand through search_tools.
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "list_raw_models",
    label: "List Raw Models",
    description:
      "List all models currently available to call through Pi with working authentication — subscriptions (e.g. openai-codex, cursor, xai) and API-key providers. " +
      "Returns one 'provider/model-id' per line, ready to pass to raw_probe.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const available = await ctx.modelRegistry.getAvailable();
      const byProvider = new Map<string, string[]>();
      for (const m of available) {
        const list = byProvider.get(m.provider) ?? [];
        list.push(m.id);
        byProvider.set(m.provider, list);
      }
      if (byProvider.size === 0) {
        return {
          content: [{ type: "text", text: "No models with working auth found." }],
          details: { count: 0 },
        };
      }
      const lines: string[] = [];
      for (const [provider, ids] of [...byProvider.entries()].sort()) {
        lines.push(`${provider}:`);
        for (const id of ids.sort()) lines.push(`  ${id}`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: available.length },
      };
    },
  });

  // ---------------------------------------------------------------------------
  // search_tools — always-active loader. Activates matching registered tools.
  // Only ever invoked on explicit user request.
  // ---------------------------------------------------------------------------
  pi.registerTool({
    name: "search_tools",
    label: "Search Tools",
    description:
      "Find and load additional tools — use ONLY on explicit user request, never proactively.",
    promptSnippet:
      "Find and load additional tools — use ONLY on explicit user request, never proactively.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "Capability or task to search registered tools for, e.g. 'ask a raw model a question' or 'list available models'",
      }),
    }),
    async execute(_toolCallId, params) {
      const terms = params.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const activeNames = new Set(pi.getActiveTools());
      const candidates = pi
        .getAllTools()
        .map((tool) => ({
          tool,
          score: terms.reduce(
            (score, term) =>
              score +
              (`${tool.name} ${tool.description}`.toLowerCase().includes(term) ? 1 : 0),
            0,
          ),
        }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score);

      const toAdd = candidates.filter((m) => !activeNames.has(m.tool.name)).map((m) => m.tool.name);
      const already = candidates
        .filter((m) => activeNames.has(m.tool.name))
        .map((m) => m.tool.name);

      if (toAdd.length === 0 && already.length === 0) {
        return {
          content: [
            { type: "text", text: `No registered tools found for: ${params.query}` },
          ],
          details: { matches: [], added: [] },
        };
      }

      if (toAdd.length > 0) {
        pi.setActiveTools([...new Set([...activeNames, ...toAdd])]);
      }

      const lines: string[] = [];
      if (toAdd.length > 0) lines.push(`Loaded tools: ${toAdd.join(", ")}`);
      if (already.length > 0) lines.push(`Already active: ${already.join(", ")}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { matches: [...toAdd, ...already], added: toAdd },
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Session setup: only built-ins + search_tools active by default.
  // raw_probe / list_raw_models stay registered but inactive until loaded.
  // ---------------------------------------------------------------------------
  pi.on("session_start", () => {
    const initial = pi.getActiveTools().filter((name) => !LAZY_TOOLS.has(name));
    pi.setActiveTools([...new Set([...initial, "search_tools"])]);
  });
}
