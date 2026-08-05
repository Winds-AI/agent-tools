import type { Comment } from "./types.ts";

/**
 * Build editor text for the agent.
 * - Anchored selection comments first (creation order)
 * - Overall note last (not tied to any selection)
 */
export function formatCommentsForEditor(comments: Comment[], overallNote = ""): string {
	const parts: string[] = [];

	if (comments.length > 0) {
		const blocks = comments.map((item, index) => {
			const quoted = item.selectedText
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n");
			return `### ${index + 1}\nRegarding:\n${quoted}\n\nComment: ${item.comment}`;
		});
		parts.push(`## Comments\n\n${blocks.join("\n\n")}`);
	}

	const note = overallNote.trim();
	if (note) {
		// Global freeform feedback — not anchored to a selection.
		parts.push(`## Overall note\n\n${note}`);
	}

	return parts.join("\n\n");
}
