/**
 * /comment — open the last assistant reply in the browser as markdown, annotate
 * it with selection comments and an overall note, then load the feedback back
 * into pi's editor for review before sending.
 *
 * Minimal by design:
 * - One ephemeral localhost port per review (`server.listen(0)`) — no port pool.
 * - Single HTML page with inline CSS/JS; marked is vendored under web/vendor.
 * - The server inlines the markdown into the page (no /data round-trip).
 * - Submit/cancel round-trip via POST /submit and POST /cancel.
 * - session_shutdown cancels any open review (docs: long-lived resources).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const HOST = "127.0.0.1";
const TIMEOUT_MS = 60 * 60 * 1000; // auto-cancel a review left open for an hour
const MAX_BODY_BYTES = 1024 * 1024;
const STATUS_KEY = "pi-browser-comment";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");

// ─── types ─────────────────────────────────────────────────────────────────

export type Comment = { selectedText: string; comment: string };

export type ReviewOutcome =
	| { status: "submitted"; comments: Comment[]; overallNote: string }
	| { status: "cancelled"; reason: "user" | "replaced" | "timeout" | "shutdown" };

type ActiveReview = {
	sessionId: string;
	markdown: string;
	server: Server;
	timeout: NodeJS.Timeout;
	settle: (outcome: ReviewOutcome) => void;
};

// ─── last completed assistant message ───────────────────────────────────────

/**
 * Walk the current branch backwards for the last completed assistant message
 * (stopReason "stop") and join its text parts. Same contract as the qna
 * example extension.
 */
function lastAssistantText(branch: SessionEntry[]): { text?: string; error?: string } {
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

// ─── editor formatting ──────────────────────────────────────────────────────

/** Build editor text: anchored selection comments first, overall note last. */
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
		parts.push(`## Overall note\n\n${note}`);
	}

	return parts.join("\n\n");
}

// ─── open the platform browser ──────────────────────────────────────────────

/** Same safe pattern as pi's internal openBrowser: no shell, best-effort. */
function openBrowser(target: string): void {
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];

	spawn(cmd, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}

// ─── review server ──────────────────────────────────────────────────────────

/** One active review per pi session id; a new /comment replaces the old. */
const reviews = new Map<string, ActiveReview>();

let pageTemplate: string | null = null;

/** index.html with the vendored marked source inlined once (cached). */
async function getPageTemplate(): Promise<string> {
	if (pageTemplate === null) {
		const [html, markedSource] = await Promise.all([
			readFile(join(WEB_DIR, "index.html"), "utf8"),
			readFile(join(WEB_DIR, "vendor", "marked.min.js"), "utf8"),
		]);
		// Function replacement so `$` sequences in marked source are literal.
		pageTemplate = html.replace("__MARKED_SRC__", () => markedSource);
	}
	return pageTemplate;
}

export async function openReview(
	sessionId: string,
	markdown: string,
): Promise<{ url: string; result: Promise<ReviewOutcome> }> {
	// Supersede any in-flight review for this session.
	const existing = reviews.get(sessionId);
	if (existing) {
		await finish(existing, { status: "cancelled", reason: "replaced" });
	}

	let settle!: (outcome: ReviewOutcome) => void;
	const result = new Promise<ReviewOutcome>((resolve) => {
		settle = resolve;
	});

	const server = createServer((req, res) => {
		void handleRequest(sessionId, req, res);
	});
	const port = await listen(server);

	const review: ActiveReview = {
		sessionId,
		markdown,
		server,
		timeout: setTimeout(() => {
			const current = reviews.get(sessionId);
			if (current) void finish(current, { status: "cancelled", reason: "timeout" });
		}, TIMEOUT_MS),
		settle,
	};
	review.timeout.unref?.();
	reviews.set(sessionId, review);

	return { url: `http://${HOST}:${port}`, result };
}

export async function cancelSession(
	sessionId: string,
	reason: "user" | "shutdown" = "shutdown",
): Promise<void> {
	const review = reviews.get(sessionId);
	if (review) await finish(review, { status: "cancelled", reason });
}

export async function shutdownAll(): Promise<void> {
	const active = [...reviews.values()];
	await Promise.all(
		active.map((review) => finish(review, { status: "cancelled", reason: "shutdown" })),
	);
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (err: Error) => {
			server.off("error", onError);
			reject(err);
		};
		server.once("error", onError);
		server.listen(0, HOST, () => {
			server.off("error", onError);
			const address = server.address();
			resolve(typeof address === "object" && address !== null ? address.port : 0);
		});
	});
}

async function finish(review: ActiveReview, outcome: ReviewOutcome): Promise<void> {
	if (reviews.get(review.sessionId) !== review) return;

	clearTimeout(review.timeout);
	reviews.delete(review.sessionId);

	await new Promise<void>((resolve) => {
		review.server.close(() => resolve());
		// Force-close any hung connections so close() always completes.
		review.server.closeAllConnections?.();
	});

	review.settle(outcome);
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buf.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Request body too large"));
				req.destroy();
				return;
			}
			chunks.push(buf);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
	res.writeHead(status, {
		"Content-Type": contentType,
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function parseComments(value: unknown): Comment[] | null {
	if (!Array.isArray(value)) return null;
	const comments: Comment[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") return null;
		const { selectedText, comment } = item as Record<string, unknown>;
		if (typeof selectedText !== "string" || typeof comment !== "string") return null;
		const trimmed = { selectedText: selectedText.trim(), comment: comment.trim() };
		if (trimmed.selectedText && trimmed.comment) comments.push(trimmed);
	}
	return comments;
}

async function handleRequest(
	ownerSessionId: string,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	try {
		const review = reviews.get(ownerSessionId);
		if (!review) {
			send(res, 404, "text/plain; charset=utf-8", "Review not found");
			return;
		}

		const host = req.headers.host ?? `${HOST}:${(review.server.address() as { port: number }).port}`;
		const url = new URL(req.url ?? "/", `http://${host}`);
		const method = (req.method ?? "GET").toUpperCase();

		if (method === "GET" && (url.pathname === "/" || url.pathname === "")) {
			const page = (await getPageTemplate()).replaceAll("__PI_MD__", () =>
				// Escape `</script>` inside the string literal (\/ === / in JS).
				JSON.stringify(review.markdown).replace(/<\//g, "<\\/"),
			);
			send(res, 200, "text/html; charset=utf-8", page);
			return;
		}

		if (method === "POST" && url.pathname === "/submit") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(await readBody(req));
			} catch (err) {
				sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid JSON" });
				return;
			}
			const body = parsed as { comments?: unknown; overallNote?: unknown };
			const comments = parseComments(body.comments);
			if (!comments) {
				sendJson(res, 400, {
					error: "Body must be { comments: {selectedText, comment}[], overallNote?: string }",
				});
				return;
			}
			const overallNote = typeof body.overallNote === "string" ? body.overallNote.trim() : "";
			if (comments.length === 0 && !overallNote) {
				sendJson(res, 400, {
					error: "Add at least one selection comment or an overall note",
				});
				return;
			}

			sendJson(res, 200, { ok: true });
			await finish(review, { status: "submitted", comments, overallNote });
			return;
		}

		if (method === "POST" && url.pathname === "/cancel") {
			sendJson(res, 200, { ok: true });
			await finish(review, { status: "cancelled", reason: "user" });
			return;
		}

		send(res, 404, "text/plain; charset=utf-8", "Not found");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		sendJson(res, 500, { error: message });
	}
}

// ─── extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) await cancelSession(sessionId, "shutdown");
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.registerCommand("comment", {
		description: "Open last assistant reply in the browser for selection comments",
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

			const { text, error } = lastAssistantText(ctx.sessionManager.getBranch());
			if (!text) {
				ctx.ui.notify(error ?? "No assistant text found", "error");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, "Browser comment open…");
			ctx.ui.notify("Opening browser comment page…", "info");

			try {
				const { url, result } = await openReview(sessionId, text);
				openBrowser(url);
				ctx.ui.notify(`Comment page: ${url}`, "info");

				const outcome = await result;
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
				} else if (outcome.reason === "timeout") {
					ctx.ui.notify("Comment session timed out", "warning");
				} else if (outcome.reason === "shutdown") {
					ctx.ui.notify("Comment session closed (session ended)", "info");
				}
				// "replaced" — superseded by a newer /comment in this session, stay quiet.
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(message, "error");
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});
}
