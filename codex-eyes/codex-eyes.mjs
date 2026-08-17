#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/codex/responses";
const MODEL = "gpt-5.6-luna";

/** Resolve the Codex home dir like Codex itself does (find_codex_home). */
function codexHome() {
  const env = process.env.CODEX_HOME;
  return env && env.trim() !== "" ? env : join(homedir(), ".codex");
}

/** Read auth from the local Codex login file. */
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

/** Get the model response for the given images + prompt via the Codex Responses API. */
async function askLuna(imagePaths, prompt) {
  const { token, accountId } = await getAuth();

  // Build content: prompt text first, then each image as base64 data URL.
  const content = [{ type: "input_text", text: prompt }];
  for (const imagePath of imagePaths) {
    const raw = await readFile(imagePath);
    const mime = imagePath.toLowerCase().endsWith(".png")
      ? "image/png"
      : imagePath.toLowerCase().endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
    content.push({
      type: "input_image",
      image_url: `data:${mime};base64,${raw.toString("base64")}`,
      detail: "auto",
    });
  }

  const response = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountId,
      originator: "Codex Desktop",
    },
    body: JSON.stringify({
      model: MODEL,
      instructions:
        "You are Codex Eyes, an image understanding tool for coding agents. " +
        "Inspect the provided image(s) and answer only the user's request. " +
        "Be concise and factual. Do not mention that you are an AI or that you saw an image.",
      input: [{ role: "user", content }],
      reasoning: { effort: "none" }, // no reasoning, standard mode
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    }),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => "Unknown error");
    if (response.status === 401) throw new Error("Authentication failed. Run `codex login`.");
    if (response.status === 429) throw new Error("Rate limited. Try again in a moment.");
    throw new Error(`API error (${response.status}): ${error}`);
  }

  // Parse SSE stream, collect text deltas.
  let output = "";
  const lines = (await response.text()).split("\n");
  let event = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      event = line.slice(7);
    } else if (line.startsWith("data: ") && event === "response.output_text.delta") {
      try {
        output += JSON.parse(line.slice(6)).delta ?? "";
      } catch {}
    } else if (
      line.startsWith("data: ") &&
      (event === "response.failed" || event === "response.incomplete")
    ) {
      try {
        const err = JSON.parse(line.slice(6)).response?.error?.message;
        if (err) throw new Error(err);
      } catch {}
    }
  }

  if (!output.trim()) throw new Error("Empty response from API.");
  return output.trim();
}

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("Usage: node codex-eyes.mjs <image1> [image2 ...] [\"prompt\"]\n");
  process.exit(1);
}

// If there are 2+ args, the last is the prompt; otherwise use the default.
const hasPrompt = args.length >= 2;
const imagePaths = hasPrompt ? args.slice(0, -1) : args;
const prompt = hasPrompt ? args[args.length - 1] : "Describe what you see in this image.";

askLuna(imagePaths, prompt)
  .then((text) => process.stdout.write(text + "\n"))
  .catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
