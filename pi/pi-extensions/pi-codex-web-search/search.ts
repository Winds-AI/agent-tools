import { getCodexAuth } from "./auth.js";
import { readCodexRuntimeConfig } from "./codex-config.js";
import {
  CODEX_API_ENDPOINT,
  DEFAULT_MAX_SOURCES,
  DEFAULT_MODEL,
  MAX_ALLOWED_SOURCES,
  SEARCH_TIMEOUT_MS,
} from "./constants.js";
import type { WebSearchDetails, WebSearchInput, WebSearchSource } from "./types.js";

/**
 * Web search via the same backend Codex CLI uses
 * (https://chatgpt.com/backend-api/codex/responses).
 *
 * This mirrors how Codex handles web search natively:
 *  - the native `web_search` tool is declared to the Responses API;
 *  - the backend runs the search and emits a structured `web_search_call`
 *    item plus the model's final message;
 *  - we consume the *model's actual answer text* (output_text deltas) and
 *    surface it to pi along with the queries the backend actually ran.
 *
 * The backend never exposes raw page content to the caller, so the executed
 * queries are the only evidence of search coverage a caller can inspect. They
 * are included in the tool output for that reason.
 *
 * We deliberately do NOT ask the model to emit JSON from output_text and do
 * NOT JSON.parse model text: that was the source of intermittent
 * "Invalid API response: {...}" / malformed-JSON failures.
 */

interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  let event = "";
  let data = "";

  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) {
      event = line.slice(7);
    } else if (line.startsWith("data: ")) {
      data = line.slice(6);
    } else if (line === "" && event && data) {
      try {
        events.push({ type: event, data: JSON.parse(data) });
      } catch {
        // ignore malformed frames; they carry no useful payload
      }
      event = "";
      data = "";
    }
  }

  return events;
}

/** Extract the error message from a `response.failed` / `response.incomplete` SSE event. */
function sseErrorMessage(data: Record<string, unknown>): string | undefined {
  const response = data.response as { error?: { message?: string } } | undefined;
  const message = response?.error?.message?.trim();
  return message || undefined;
}

interface SearchRun {
  answer: string;
  /** Every query executed, across all search calls. */
  queries: string[];
  callCount: number;
  model: string;
  reasoningEffort: string | null;
}

/** HTTP-level failure, carrying enough context to decide whether a retry is safe. */
class SearchHttpError extends Error {
  readonly status: number;
  /** True if answer text was already streamed to the caller before failing. */
  readonly emitted: boolean;

  constructor(message: string, status: number, emitted: boolean) {
    super(message);
    this.name = "SearchHttpError";
    this.status = status;
    this.emitted = emitted;
  }
}

function buildInstructions(freshness: "cached" | "live", maxSources: number): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "You are performing web research for a coding agent.",
    // Without the current date the model cannot tell how stale a source is, and
    // answers about "the latest X" can silently settle on an older release.
    `Today's date is ${today} (UTC).`,
    "Use the provided web_search tool, then answer the user's query in a concise, well-formatted way.",
    freshness === "live"
      ? "Prioritize the most recent and up-to-date information available. When asked for the latest or current state of something, run date-scoped queries (include the current month and year) and confirm each source's date before claiming it is the newest."
      : "Cached results are fine; prioritize accuracy over recency.",
    "Include the relevant source URLs as markdown links in your answer.",
    `Keep the summary concise and useful. Reference at most ${maxSources} distinct sources.`,
  ].join("\n");
}

/** Tracking parameters that duplicate the same page under multiple URLs. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "frmapp",
]);

function canonicalUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    for (const param of [...parsed.searchParams.keys()]) {
      const lowered = param.toLowerCase();
      if (TRACKING_PARAMS.has(lowered) || lowered.startsWith("utm_")) {
        parsed.searchParams.delete(param);
      }
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Collect the source URLs cited in the answer, de-duplicated by canonical URL so
 * the same page reached through tracking parameters is not reported twice.
 */
export function extractSources(answer: string, maxSources: number): WebSearchSource[] {
  const seen = new Set<string>();
  const sources: WebSearchSource[] = [];
  for (const raw of answer.match(/https?:\/\/[^\s)\]]+/g) ?? []) {
    const url = raw.replace(/[.,;:]+$/u, "");
    const key = canonicalUrlKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ title: url, url, snippet: "" });
    if (sources.length >= maxSources) break;
  }
  return sources;
}

function formatSearchFooter(run: SearchRun, sources: WebSearchSource[]): string {
  const lines = [""];
  if (run.queries.length > 0) {
    lines.push("---", `executed queries: ${run.queries.join(" | ")}`);
  }
  if (sources.length > 0) {
    if (lines.length === 1) lines.push("---");
    lines.push(`sources: ${sources.map((source) => source.url).join(" | ")}`);
  }
  if (lines.length > 1) {
    lines.push(
      "(Synthesized summary, not raw page content — check the executed queries when recency matters.)"
    );
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

export async function executeWebSearch(
  input: WebSearchInput,
  options?: {
    signal?: AbortSignal;
    onUpdate?: (update: { content: { type: "text"; text: string }[]; details: unknown }) => void;
  }
) {
  const query = input.query.trim();
  if (!query) throw new Error("web_search requires a non-empty query.");

  const maxSources = Math.min(
    Math.max(Math.trunc(input.maxSources ?? DEFAULT_MAX_SOURCES), 1),
    MAX_ALLOWED_SOURCES
  );
  const freshness = input.freshness ?? "cached";
  const auth = await getCodexAuth();
  const runtime = await readCodexRuntimeConfig();
  const instructions = buildInstructions(freshness, maxSources);

  const performSearch = async (
    model: string,
    reasoningEffort: string | null,
    verbosity: string | null
  ): Promise<SearchRun> => {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), SEARCH_TIMEOUT_MS);
    options?.signal?.addEventListener("abort", () => abortController.abort(options.signal?.reason), {
      once: true,
    });

    let emitted = false;
    try {
      const response = await fetch(CODEX_API_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.accessToken}`,
          "ChatGPT-Account-ID": auth.accountId,
        },
        body: JSON.stringify({
          model,
          // Tell the model to answer the query naturally (like Codex does).
          // No JSON schema in output_text — that was the source of failures.
          instructions,
          input: [{ role: "user", content: query }],
          // Same shape Codex sends: cached -> external_web_access:false,
          // live -> external_web_access:true (see hosted_spec.rs in codex-rs).
          tools: [
            {
              type: "web_search",
              external_web_access: freshness === "live",
              indexed_web_access: freshness === "live" ? undefined : null,
            },
          ],
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
          ...(verbosity ? { text: { verbosity } } : {}),
          store: false,
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const error = await response.text().catch(() => "Unknown error");
        if (response.status === 401) {
          throw new SearchHttpError("Authentication failed. Run `codex login`.", 401, emitted);
        }
        if (response.status === 429) {
          throw new SearchHttpError("Rate limited. Try again in a moment.", 429, emitted);
        }
        throw new SearchHttpError(
          `API error (${response.status}): ${error.slice(0, 500)}`,
          response.status,
          emitted
        );
      }

      // Consume the SSE stream exactly like Codex: collect the web_search_call
      // items (what was searched) and stream the model's answer text.
      let answer = "";
      let callCount = 0;
      const queries = new Set<string>();
      const emit = () =>
        options?.onUpdate?.({
          content: [{ type: "text", text: answer || "Searching…" }],
          details: {
            query,
            freshness,
            sourceCount: 0,
            sources: [],
            summary: answer,
            truncated: false,
            streaming: true,
            model,
          },
        });

      for (const event of parseSSE(await response.text())) {
        if (event.type === "response.output_text.delta") {
          answer += event.data.delta ?? "";
          emitted = true;
          emit();
        } else if (event.type === "response.output_item.done") {
          const item = event.data.item as {
            type?: string;
            action?: { type?: string; queries?: string[]; query?: string };
          };
          if (item?.type === "web_search_call") {
            // The backend can issue several search calls in one turn; earlier
            // revisions kept only the last one, which under-reported coverage.
            callCount += 1;
            if (item.action?.type === "search") {
              for (const executed of item.action.queries ?? []) {
                const trimmed = executed.trim();
                if (trimmed) queries.add(trimmed);
              }
              const single = item.action.query?.trim();
              if (single) queries.add(single);
            }
          }
        } else if (event.type === "response.failed" || event.type === "response.incomplete") {
          const message = sseErrorMessage(event.data);
          throw new SearchHttpError(
            message ?? "Web search request failed.",
            response.status,
            emitted
          );
        }
      }

      if (!answer.trim()) {
        throw new SearchHttpError("Web search returned no answer.", response.status, emitted);
      }

      return { answer, queries: [...queries], callCount, model, reasoningEffort };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  let run: SearchRun;
  try {
    run = await performSearch(runtime.model, runtime.reasoningEffort, runtime.verbosity);
  } catch (error) {
    // A value taken from config.toml (unknown model id, unsupported reasoning
    // effort, or a model owned by a non-OpenAI provider) must not take search
    // down entirely — fall back to the built-in model and backend defaults.
    const recoverable =
      error instanceof SearchHttpError &&
      error.status === 400 &&
      !error.emitted &&
      (runtime.model !== DEFAULT_MODEL ||
        runtime.reasoningEffort !== null ||
        runtime.verbosity !== null);
    if (!recoverable) throw error;
    run = await performSearch(DEFAULT_MODEL, null, null);
  }

  const sources = extractSources(run.answer, maxSources);

  const details: WebSearchDetails = {
    query,
    freshness,
    sourceCount: sources.length,
    sources,
    summary: run.answer,
    truncated: false,
    searchedQueries: run.queries,
    searchCallCount: run.callCount,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
  };

  return {
    content: [{ type: "text" as const, text: `${run.answer}${formatSearchFooter(run, sources)}` }],
    details,
  };
}
