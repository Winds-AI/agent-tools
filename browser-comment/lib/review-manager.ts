import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Comment, ReviewOutcome, ReviewRequest } from "./types.ts";

/** Fixed 10-port pool for multi-session isolation without random ports. */
export const PORT_BASE = 18760;
export const PORT_COUNT = 10;

const HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".map": "application/json; charset=utf-8",
};

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

type ActiveReview = {
	sessionId: string;
	port: number;
	markdown: string;
	server: Server;
	timeout: NodeJS.Timeout;
	settle: (outcome: ReviewOutcome) => void;
};

function hashSessionId(sessionId: string): number {
	let h = 0;
	for (let i = 0; i < sessionId.length; i++) {
		h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
	}
	return h;
}

function preferredPort(sessionId: string): number {
	return PORT_BASE + (hashSessionId(sessionId) % PORT_COUNT);
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store",
	});
	res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
	res.writeHead(status, {
		"Content-Type": contentType,
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	res.end(body);
}

function isCommentArray(value: unknown): value is Comment[] {
	if (!Array.isArray(value)) return false;
	return value.every(
		(item) =>
			!!item &&
			typeof item === "object" &&
			typeof (item as Comment).id === "string" &&
			typeof (item as Comment).selectedText === "string" &&
			typeof (item as Comment).comment === "string",
	);
}

/**
 * Process-local review orchestrator.
 * - Ports: 18760–18769
 * - Isolation key: Pi session id (path /s/:sessionId)
 * - One active review per session id (latest /comment replaces prior)
 */
export class ReviewManager {
	private readonly bySession = new Map<string, ActiveReview>();
	private readonly byPort = new Map<number, string>();

	/**
	 * Start (or replace) a review for sessionId.
	 * Returns the page URL immediately; await `result` for submit/cancel.
	 */
	async openReview(request: ReviewRequest): Promise<{ url: string; result: Promise<ReviewOutcome> }> {
		const { sessionId, markdown } = request;
		const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		// Replace any in-flight review for this session.
		const existing = this.bySession.get(sessionId);
		if (existing) {
			await this.finish(existing, { status: "cancelled", reason: "replaced" });
		}

		let settle!: (outcome: ReviewOutcome) => void;
		const promise = new Promise<ReviewOutcome>((resolve) => {
			settle = resolve;
		});

		const server = createServer((req, res) => {
			void this.handleRequest(sessionId, req, res);
		});

		// Bind with retry across the fixed pool (handles races with canListen).
		const start = preferredPort(sessionId);
		let port: number | undefined;
		let lastError: unknown;
		for (let i = 0; i < PORT_COUNT; i++) {
			const candidate = PORT_BASE + ((start - PORT_BASE + i) % PORT_COUNT);
			if (this.byPort.has(candidate)) continue;
			try {
				await this.listen(server, candidate);
				port = candidate;
				break;
			} catch (err) {
				lastError = err;
			}
		}
		if (port === undefined) {
			server.close();
			throw new Error(
				`All browser-comment ports busy (${PORT_BASE}–${PORT_BASE + PORT_COUNT - 1}).` +
					(lastError instanceof Error ? ` Last error: ${lastError.message}` : ""),
			);
		}

		const timeout = setTimeout(() => {
			const review = this.bySession.get(sessionId);
			if (review) {
				void this.finish(review, { status: "cancelled", reason: "timeout" });
			}
		}, timeoutMs);
		timeout.unref?.();

		const review: ActiveReview = {
			sessionId,
			port,
			markdown,
			server,
			timeout,
			settle,
		};

		this.bySession.set(sessionId, review);
		this.byPort.set(port, sessionId);

		const url = `http://${HOST}:${port}/s/${encodeURIComponent(sessionId)}`;
		return { url, result: promise };
	}

	/** Cancel a single session review (e.g. session_shutdown). */
	async cancelSession(sessionId: string, reason: "shutdown" | "user" = "shutdown"): Promise<void> {
		const review = this.bySession.get(sessionId);
		if (!review) return;
		await this.finish(review, { status: "cancelled", reason });
	}

	/** Cancel everything (process teardown / extension reload). */
	async shutdownAll(): Promise<void> {
		const reviews = [...this.bySession.values()];
		await Promise.all(reviews.map((review) => this.finish(review, { status: "cancelled", reason: "shutdown" })));
	}

	private listen(server: Server, port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const onError = (err: Error) => {
				server.off("error", onError);
				reject(err);
			};
			server.once("error", onError);
			server.listen(port, HOST, () => {
				server.off("error", onError);
				resolve();
			});
		});
	}

	private async finish(review: ActiveReview, outcome: ReviewOutcome): Promise<void> {
		if (this.bySession.get(review.sessionId) !== review) return;

		clearTimeout(review.timeout);
		this.bySession.delete(review.sessionId);
		this.byPort.delete(review.port);

		await new Promise<void>((resolve) => {
			review.server.close(() => resolve());
			// Force-close hung connections
			review.server.closeAllConnections?.();
		});

		review.settle(outcome);
	}

	private async handleRequest(
		ownerSessionId: string,
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const review = this.bySession.get(ownerSessionId);
			if (!review) {
				sendText(res, 404, "Review not found", "text/plain; charset=utf-8");
				return;
			}

			const host = req.headers.host ?? `${HOST}:${review.port}`;
			const url = new URL(req.url ?? "/", `http://${host}`);
			const method = (req.method ?? "GET").toUpperCase();

			// Static assets: /assets/*
			if (method === "GET" && url.pathname.startsWith("/assets/")) {
				await this.serveAsset(url.pathname.slice("/assets/".length), res);
				return;
			}

			// Session routes: /s/:sessionId[...]
			const sessionMatch = url.pathname.match(/^\/s\/([^/]+)(\/.*)?$/);
			if (!sessionMatch) {
				sendText(res, 404, "Not found", "text/plain; charset=utf-8");
				return;
			}

			const sessionId = decodeURIComponent(sessionMatch[1]);
			const rest = sessionMatch[2] ?? "";

			// Path session must match the server's bound session (isolation).
			if (sessionId !== ownerSessionId) {
				sendText(res, 404, "Session mismatch", "text/plain; charset=utf-8");
				return;
			}

			if (method === "GET" && (rest === "" || rest === "/")) {
				await this.serveAsset("index.html", res);
				return;
			}

			if (method === "GET" && rest === "/data") {
				sendJson(res, 200, { markdown: review.markdown });
				return;
			}

			if (method === "POST" && rest === "/submit") {
				const raw = await readBody(req);
				let parsed: unknown;
				try {
					parsed = JSON.parse(raw);
				} catch {
					sendJson(res, 400, { error: "Invalid JSON" });
					return;
				}

				const body = parsed as { comments?: unknown; overallNote?: unknown };
				const comments = body.comments;
				if (!isCommentArray(comments)) {
					sendJson(res, 400, { error: "Body must be { comments: Comment[], overallNote?: string }" });
					return;
				}

				const cleaned = comments
					.map((c) => ({
						id: c.id,
						selectedText: c.selectedText.trim(),
						comment: c.comment.trim(),
					}))
					.filter((c) => c.selectedText.length > 0 && c.comment.length > 0);

				const overallNote =
					typeof body.overallNote === "string" ? body.overallNote.trim() : "";

				if (cleaned.length === 0 && !overallNote) {
					sendJson(res, 400, {
						error: "Add at least one selection comment or an overall note",
					});
					return;
				}

				sendJson(res, 200, { ok: true });
				await this.finish(review, {
					status: "submitted",
					comments: cleaned,
					overallNote,
				});
				return;
			}

			if (method === "POST" && rest === "/cancel") {
				sendJson(res, 200, { ok: true });
				await this.finish(review, { status: "cancelled", reason: "user" });
				return;
			}

			sendText(res, 404, "Not found", "text/plain; charset=utf-8");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(res, 500, { error: message });
		}
	}

	private async serveAsset(relativePath: string, res: ServerResponse): Promise<void> {
		// Prevent path traversal.
		const safe = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
		if (safe.includes("..") || safe.includes("\0")) {
			sendText(res, 400, "Bad path", "text/plain; charset=utf-8");
			return;
		}

		const filePath = join(WEB_DIR, safe);
		if (!filePath.startsWith(WEB_DIR)) {
			sendText(res, 400, "Bad path", "text/plain; charset=utf-8");
			return;
		}

		try {
			const data = await readFile(filePath);
			const type = MIME[extname(filePath)] ?? "application/octet-stream";
			res.writeHead(200, {
				"Content-Type": type,
				"Content-Length": data.byteLength,
				"Cache-Control": "no-store",
			});
			res.end(data);
		} catch {
			sendText(res, 404, "Asset not found", "text/plain; charset=utf-8");
		}
	}
}

/** Shared manager for this extension process. */
export const reviewManager = new ReviewManager();
