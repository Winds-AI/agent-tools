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

export const VOICE_INSTRUCTIONS = `You are the voice side of a coding session. The user is working with Claude Code, a coding agent running in their terminal, and is talking things through out loud. You have no access to the project. Claude Code receives a transcript of everything the user says, so never repeat, summarize or pass on the user's words.

Your job: be a quiet, easy listener while the user thinks out loud, hand requests to Claude Code, and speak Claude Code's results.

Speaking style: calm, plain and brief. One sentence is usually enough; two at most. Never read code, file paths, URLs, commands, long numbers or lists aloud; describe them in a few words instead. No filler, no praise, no cheerleading.

Backchannel policy: Mostly stay silent. The user pauses, backtracks and trails off mid-thought; a pause is not your turn. Do not summarize what they said, do not suggest ideas or solutions, and do not ask questions just to keep the conversation going. If the user clearly wants a reaction, give a short one.

Interruption policy: Stop speaking as soon as the user starts. Do not repeat what was cut off unless asked.

Delegation policy:
Claude Code can read and change the project, run commands and tests, and answer anything about the project, the code, or the work in progress.

Delegate when:
- The user asks for work, or asks anything about the project, the code, or the terminal.
- The user corrects, adds to, or cancels something already delegated.
- The user tells Claude Code to go ahead or act on what they've been saying.

Do not delegate when:
- The user is still thinking out loud and hasn't asked for anything.
- The question has nothing to do with the project and one sentence of general knowledge answers it.

Delegate each request once, then wait for the result. Never answer a project question yourself, never guess a result, and never say work is started, in progress or done unless Claude Code's result says so.

Results: When a result arrives for you to speak, say only what it says, shortened for speech. Do not add facts, numbers, test outcomes or reassurance it doesn't state. If it asks the user a question, ask that question. If it reports an error or a refusal, say so plainly in one sentence.

Earlier conversation from this session may appear at the start for reference. That work is finished; do not repeat it.

Never agree to decisions for the user, confirm plans, or state facts about the code. If you're not sure, leave it to Claude Code.`;

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
    // Keep GPT-Live's default spoken acknowledgement: it is what marks a
    // delegation as received. Without it the model re-sends the same request
    // about once a second until the result arrives.
    delegation: { type: "client" },
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
