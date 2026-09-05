#!/usr/bin/env node

// gemini-eyes — image analysis for non-vision models/agents, using your
// existing Antigravity CLI login. One or more images in, Gemini 3.8 Flash's
// text answer out. Auth comes from the Antigravity CLI's OAuth token file
// ($AGY_HOME is honored, default ~/.gemini/antigravity-cli).

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STREAM_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const QUOTA_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const REFRESH_URL = "https://oauth2.googleapis.com/token";
const PROJECT = "aicode-consumers";
const MODEL = "gemini-3.8-flash-low";

// Antigravity's -low/-medium/-high labels are thinking effort; low + budget 0
// is the closest thing to codex-eyes' reasoning:none — cheapest per request.
const DEFAULT_PROMPT = "Describe what you see in this image.";

const GLOBAL_SYSTEM_PROMPT =
  "You are the eyes of a non-vision model or agent. " +
  "Respect the requester's request exactly, and explain the image from its " +
  "perspective — describe what it needs to understand and act on. " +
  "Be concise and factual. If anything is unclear or in doubt, state that clearly.";

const USER_AGENT =
  "antigravity/cli/1.1.27 (aidev_client; os_type=linux; arch=amd64; " +
  "cl=976543523; auth_method=consumer)";

// Public identifiers baked into the Antigravity CLI binary; required to
// refresh the OAuth token it stores. They are read from
// $AGY_OAUTH_CLIENT_ID/$AGY_OAUTH_CLIENT_SECRET or $AGY_HOME/oauth-client.json
// rather than this source file (GitHub push protection blocks the literals).

const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
]);

function usage() {
  process.stderr.write(
    `Usage: node gemini-eyes.mjs <image...> ["prompt"]\n` +
      `\n` +
      `If two or more arguments are given, the last one is the prompt.\n`,
  );
}

/** Resolve the Antigravity CLI data dir ($AGY_HOME, else ~/.gemini/antigravity-cli). */
function agyHome() {
  const env = process.env.AGY_HOME;
  return env && env.trim() !== ""
    ? env
    : join(homedir(), ".gemini", "antigravity-cli");
}

function accessTokenIsValid(token) {
  // Google's expiry is RFC 3339 with nanoseconds; Date parses it fine.
  const expiry = token.token?.expiry ? new Date(token.token.expiry).getTime() : 0;
  return (
    Number.isFinite(expiry) && expiry - Date.now() > 60_000 && token.token?.access_token
  );
}

/** Locate the Antigravity OAuth client credentials: env vars first, then
 * $AGY_HOME/oauth-client.json. Needed only when the access token is stale. */
async function getOAuthClient() {
  const clientId = process.env.AGY_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.AGY_OAUTH_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };

  const clientPath = join(agyHome(), "oauth-client.json");
  try {
    const client = JSON.parse(await readFile(clientPath, "utf8"));
    if (client.client_id && client.client_secret) {
      return { clientId: client.client_id, clientSecret: client.client_secret };
    }
  } catch {}
  throw new Error(
    `OAuth client credentials not found (need $AGY_OAUTH_CLIENT_ID and ` +
      `$AGY_OAUTH_CLIENT_SECRET, or ${clientPath}). See the README's "Token ` +
      `refresh setup" — until then, rerun \`agy\` to renew your login.`,
  );
}

/** Read the stored OAuth token, refreshing it through Google if stale.
 * The refreshed token is written back to the same file the CLI uses. */
async function getAccessToken() {
  const tokenPath = join(agyHome(), "antigravity-oauth-token");
  let stored;
  try {
    stored = JSON.parse(await readFile(tokenPath, "utf8"));
  } catch {
    throw new Error(
      `Could not read Antigravity auth file at ${tokenPath}. Run \`agy\` once and log in first.`,
    );
  }
  if (accessTokenIsValid(stored)) return stored.token.access_token;

  const refreshToken = stored.token?.refresh_token;
  if (!refreshToken) {
    throw new Error(`No usable token in ${tokenPath}. Run \`agy\` once and log in first.`);
  }
  const { clientId, clientSecret } = await getOAuthClient();

  const response = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Token refresh failed (${response.status}): ${errorText.slice(0, 300)}. Run \`agy\` and log in again.`,
    );
  }
  const refreshed = await response.json();
  if (!refreshed.access_token) throw new Error("Token refresh returned no access_token.");

  stored.token.access_token = refreshed.access_token;
  stored.token.expiry = new Date(
    Date.now() + (refreshed.expires_in ?? 3600) * 1000,
  ).toISOString();
  if (refreshed.refresh_token) stored.token.refresh_token = refreshed.refresh_token;
  await writeFile(tokenPath, JSON.stringify(stored) + "\n", { mode: 0o600 });
  return stored.token.access_token;
}

/** Split argv into image paths and an optional trailing prompt. */
function parseArgs(argv) {
  const images = [];
  let prompt;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      images.push(arg);
    }
  }
  if (images.length === 0) {
    usage();
    throw new Error("At least one image is required.");
  }
  // With 2+ positional args the last one is the prompt; otherwise the default.
  if (images.length >= 2) prompt = images.pop();
  return { images, prompt: prompt ?? DEFAULT_PROMPT };
}

function mimeFor(imagePath) {
  const dot = imagePath.lastIndexOf(".");
  const ext = dot === -1 ? "" : imagePath.slice(dot).toLowerCase();
  return MIME_BY_EXTENSION.get(ext) ?? "image/png";
}

/** Build the Gemini request: system prompt + user prompt + every image as
 * an inlineData part, with thinking disabled. */
async function buildRequestBody(images, prompt) {
  const parts = [{ text: prompt }];
  for (const imagePath of images) {
    const raw = await readFile(imagePath);
    parts.push({ inlineData: { mimeType: mimeFor(imagePath), data: raw.toString("base64") } });
  }
  return JSON.stringify({
    project: PROJECT,
    requestId: `gemini-eyes/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    request: {
      contents: [{ role: "user", parts }],
      systemInstruction: { role: "user", parts: [{ text: GLOBAL_SYSTEM_PROMPT }] },
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
      },
    },
    model: MODEL,
    userAgent: "antigravity",
    requestType: "agent",
  });
}

/** Best-effort quota read for friendlier rate-limit errors. Returns a short
 * human string, or null if the summary can't be fetched. */
async function quotaSummary(token) {
  try {
    const response = await fetch(QUOTA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ project: PROJECT }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const bucket = data.groups?.[0]?.buckets?.[0];
    if (!bucket) return null;
    const remaining = (bucket.remainingFraction * 100).toFixed(1);
    const reset = bucket.resetTime ? ` Resets ${bucket.resetTime}.` : "";
    return `Weekly Gemini quota ${remaining}% remaining.${reset}`;
  } catch {
    return null;
  }
}

/** Call Gemini 3.8 Flash via the Antigravity backend. Waits for the whole
 * SSE response, then returns the complete text in one piece — nothing is
 * streamed to the caller. */
async function askGemini(images, prompt) {
  const token = await getAccessToken();
  const body = await buildRequestBody(images, prompt);

  const response = await fetch(STREAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
    body,
    signal: AbortSignal.timeout(5 * 60_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    let message = errorText.slice(0, 500);
    try {
      message = JSON.parse(errorText).error?.message ?? message;
    } catch {}
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Authentication or license failed: ${message} Run \`agy\` and log in again.`);
    }
    if (response.status === 429) {
      const quota = await quotaSummary(token);
      throw new Error(`Rate limited. ${quota ?? "Try again in a moment."}`);
    }
    throw new Error(`API error (${response.status}): ${message}`);
  }

  // The endpoint always answers as an SSE stream; read it whole, then parse.
  const raw = await response.text();

  let output = "";
  let failure = null;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let payload;
    try {
      payload = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    const candidate = payload.response?.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === "string") output += part.text;
    }
    if (candidate?.finishReason && candidate.finishReason !== "STOP") {
      failure = `Model stopped early: ${candidate.finishReason}`;
    }
  }

  if (failure) throw new Error(failure);
  return output.trim();
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});

async function main() {
  const { images, prompt } = parseArgs(process.argv.slice(2));
  const text = await askGemini(images, prompt);
  if (!text) throw new Error("Empty response from API.");
  process.stdout.write(text + "\n");
}
