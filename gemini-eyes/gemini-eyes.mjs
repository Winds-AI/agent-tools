#!/usr/bin/env node

/**
 * gemini-eyes — minimal image understanding for pi (or any agent/harness)
 * using your existing Antigravity CLI login (Google account), authentication,
 * and free-tier quota. No API keys, no AI Studio, no extra accounts.
 *
 * Sends one or more images to Gemini 3.7 Flash (tiered) via the same
 * v1internal endpoints the Antigravity CLI (agy) uses, with thinking at the
 * lowest level the API accepts, and prints the model's text response. A
 * non-vision model can call this tool to understand images.
 *
 * Deliberately stupid by design:
 *   - NO retries, NO waiting, NO fallback loop inside the script.
 *   - Tries ONE model exactly once, prints the answer or a clear error, exits.
 *   - If quota/rate-limited, the AGENT (pi) decides what to do next.
 *
 * Auth: reads the same macOS Keychain item the Antigravity CLI writes
 * (service "gemini", account "antigravity") via `security`, same as
 * codex-eyes reads ~/.codex/auth.json. If the access token is expired or
 * rejected, re-run `agy` once to refresh the login — the script stays dumb.
 *
 * Usage:
 *   node gemini-eyes.mjs /path/to/image.png "What does this show?"
 *   node gemini-eyes.mjs a.png b.png c.png "Compare these screenshots"
 *
 * Prompt is optional — defaults to "Describe what you see in this image."
 *
 * Exit codes:
 *   0  answered
 *   1  usage / auth / fatal error (bad args, missing image, no login)
 *   2  quota / transient (429 RESOURCE_EXHAUSTED, 503 high demand)
 */

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Same endpoints the Antigravity CLI (agy) uses — verified live.
const GENERATE_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const LOAD_ASSIST_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

// Newest free-tier Flash with vision. "tiered" = reasoning level is set per
// request (thinkingLevel), not baked into the model id.
const MODEL = "gemini-3.7-flash-tiered";

const USER_AGENT = "antigravity/hub/2.2.1 darwin/arm64";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
};

/** Read the Antigravity CLI's OAuth access token from the macOS Keychain. */
async function getAccessToken() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      "gemini",
      "-a",
      "antigravity",
      "-w",
    ]));
  } catch {
    throw new Error(
      "No Antigravity login found in Keychain. Run `agy` once and sign in with Google first.",
    );
  }

  const prefix = "go-keyring-base64:";
  if (!stdout.startsWith(prefix)) {
    throw new Error("Unexpected Keychain value for Antigravity auth.");
  }
  const b64 = stdout.slice(prefix.length).trim();
  const data = JSON.parse(
    Buffer.from(b64 + "=".repeat((-b64.length) % 4), "base64").toString("utf8"),
  );
  const accessToken = data?.token?.access_token;
  if (!accessToken) {
    throw new Error(
      "Antigravity Keychain entry missing access token. Re-run `agy` login.",
    );
  }
  return accessToken;
}

/** Fetch the Antigravity project id (cloudaicompanionProject) for the account. */
async function getProjectId(token) {
  const res = await fetch(LOAD_ASSIST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
  });
  if (!res.ok) {
    throw new Error(`loadCodeAssist failed (${res.status}). Is the account set up?`);
  }
  const data = await res.json();
  return data.cloudaicompanionProject || data.projectId || "";
}

/** Ask Gemini 3.7 Flash (tiered) to look at the images and answer the prompt. */
async function ask(token, projectId, imagePaths, prompt) {
  const parts = [{ text: prompt }];
  for (const imagePath of imagePaths) {
    const raw = await readFile(imagePath);
    const ext = imagePath.slice(imagePath.lastIndexOf(".")).toLowerCase();
    parts.push({
      inlineData: {
        mimeType: MIME[ext] || "image/jpeg",
        data: raw.toString("base64"),
      },
    });
  }

  const payload = {
    model: MODEL,
    userAgent: "antigravity",
    project: projectId,
    requestType: "agent",
    requestId: `agent-${crypto.randomUUID()}`,
    request: {
      contents: [{ role: "user", parts }],
      generationConfig: {
        // Lowest reasoning the API accepts (verified: LOW → no thought tokens;
        // "NONE" is rejected with 400, and thinkingBudget: 0 still thinks).
        thinkingConfig: { thinkingLevel: "LOW" },
        maxOutputTokens: 2048,
      },
    },
  };

  const res = await fetch(GENERATE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = raw.slice(0, 300);
    try {
      const err = JSON.parse(raw)?.error;
      if (err?.message) msg = err.message.split("\n")[0];
    } catch {}
    const err = new Error(
      res.status === 401
        ? "Antigravity login expired. Run `agy` once to refresh, then retry."
        : `API error (${res.status}): ${msg}`,
    );
    err.status = res.status;
    throw err;
  }

  // Parse SSE: collect text from response.candidates[0].content.parts[].
  let output = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const evt = JSON.parse(line.slice(6));
      const partsOut = evt?.response?.candidates?.[0]?.content?.parts || [];
      for (const p of partsOut) {
        if (typeof p.text === "string" && p.text) output += p.text;
      }
    } catch {}
  }

  if (!output.trim()) {
    const err = new Error("Empty response from API.");
    err.status = 0;
    throw err;
  }
  return output.trim();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write(
      "Usage: node gemini-eyes.mjs <image1> [image2 ...] [\"prompt\"]\n",
    );
    process.exit(1);
  }

  // Last arg is the prompt if 2+ args; otherwise default prompt.
  const hasPrompt = args.length >= 2;
  const imagePaths = hasPrompt ? args.slice(0, -1) : args;
  const prompt = hasPrompt
    ? args[args.length - 1]
    : "Describe what you see in this image.";

  const token = await getAccessToken();
  const projectId = await getProjectId(token);
  const answer = await ask(token, projectId, imagePaths, prompt);
  process.stdout.write(answer + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const status = err.status || 0;
    process.stderr.write(`gemini-eyes: ${err.message}\n`);
    process.exit(status === 429 || status === 503 ? 2 : 1);
  });
