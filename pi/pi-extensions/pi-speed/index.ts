/**
 * pi-speed — generation speed and per-turn elapsed time for pi.
 *
 * Job 1 — speed (in-memory, live):
 *   Rolling-window tokens/sec across the last WINDOW_SIZE assistant
 *   responses, shown in the footer. The window keeps computation O(1) no
 *   matter how long the session grows.
 *
 * Job 2 — timer (live beside the working indicator, final value persisted):
 *   Every user message starts a fresh timer that ticks inside the working
 *   row: `⠇ Working · ⏱ 36s`. When the run settles, the final duration is
 *   appended as a custom entry (`pi-speed:worked-for`) so a
 *   "worked for 4m 21s" line is rendered in the transcript after each turn.
 *   It survives /resume, /reload, and restarts. Only the final duration is
 *   persisted; the live ticking stays in memory.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const WINDOW_SIZE = 15; // average over the last N assistant responses
const ENTRY_TYPE = "pi-speed:worked-for";
const MIN_PERSIST_SECONDS = 1; // don't persist instant/failed runs

/** Format seconds as "42s", "4m 21s", or "1h 04m 21s". */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export default function (pi: ExtensionAPI) {
  // ---- rolling window (in-memory, per session) ----
  const window: { tokens: number; ms: number }[] = [];

  // ---- per-turn state (one timer per user message) ----
  let runStart: number | null = null; // this prompt's start time
  let msgStart: number | null = null; // current assistant message start
  let streamStart: number | null = null; // first delta of the current message
  let msgTokens = 0; // estimated tokens of the current message
  let lastSpeed: number | null = null; // most recent window average (tok/s)
  let ticker: ReturnType<typeof setInterval> | null = null;

  function windowSpeed(): number | null {
    if (window.length === 0) return null;
    const tokens = window.reduce((acc, w) => acc + w.tokens, 0);
    const ms = window.reduce((acc, w) => acc + w.ms, 0);
    return ms > 0 ? (tokens / ms) * 1000 : null;
  }

  function elapsed(): number {
    return runStart === null ? 0 : (Date.now() - runStart) / 1000;
  }

  function renderStatus(ctx: any) {
    const speed = lastSpeed !== null ? `${Math.round(lastSpeed)} tok/s` : "-- tok/s";
    ctx.ui.setStatus("pi-speed", speed);
  }

  function renderWorkingTimer(ctx: any) {
    if (runStart !== null) {
      ctx.ui.setWorkingMessage(`Working · ⏱ ${formatDuration(elapsed())}`);
    }
  }

  function startTicker(ctx: any) {
    stopTicker();
    renderWorkingTimer(ctx);
    ticker = setInterval(() => renderWorkingTimer(ctx), 1000);
  }

  function stopTicker(ctx?: any) {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
    if (ctx !== undefined) {
      ctx.ui.setWorkingMessage(); // restore pi's default working message
    }
  }

  // Transcript line for persisted turn durations (survives resume/reload).
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { seconds?: number } | undefined;
    if (!data || typeof data.seconds !== "number") return undefined;
    return new Text(theme.fg("dim", `⏱ worked for ${formatDuration(data.seconds)}`), 1, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    window.length = 0;
    runStart = null;
    msgStart = null;
    streamStart = null;
    msgTokens = 0;
    lastSpeed = null;
    stopTicker(undefined);
    if (ctx.hasUI) renderStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopTicker(undefined);
  });

  // Every user message starts a fresh timer.
  pi.on("before_agent_start", async (_event, ctx) => {
    runStart = Date.now();
    if (ctx.hasUI) {
      startTicker(ctx);
    }
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    msgStart = Date.now();
    streamStart = null;
    msgTokens = 0;
  });

  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;
    const e = event.assistantMessageEvent;
    if (e.type !== "text_delta" && e.type !== "thinking_delta" && e.type !== "toolcall_delta") return;

    streamStart ??= Date.now();
    msgTokens += Math.max(0, e.delta.length / 4);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const official = event.message.usage?.output ?? 0;
    const tokens = official > 0 ? official : Math.round(msgTokens);
    const timingStart = streamStart ?? msgStart;
    if (timingStart && tokens > 0) {
      window.push({ tokens, ms: Math.max(0, Date.now() - timingStart) });
      if (window.length > WINDOW_SIZE) window.shift();
      lastSpeed = windowSpeed();
    }

    msgStart = null;
    streamStart = null;
    msgTokens = 0;

    if (ctx.hasUI) renderStatus(ctx);
  });

  // The run is truly over: no retries, no compaction, no queued follow-ups.
  pi.on("agent_settled", async (_event, ctx) => {
    if (runStart === null) return;

    const seconds = (Date.now() - runStart) / 1000;
    runStart = null;
    stopTicker(ctx.hasUI ? ctx : undefined);

    if (seconds >= MIN_PERSIST_SECONDS) {
      // Persist only the timer. Speed is deliberately not persisted: the
      // rolling average lives in memory for the current session only.
      pi.appendEntry(ENTRY_TYPE, { seconds: Math.round(seconds) });
    }

    if (ctx.hasUI) renderStatus(ctx);
  });
}
