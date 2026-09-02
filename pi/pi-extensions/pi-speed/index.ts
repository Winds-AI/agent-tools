/**
 * pi-speed — generation speed and per-turn elapsed time for pi.
 *
 * Job 1 — speed (in-memory, live):
 *   Rolling-window tokens/sec across the last WINDOW_SIZE assistant
 *   responses, shown in the footer status while streaming and after each
 *   response. The window keeps computation O(1) no matter how long the
 *   session grows.
 *
 * Job 2 — timer (persisted):
 *   Shows a live elapsed timer below the composer for each user message —
 *   every prompt starts a fresh timer, and when that run settles the final
 *   duration is appended as a custom entry (`pi-speed:worked-for`) so a
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
  let runOutputTokens = 0; // output tokens of this run (from provider usage)
  let lastOutputTokens = 0; // output tokens of the most recent completed run
  let msgStart: number | null = null; // current assistant message start
  let streamStart: number | null = null; // first delta of the current message
  let msgTokens = 0; // estimated tokens of the current message
  let lastSpeed: number | null = null; // most recent window average (tok/s)
  let lastWorkedFor: number | null = null; // duration of the most recent turn
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

  function renderStatus(ctx: any, live: boolean) {
    const theme = ctx.ui.theme;
    const speed = lastSpeed !== null ? `${Math.round(lastSpeed)} tok/s` : "-- tok/s";
    const windowInfo = theme.fg("dim", `(last ${window.length})`);
    let timer: string;
    if (runStart !== null) {
      timer = theme.fg("accent", `⏱ ${formatDuration(elapsed())}${live ? "…" : ""}`);
    } else if (lastWorkedFor !== null) {
      timer = theme.fg("dim", `worked for ${formatDuration(lastWorkedFor)}`);
    } else {
      timer = "";
    }
    ctx.ui.setStatus("pi-speed", `${speed} ${windowInfo}${timer ? "  " + timer : ""}`);
  }

  function renderTimerWidget(ctx: any) {
    if (runStart === null) {
      ctx.ui.setWidget("pi-speed", undefined);
      return;
    }
    const text = `⏱ ${formatDuration(elapsed())}`;
    ctx.ui.setWidget("pi-speed", (tui: any, theme: any) => new Text(theme.fg("accent", text), 1, 0), {
      placement: "belowEditor",
    });
  }

  function startTicker(ctx: any) {
    stopTicker();
    ticker = setInterval(() => {
      renderTimerWidget(ctx);
      renderStatus(ctx, true);
    }, 1000);
  }

  function stopTicker() {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  // Transcript line for persisted run durations (survives resume/reload).
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { seconds?: number } | undefined;
    if (!data || typeof data.seconds !== "number") return undefined;
    return new Text(theme.fg("dim", `⏱ worked for ${formatDuration(data.seconds)}`), 1, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    window.length = 0;
    runStart = null;
    runOutputTokens = 0;
    lastOutputTokens = 0;
    msgStart = null;
    streamStart = null;
    msgTokens = 0;
    lastSpeed = null;
    lastWorkedFor = null;
    stopTicker();
    if (ctx.hasUI) renderStatus(ctx, false);
  });

  pi.on("session_shutdown", async () => {
    stopTicker();
  });

  // Every user message starts a fresh timer.
  pi.on("before_agent_start", async (_event, ctx) => {
    runStart = Date.now();
    if (ctx.hasUI) {
      renderTimerWidget(ctx);
      startTicker(ctx);
    }
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    msgStart = Date.now();
    streamStart = null;
    msgTokens = 0;
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const e = event.assistantMessageEvent;
    if (e.type !== "text_delta" && e.type !== "thinking_delta" && e.type !== "toolcall_delta") return;

    streamStart ??= Date.now();
    msgTokens += Math.max(0, e.delta.length / 4);

    if (ctx.hasUI) {
      renderTimerWidget(ctx);
      renderStatus(ctx, true);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const official = event.message.usage?.output ?? 0;
    const tokens = official > 0 ? official : Math.round(msgTokens);
    if (tokens > 0) runOutputTokens += tokens;
    const timingStart = streamStart ?? msgStart;
    if (timingStart && tokens > 0) {
      window.push({ tokens, ms: Math.max(0, Date.now() - timingStart) });
      if (window.length > WINDOW_SIZE) window.shift();
      lastSpeed = windowSpeed();
    }

    msgStart = null;
    streamStart = null;
    msgTokens = 0;

    if (ctx.hasUI) renderStatus(ctx, true);
  });

  // The run is truly over: no retries, no compaction, no queued follow-ups.
  pi.on("agent_settled", async (_event, ctx) => {
    if (runStart === null) return;

    const seconds = (Date.now() - runStart) / 1000;
    lastWorkedFor = seconds;
    lastOutputTokens = runOutputTokens;
    runStart = null;
    runOutputTokens = 0;
    stopTicker();

    if (seconds >= MIN_PERSIST_SECONDS) {
      // outputTokens lets a script compute tok/s per model after the fact
      // (pi does not persist streaming durations, so we record them here).
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      pi.appendEntry(ENTRY_TYPE, {
        seconds: Math.round(seconds),
        outputTokens: lastOutputTokens,
        model,
      });
    }

    if (ctx.hasUI) {
      ctx.ui.setWidget("pi-speed", undefined);
      renderStatus(ctx, false);
    }
  });
}
