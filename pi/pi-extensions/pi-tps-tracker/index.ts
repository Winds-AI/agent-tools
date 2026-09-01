/**
 * TPS Tracker Extension
 *
 * Shows time-to-first-delta (TTFD) and tokens/sec (TPS) in the footer, live:
 * - Updates DURING streaming, on every output delta — not only after completion
 * - Averages are computed over the last N assistant responses (sliding window,
 *   tool calls included) so long sessions stay responsive and cheap
 * - In-memory only. Shows zeros before the first assistant response.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WINDOW_SIZE = 15; // average over the last N assistant responses

export default function (pi: ExtensionAPI) {
	// ---- Sliding window of recent responses (in-memory) ----
	const window: { tokens: number; ms: number }[] = [];
	let sessionActive = false; // true once any assistant response has been seen

	// ---- Per-message state ----
	let msgStart: number | null = null;    // assistant message start (for TTFD)
	let streamStart: number | null = null; // first delta time
	let msgEstimatedTokens = 0;            // fallback estimate while streaming
	let lastTtfdMs: number | null = null;  // TTFD of the most recent message

	function windowTotals() {
		return window.reduce(
			(acc, m) => ({ tokens: acc.tokens + m.tokens, ms: acc.ms + m.ms }),
			{ tokens: 0, ms: 0 },
		);
	}

	function render(ctx: any, opts: { live?: boolean; ttfdMs?: number | null; tokens?: number; elapsedS?: number; count?: number }) {
		const theme = ctx.ui.theme;
		const ttfd = opts.ttfdMs != null
			? theme.fg("accent", `${(opts.ttfdMs / 1000).toFixed(1)}s`)
			: theme.fg("dim", "--");
		const tps = opts.tokens != null && opts.elapsedS != null && opts.elapsedS > 0 && opts.tokens > 0
			? theme.fg("accent", `${Math.round(opts.tokens / opts.elapsedS)} tok/s`)
			: theme.fg("dim", "0 tok/s");
		const tokens = opts.tokens ?? 0;
		const elapsed = opts.elapsedS ?? 0;
		const count = opts.count ?? 0;
		const suffix = opts.live ? theme.fg("dim", " …") : "";
		ctx.ui.setStatus("tps", `${theme.fg("dim", "ttfd")} ${ttfd}  ${tps} ${theme.fg("dim", `(${tokens} tok / ${elapsed.toFixed(1)}s, last ${count})${suffix}`)}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		window.length = 0;
		sessionActive = false;
		msgStart = null;
		streamStart = null;
		msgEstimatedTokens = 0;
		lastTtfdMs = null;
		render(ctx, { ttfdMs: null, tokens: 0, elapsedS: 0, count: 0 });
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		msgStart = Date.now();
		streamStart = null;
		msgEstimatedTokens = 0;
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const e = event.assistantMessageEvent;
		if (e.type !== "text_delta" && e.type !== "thinking_delta" && e.type !== "toolcall_delta") return;

		const now = Date.now();
		streamStart ??= now;
		msgEstimatedTokens += Math.max(0, e.delta.length / 4);

		const official = event.message.usage?.output ?? 0;
		const tokens = official > 0 ? official : Math.round(msgEstimatedTokens);
		const elapsedS = (now - streamStart) / 1000;
		const ttfdMs = streamStart - (msgStart ?? streamStart);

		sessionActive = true;
		render(ctx, { live: true, ttfdMs, tokens, elapsedS, count: window.length });
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const official = event.message.usage?.output ?? 0;
		const tokens = official > 0 ? official : Math.round(msgEstimatedTokens);
		const timingStart = streamStart ?? msgStart;
		if (timingStart && tokens > 0) {
			// Add to the sliding window, keep only the last WINDOW_SIZE responses.
			window.push({ tokens, ms: Math.max(0, Date.now() - timingStart) });
			if (window.length > WINDOW_SIZE) window.shift();
			sessionActive = true;
		}
		if (streamStart && msgStart) lastTtfdMs = streamStart - msgStart;

		msgStart = null;
		streamStart = null;
		msgEstimatedTokens = 0;

		// Re-render with the sliding-window average immediately (not only at agent end).
		const totals = windowTotals();
		const avgS = totals.ms / 1000;
		render(ctx, { ttfdMs: lastTtfdMs, tokens: totals.tokens, elapsedS: avgS, count: window.length });
	});

	pi.on("agent_end", async (_event, ctx) => {
		const totals = windowTotals();
		const avgS = totals.ms / 1000;
		render(ctx, { ttfdMs: lastTtfdMs, tokens: totals.tokens, elapsedS: avgS, count: window.length });
		if (sessionActive && totals.tokens > 0) {
			const theme = ctx.ui.theme;
			ctx.ui.notify(
				`${theme.fg("success", "✓")} ${theme.fg("accent", `${Math.round(totals.tokens / avgS)} tok/s`)}  ${theme.fg("dim", `${totals.tokens} tokens in ${avgS.toFixed(1)}s streaming, last ${window.length}`)}`,
				"info",
			);
		}
	});
}
