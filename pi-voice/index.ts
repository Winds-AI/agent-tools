import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { VoiceSession } from "./src/voice.mjs";
import type { Fragment } from "./src/conversation.mjs";

// Assistant voice for spoken replies. Options:
// alloy, arbor, ash, ballad, breeze, cedar, coral, cove, echo, ember, juniper,
// maple, marin, sage, shimmer, sol, spruce, vale, verse
const VOICE = "cove";

interface VoiceStatus {
  phase: string;
  seconds: number;
  totalSeconds: number;
  catchingUp: boolean;
  transcript: string;
  level?: { vad: number; db: number; at: number };
}

export default function install(pi: ExtensionAPI, dependencies: Record<string, unknown> = {}) {
  let voice: VoiceSession | undefined;
  let generation = 0;
  let lastAnswer = "";
  let answerChanged = false;

  pi.registerEntryRenderer("pi-voice:conversation", (entry, _options, theme) => {
    const data = entry.data as { text?: string } | undefined;
    return data?.text ? new Text(theme.fg("dim", data.text), 0, 0) : undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    const active = ++generation;
    await voice?.shutdown();
    voice = undefined;
    if (ctx.mode !== "tui") return;
    const fragments: Fragment[] = [];
    let lastDelegated = 0;
    let lastDisplayed = 0;
    let latestResult = "";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as Partial<Fragment> & {
        lastDelegated?: number;
        lastDisplayed?: number;
        text?: string;
      };
      if (
        entry.customType === "pi-voice:fragment" &&
        (data.role === "U" || data.role === "A") &&
        typeof data.delta === "string" &&
        typeof data.sequence === "number"
      ) {
        fragments.push(data as Fragment);
      }
      if (entry.customType === "pi-voice:delegation" && typeof data.lastDelegated === "number")
        lastDelegated = data.lastDelegated;
      if (entry.customType === "pi-voice:conversation" && typeof data.lastDisplayed === "number")
        lastDisplayed = data.lastDisplayed;
      if (entry.customType === "pi-voice:result" && typeof data.text === "string")
        latestResult = data.text;
    }
    lastAnswer = latestResult;
    answerChanged = false;
    let previewText: string | undefined;
    voice = new VoiceSession({
      voice: VOICE,
      mediaOptions: { browser: process.env.PI_VOICE_BROWSER },
      fragments,
      lastDelegated,
      lastDisplayed,
      latestResult,
      ...dependencies,
      submit(text: string) {
        if (active === generation)
          pi.sendUserMessage(text, {
            deliverAs: "steer",
            expandPromptTemplates: false,
          });
      },
      persist(kind: string, data: unknown) {
        if (active === generation) pi.appendEntry("pi-voice:" + kind, data);
      },
      notify(text: string, type: "info" | "warning" | "error") {
        if (active === generation) ctx.ui.notify(text, type);
      },
      status(state: VoiceStatus) {
        if (active !== generation) return;
        const labels: Record<string, string> = {
          muted: "muted",
          warming: "warming up…",
          armed: "listening",
          connecting: "connecting…",
          closing: "closing…",
          live: state.catchingUp ? "catching up…" : "live",
          closed: "muted",
        };
        const seconds = state.phase === "live" ? state.seconds : state.totalSeconds;
        const usage = seconds > 0 ? ` · ${seconds}s` : "";
        const level = state.level;
        const meter =
          level &&
          performance.now() - level.at < 800 &&
          (level.vad >= 0.05 || level.db > -55)
            ? ` · ${Math.round(level.db)}dB · vad ${level.vad.toFixed(2)}`
            : "";
        ctx.ui.setStatus(
          "pi-voice",
          ctx.ui.theme.fg(
            state.phase === "live" ? "accent" : "dim",
            (labels[state.phase] ?? state.phase) + usage + meter,
          ),
        );
        if (state.transcript === previewText) return;
        previewText = state.transcript;
        ctx.ui.setWidget(
          "pi-voice",
          state.transcript
            ? (_tui, theme) => {
                const text = new Text(theme.fg("dim", state.transcript), 0, 0);
                return {
                  render: (width: number) => text.render(width).slice(-5),
                  invalidate: () => text.invalidate(),
                };
              }
            : undefined,
        );
      },
    });
  });

  pi.registerCommand("m", {
    description: "Mute or unmute the microphone; Pi's results are still spoken while muted",
    handler: async (_args, ctx) => {
      if (!voice) {
        ctx.ui.notify("Voice requires interactive Pi.", "warning");
        return;
      }
      await voice.toggleMute();
    },
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const parts = event.message.content.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
    if (parts.length) {
      lastAnswer = parts.join("\n");
      answerChanged = true;
    }
  });
  pi.on("agent_settled", () => {
    if (answerChanged) {
      answerChanged = false;
      voice?.setResult(lastAnswer);
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await voice?.shutdown();
    voice = undefined;
    ++generation;
    if (ctx.hasUI) {
      ctx.ui.setStatus("pi-voice", undefined);
      ctx.ui.setWidget("pi-voice", undefined);
    }
  });
}
