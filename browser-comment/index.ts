/**
 * /comment — browser selection comments on the last assistant reply.
 *
 * Architecture (pi-native):
 * - registerCommand + hasUI guard (qna / Mario comment pattern)
 * - sessionManager.getBranch() + getSessionId() for content + isolation
 * - setEditorText() handoff back into the prompt box
 * - session_shutdown cleanup for localhost servers (docs: long-lived resources)
 * - Fixed port pool 18760–18769; multi-session isolation via session id path
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureFrontmostApp, restoreFrontmostApp } from "./lib/focus-restore.ts";
import { formatCommentsForEditor } from "./lib/format-comments.ts";
import { getLastAssistantText } from "./lib/last-assistant.ts";
import { openBrowser } from "./lib/open-browser.ts";
import { PORT_BASE, PORT_COUNT, reviewManager } from "./lib/review-manager.ts";

const STATUS_KEY = "browser-comment";

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		await reviewManager.cancelSession(sessionId, "shutdown");
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.registerCommand("comment", {
		description:
			"Open last assistant reply in the browser for selection comments (ports " +
			`${PORT_BASE}–${PORT_BASE + PORT_COUNT - 1})`,
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("comment requires interactive mode", "error");
				return;
			}

			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) {
				ctx.ui.notify("No session id available", "error");
				return;
			}

			const { text, error } = getLastAssistantText(ctx.sessionManager.getBranch());
			if (!text) {
				ctx.ui.notify(error ?? "No assistant text found", "error");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, "Browser comment open…");
			ctx.ui.notify("Opening browser comment page…", "info");

			// Capture before browser steals focus (macOS). Restore only after an
			// explicit browser submit/cancel, not timeout, replacement, or shutdown.
			const previousApp = captureFrontmostApp();
			let shouldRestoreFocus = false;

			try {
				const { url, result } = await reviewManager.openReview({
					sessionId,
					markdown: text,
				});

				openBrowser(url);
				ctx.ui.notify(`Comment page: ${url}`, "info");

				const outcome = await result;
				shouldRestoreFocus =
					outcome.status === "submitted" || outcome.reason === "user";

				if (outcome.status === "submitted") {
					ctx.ui.setEditorText(
						formatCommentsForEditor(outcome.comments, outcome.overallNote),
					);
					const n = outcome.comments.length;
					const hasNote = outcome.overallNote.trim().length > 0;
					const parts = [
						n > 0 ? `${n} comment${n === 1 ? "" : "s"}` : null,
						hasNote ? "overall note" : null,
					].filter(Boolean);
					ctx.ui.notify(`Loaded ${parts.join(" + ")} into the editor`, "info");
					return;
				}

				if (outcome.reason === "user") {
					ctx.ui.notify("Comment session cancelled", "info");
				} else if (outcome.reason === "replaced") {
					// Superseded by a newer /comment in this session — stay quiet.
				} else if (outcome.reason === "timeout") {
					ctx.ui.notify("Comment session timed out", "warning");
				} else if (outcome.reason === "shutdown") {
					ctx.ui.notify("Comment session closed (session ended)", "info");
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(message, "error");
			} finally {
				if (shouldRestoreFocus) restoreFrontmostApp(previousApp);
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});
}
