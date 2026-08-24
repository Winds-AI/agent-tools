/**
 * ox-alpha-continue — keep the loop alive when OX-Alpha drops a turn.
 *
 * OX-Alpha (any provider) intermittently ends a turn with no usable output.
 * Initially this was `stopReason:"stop"` with no text/tool calls (empty stop
 * right after tool results, as if the deployment dropped the continuation).
 *
 * Newer variant (Aug 2026, stealth/ox-alpha on OpenRouter):
 * `stopReason:"error"` with `errorMessage:"ERROR"` and empty content,
 * or `errorMessage:"JSON error injected into SSE stream"` with only thinking.
 * Both are transient provider failures — but Pi's retry classifier
 * (pi-ai utils/retry.ts: `server.?error|overloaded|provider.?returned.?error|...`)
 * does not match a bare "ERROR", so Pi treats them as terminal and stalls.
 *
 * Instead of queueing a synthetic "Continue." user message (which pollutes the
 * transcript and the model's context), this extension reclassifies those empty
 * responses as transient server errors via the message_end replacement hook.
 * Pi's built-in auto-retry machinery then takes over: it drops the error
 * message from agent state, waits with exponential backoff, and re-enters the
 * agent loop with agent.continue() — the same no-user-message continuation
 * path OpenCode uses for unknown finish reasons. Bounded by the retry budget
 * in Pi's retry settings; no infinite loops. `aborted` is never retried.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isOxAlpha(idOrName: string | undefined): boolean {
  return !!idOrName && /ox-alpha/i.test(idOrName);
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;

    // Only for OX-Alpha, regardless of provider.
    if (!isOxAlpha(ctx.model?.id) && !isOxAlpha(ctx.model?.name) && !isOxAlpha(msg.model)) {
      return;
    }

    const isEmpty = !(msg.content ?? []).some(
      (block) =>
        block.type === "toolCall" || (block.type === "text" && block.text.trim().length > 0),
    );

    // Case 1: classic empty stop — `stop:"stop"` with no text/tool calls.
    // Thinking alone doesn't count as output.
    if (msg.stopReason === "stop" && msg.rawStopReason === "stop" && isEmpty) {
      return {
        message: {
          ...msg,
          stopReason: "error" as const,
          errorMessage:
            "server error: OX-Alpha returned an empty stop response; auto-continuing",
        },
      };
    }

    // Case 2: newer transient errors — `error:"ERROR"` or
    // `error:"JSON error injected into SSE stream"` with no usable content.
    // These are provider-side failures but Pi's retry classifier does not
    // match a bare "ERROR", so they would otherwise be terminal. Thinking
    // alone doesn't count as output. `aborted` is never handled here.
    if (msg.stopReason === "error" && isEmpty) {
      const em = (msg.errorMessage ?? "").trim();
      const isNewTransient =
        em === "ERROR" || em === "JSON error injected into SSE stream";
      if (isNewTransient) {
        return {
          message: {
            ...msg,
            // keep stopReason:"error", just make errorMessage retryable
            errorMessage: `server error: OX-Alpha transient error (${em}); auto-continuing`,
          },
        };
      }
    }
  });
}
