#!/usr/bin/env node

// codex-eyes — image analysis for non-vision models/agents, using your
// existing Codex login. One or more images in, Luna's text answer out.
// Auth comes from ~/.codex/auth.json ($CODEX_HOME is honored).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const MODEL = "gpt-5.6-luna";

const DEFAULT_PROMPT = "Describe what you see in this image.";

const GLOBAL_SYSTEM_PROMPT =
  "You are the eyes of a non-vision model or agent. " +
  "Respect the requester's request exactly, and explain the image from its " +
  "perspective — describe what it needs to understand and act on. " +
  "Be concise and factual. If anything is unclear or in doubt, state that clearly.";

const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

function usage() {
  process.stderr.write(
    `Usage: node codex-eyes.mjs <image...> ["prompt"]\n` +
      `\n` +
      `If two or more arguments are given, the last one is the prompt.\n`,
  );
}

/** Resolve the Codex home dir like Codex itself does (CODEX_HOME, else ~/.codex). */
function codexHome() {
  const env = process.env.CODEX_HOME;
  return env && env.trim() !== "" ? env : join(homedir(), ".codex");
}

/** Read the ChatGPT OAuth access token and account id from the Codex login file. */
async function getAuth() {
  const authPath = join(codexHome(), "auth.json");
  let auth;
  try {
    auth = JSON.parse(await readFile(authPath, "utf8"));
  } catch {
    throw new Error(`Could not read Codex auth file at ${authPath}. Run \`codex login\` first.`);
  }
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!token || !accountId) {
    throw new Error(`No tokens in ${authPath}. Run \`codex login\` first.`);
  }
  return { token, accountId };
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

/** Build the Luna request: user prompt + every image as a base64 data URL. */
async function buildRequestBody(images, prompt) {
  const content = [{ type: "input_text", text: prompt }];
  for (const imagePath of images) {
    const raw = await readFile(imagePath);
    content.push({
      type: "input_image",
      image_url: `data:${mimeFor(imagePath)};base64,${raw.toString("base64")}`,
      detail: "auto",
    });
  }
  const body = {
    model: MODEL,
    instructions: GLOBAL_SYSTEM_PROMPT,
    input: [{ role: "user", content }],
    reasoning: { effort: "none" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
  return JSON.stringify(body);
}

/** Call Luna via the Codex Responses API (plain HTTP SSE transport). */
async function askLuna(images, prompt) {
  const { token, accountId } = await getAuth();
  const body = await buildRequestBody(images, prompt);

  const response = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountId,
      originator: "codex_cli_rs",
    },
    body,
    signal: AbortSignal.timeout(5 * 60_000),
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 401) throw new Error("Authentication failed. Run `codex login` first.");
    if (response.status === 429) throw new Error("Rate limited. Try again in a moment.");
    throw new Error(`API error (${response.status}): ${errorText.slice(0, 500)}`);
  }

  // Parse the SSE stream, collecting text deltas and surfacing failure events.
  let output = "";
  let event = "";
  let failure = null;
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);

      if (line.startsWith("event: ")) {
        event = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        let payload;
        try {
          payload = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (event === "response.output_text.delta") {
          output += payload.delta ?? "";
        } else if (event === "response.failed" || event === "response.incomplete") {
          const message = payload.response?.error?.message ?? `Response ${event}`;
          failure = message;
        } else if (event === "error") {
          failure = payload.message ?? "Stream error";
        }
      }
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
  const text = await askLuna(images, prompt);
  if (!text) throw new Error("Empty response from API.");
  process.stdout.write(text + "\n");
}
