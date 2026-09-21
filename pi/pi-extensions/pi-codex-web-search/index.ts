import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AuthError, checkAuth } from "./auth.js";
import { TOOL_NAME } from "./constants.js";
import { executeWebSearch } from "./search.js";
import type { WebSearchDetails, WebSearchInput } from "./types.js";

export default function nativeWebSearchExtension(pi: ExtensionAPI) {
  let authError: string | null = null;

  checkAuth().catch((error) => {
    authError = error instanceof AuthError ? error.message : String(error);
  });

  interface RenderState {
    startedAt?: number;
    endedAt?: number;
    interval?: ReturnType<typeof setInterval>;
  }

  function formatDuration(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: "Web Search",
    description:
      "Search the public web and return a concise synthesized summary with sources. The backend returns prose rather than raw page content, so the executed queries and source URLs are appended to the output for callers to judge coverage. Use cached freshness for stable topics and live freshness for time-sensitive queries.",
    promptSnippet:
      "Use web_search for anything time-sensitive or unverifiable from training data; prefer searching over recalling. It returns a synthesized answer plus the queries the backend actually ran — check those queries when recency matters.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for on the web" }),
      maxSources: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of sources (default: 5)" })
      ),
      freshness: Type.Optional(
        StringEnum(["cached", "live"] as const, {
          description: "Use 'cached' for stable topics, 'live' for time-sensitive queries.",
        })
      ),
    }),
    // Prefer strict JSON-schema sampling on providers that support it. Pi 0.86
    // enables this for built-in tools; extension tools opt in explicitly.
    // "prefer" degrades silently on models without strict-tool support.
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params: WebSearchInput, signal, onUpdate, _ctx) {
      if (authError) {
        throw new Error(`Web search unavailable: ${authError}\n\nRun \`codex login\` to authenticate.`);
      }
      return executeWebSearch(params, { signal, onUpdate });
    },
    renderCall(args, theme, context) {
      const state = context.state as RenderState;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      let text = theme.fg("toolTitle", theme.bold("web_search "));
      text += theme.fg("accent", args.query.length > 90 ? args.query.slice(0, 89) + "…" : args.query);
      text += theme.fg("dim", ` [${args.freshness ?? "cached"}]`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const state = context.state as RenderState;
      // Live elapsed timer while streaming, exactly like the bash tool.
      if (state.startedAt !== undefined && isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }

      const details = result.details as Partial<WebSearchDetails> | undefined;
      const content = result.content.find((p) => p.type === "text");
      const text = content?.type === "text" ? content.text : "";

      // Errors carry no details; render the message instead of [undefined] noise.
      if (context.isError) {
        return new Text(theme.fg("error", text || "Web search failed."), 0, 0);
      }

      const timing =
        state.startedAt !== undefined
          ? theme.fg("muted", `${isPartial ? "Elapsed" : "Took"} ${formatDuration((state.endedAt ?? Date.now()) - state.startedAt)}`)
          : "";

      if (!details?.sourceCount && !text) {
        return new Text(text || theme.fg("success", "✓ Web search finished") + (timing ? `\n${timing}` : ""), 0, 0);
      }

      // Live streaming: just show the answer as it arrives.
      if (details?.streaming || isPartial) {
        if (!text) return new Text(theme.fg("dim", "Searching…"), 0, 0);
        let status = theme.fg("dim", "web_search ") + theme.fg("muted", "[live]");
        if (timing) status += ` ${timing}`;
        status += `\n${text}`;
        return new Text(status, 0, 0);
      }

      let status = theme.fg("success", `✓ ${details?.sourceCount ?? 0} source${details?.sourceCount === 1 ? "" : "s"}`);
      status += theme.fg("muted", ` [${details?.freshness}]`);
      if (timing) status += ` ${timing}`;

      if (!expanded) {
        status += theme.fg("dim", " (Ctrl+O to expand)");
        if (details?.summary) {
          const preview = details.summary.length > 110 ? details.summary.slice(0, 109) + "…" : details.summary;
          status += `\n${theme.fg("dim", preview)}`;
        }
        return new Text(status, 0, 0);
      }

      status += `\n${theme.fg("muted", `Query: ${details?.query}`)}`;
      if (details?.model) {
        // Shown here for the operator only. This is deliberately NOT part of the
        // tool output, so it never lands in the model's context.
        const searches = details.searchCallCount ?? 0;
        const parts = [
          `${details.model}${details.reasoningEffort ? `@${details.reasoningEffort}` : ""}`,
        ];
        if (searches > 0) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
        const queries = details.searchedQueries?.length ?? 0;
        if (queries > 0) parts.push(`${queries} quer${queries === 1 ? "y" : "ies"}`);
        status += theme.fg("dim", ` · ${parts.join(" · ")}`);
      }
      if (text) {
        status += `\n\n${text.split("\n").map((l) => theme.fg("toolOutput", l)).join("\n")}`;
      }
      return new Text(status, 0, 0);
    },
  });
}
