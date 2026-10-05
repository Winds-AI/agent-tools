import { execFileSync } from "node:child_process";
import { VoiceError } from "./errors.mjs";
import { getCodexAuth } from "./auth.mjs";
import { Conversation } from "./conversation.mjs";

// Protocol adapted from the read-only Pi reference at
// pi-voice/mac/src/call.mjs.
export const LIVE_MODEL = "gpt-live-1-codex";
export const LIVE_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";

export function codexVersion(env = process.env) {
  const configured = env.UVOICE_CODEX_VERSION?.trim();
  if (configured && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(configured)) return configured;
  if (configured) throw new VoiceError("UVOICE_CODEX_VERSION must be a semantic version such as 1.2.3.");

  try {
    const output = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/);
    if (match) return match[1];
  } catch {
    // The actionable error below is safer than guessing an old client identity.
  }
  throw new VoiceError("Could not determine the Codex client version. Install `codex` or set UVOICE_CODEX_VERSION.");
}

export const VOICE_INSTRUCTIONS =
  "You are the voice interface for Claude Code, a coding agent already running in the user's terminal. " +
  "Answer ordinary conversational questions briefly. Delegate work that needs the terminal, project files, " +
  "commands, or repository context to the client. For a work request, send a clear, complete task that " +
  "preserves the user's constraints. After delegating, wait for the client result and then speak a concise " +
  "answer. Do not claim to have inspected files or run commands yourself. " +
  "Initial history is reference from the existing project conversation; do not repeat its completed work. " +
  "Client commentary provides background facts, including typed messages and tool activity. Do not " +
  "proactively narrate those updates or read typed replies aloud. Speak the current delegated result " +
  "when it arrives on the speakable channel. If the user changes direction, use the latest direction.";

/** Create one Codex GPT-Live WebRTC call. Only the SDP answer is returned. */
export async function createLiveCall({
  sdp,
  voice = "cove",
  initialItems = [],
  fetchImpl = fetch,
  getAuth = getCodexAuth,
  version = codexVersion(),
  signal,
}) {
  const credentials = await getAuth();
  const session = {
    model: LIVE_MODEL,
    instructions: VOICE_INSTRUCTIONS,
    audio: { output: { voice } },
    delegation: { type: "client", ack_filler: false },
  };
  if (Array.isArray(initialItems) && initialItems.length) session.initial_items = initialItems;

  let response;
  try {
    response = await fetchImpl(LIVE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + credentials.token,
        "ChatGPT-Account-Id": credentials.accountId,
        "Content-Type": "application/json",
        originator: "codex_cli_rs",
        version,
        "OpenAI-Alpha": "quicksilver=v2",
        "User-Agent": "codex_cli_rs/" + version,
      },
      body: JSON.stringify({ sdp, session }),
      signal,
    });
  } catch {
    if (signal?.reason === "timeout") throw new VoiceError("Codex Live call timed out. Reconnect to try again.");
    if (signal?.aborted) throw new VoiceError("Voice connection was cancelled.");
    throw new VoiceError("Could not reach Codex Live. Check network connectivity and reconnect.");
  }

  // Do not read or forward error bodies: they are upstream data and may include
  // account or request details. The browser only needs the status category.
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new VoiceError("Codex rejected the voice login. Run `codex login` and reconnect.");
    }
    if (response.status === 404) {
      throw new VoiceError("The Codex Live endpoint is unavailable. The Codex client may need an update.");
    }
    throw new VoiceError("Codex Live call creation failed (HTTP " + response.status + ").");
  }

  let answer;
  try {
    answer = await response.text();
  } catch {
    throw new VoiceError("Codex Live returned an unreadable SDP answer.");
  }
  if (typeof answer !== "string" || !answer.includes("v=0")) {
    throw new VoiceError("Codex Live returned an empty or malformed SDP answer.");
  }
  return { answer };
}

// Keep the history type available here to make the session seed shape explicit.
export function makeInitialItems(conversation, latestFinal) {
  return conversation instanceof Conversation ? conversation.history(latestFinal) : [];
}
