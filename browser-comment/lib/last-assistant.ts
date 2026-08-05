import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Last completed assistant text on the current branch.
 * Mirrors the qna / Mario comment extension contract:
 * walk branch backwards, require stopReason === "stop", join text parts.
 */
export function getLastAssistantText(branch: SessionEntry[]): {
	text?: string;
	error?: string;
} {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;

		const message = entry.message;
		if (!message || typeof message !== "object" || !("role" in message)) continue;
		if (message.role !== "assistant") continue;

		const stopReason = "stopReason" in message ? message.stopReason : undefined;
		if (stopReason !== "stop") {
			return {
				error: `Last assistant message is incomplete (${String(stopReason ?? "unknown")})`,
			};
		}

		const content = "content" in message ? message.content : undefined;
		if (!Array.isArray(content)) {
			return { error: "Last assistant message has no text content" };
		}

		const text = content
			.filter(
				(part): part is { type: "text"; text: string } =>
					!!part &&
					typeof part === "object" &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n")
			.trim();

		if (!text) {
			return { error: "Last assistant message has no text content" };
		}

		return { text };
	}

	return { error: "No completed assistant message found on the current branch" };
}
