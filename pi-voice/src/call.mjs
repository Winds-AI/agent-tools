import { execFileSync } from "node:child_process";
import { VoiceError } from "./errors.mjs";
import { getCodexAuth } from "./auth.mjs";

export const LIVE_MODEL = "gpt-live-1-codex";
export const LIVE_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";

// The Codex realtime surface is versioned by client identity: it routes the
// model and wire protocol from the `originator`/`version` headers, so the
// installed Codex version is always preferred.
export function codexVersion() {
  try {
    const output = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  } catch {
    // Codex is not on PATH; the pinned revision below is the verified one.
  }
  return "0.154.0";
}

/** Create a GPT-Live WebRTC call and return the SDP answer. */
export async function createLiveCall({
  sdp,
  instructions,
  voice = "cove",
  initialItems,
  version = codexVersion(),
  fetchImpl = fetch,
  auth,
  getAuth = getCodexAuth,
}) {
  const credentials = auth ?? (await getAuth());
  const session = {
    model: LIVE_MODEL,
    instructions,
    audio: { output: { voice } },
    delegation: { type: "client", ack_filler: false },
  };
  if (Array.isArray(initialItems) && initialItems.length > 0) {
    session.initial_items = initialItems;
  }

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
    });
  } catch (error) {
    throw new VoiceError(
      "Could not reach the Codex realtime endpoint: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new VoiceError(callFailure(response.status, text.slice(0, 400)));
  }
  if (!text.includes("v=0") && !/^m=/.test(text)) {
    throw new VoiceError("GPT-Live returned an empty or malformed SDP answer.");
  }
  return {
    answer: text,
    callId: response.headers?.get?.("location") ?? undefined,
    authSource: credentials.source,
  };
}

function callFailure(status, detail) {
  const suffix = detail ? " — " + detail.replace(/\s+/g, " ").trim() : "";
  if (status === 401 || status === 403) {
    return "Codex rejected the voice credential (HTTP " + status + "). Sign in again with Codex." + suffix;
  }
  if (status === 404) {
    return "The Codex realtime endpoint is unavailable (HTTP 404); Codex may have changed." + suffix;
  }
  return "GPT-Live call creation failed (HTTP " + status + ")." + suffix;
}
