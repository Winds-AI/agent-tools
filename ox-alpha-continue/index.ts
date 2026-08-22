/**
 * ox-alpha-continue — workaround for OX-Alpha's premature empty stops.
 *
 * OX-Alpha (any provider) sometimes ends a turn with an empty response:
 * stop reason "stop" and no text or tool calls, typically right after tool
 * results, as if the deployment dropped the continuation.
 *
 * Instead of queueing a synthetic "Continue." user message (which pollutes the
 * transcript and the model's context), this extension reclassifies the empty
 * response as a transient server error via the message_end replacement hook.
 * Pi's built-in auto-retry machinery then takes over: it drops the error
 * message from agent state, waits with exponential backoff, and re-enters the
 * agent loop with agent.continue() — the same no-user-message continuation
 * path OpenCode uses for unknown finish reasons. Bounded by the retry budget
 * in Pi's retry settings; no infinite loops.
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

    // Only the pathological case: stop reason "stop" with no text and no tool
    // calls (thinking alone doesn't count as output).
    if (msg.stopReason !== "stop" || msg.rawStopReason !== "stop") return;
    const isEmpty = !(msg.content ?? []).some(
      (block) =>
        block.type === "toolCall" || (block.type === "text" && block.text.trim().length > 0),
    );
    if (!isEmpty) return;

    // Reclassify as a retryable server error. The wording matches Pi's
    // retryable-error classifier (see pi-ai utils/retry.ts), so post-run
    // handling removes this message from context and continues the loop.
    return {
      message: {
        ...msg,
        stopReason: "error" as const,
        errorMessage:
          "server error: OX-Alpha returned an empty stop response; auto-continuing",
      },
    };
  });
}
