#!/usr/bin/env node

// codex-image — generate an image with your existing Codex login.
// One prompt in, one temporary PNG path out.
// Auth comes from ~/.codex/auth.json ($CODEX_HOME is honored).

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE_URL = "https://chatgpt.com/backend-api/codex/images/generations";
const MODEL = "gpt-image-2";
const QUALITIES = new Set(["auto", "low", "medium", "high"]);
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function usage() {
  process.stderr.write(
    `Usage: node codex-image.mjs <prompt> [--quality <auto|low|medium|high>]\n`,
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

/** Parse one prompt plus an optional quality setting. */
function parseArgs(argv) {
  const args = { prompt: undefined, quality: "auto" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--quality") {
      const value = argv[++i];
      if (!value) throw new Error("--quality requires a value.");
      args.quality = value;
    } else if (arg.startsWith("--quality=")) {
      args.quality = arg.slice("--quality=".length);
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (args.prompt === undefined) {
      args.prompt = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  if (!args.prompt || args.prompt.trim() === "") {
    usage();
    throw new Error("No prompt given.");
  }
  if (!QUALITIES.has(args.quality)) {
    throw new Error(`Invalid quality: ${args.quality}. Use auto, low, medium, or high.`);
  }
  return args;
}

/** Generate one image and return its PNG bytes. */
async function generateImage(prompt, quality) {
  const { token, accountId } = await getAuth();
  const response = await fetch(IMAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountId,
      originator: "codex_cli_rs",
      "x-codex-image-turn-id": randomUUID(),
    },
    body: JSON.stringify({
      prompt,
      background: "auto",
      model: MODEL,
      n: 1,
      quality,
      size: "auto",
    }),
    signal: AbortSignal.timeout(5 * 60_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error("Authentication failed. Run `codex login` first.");
    }
    if (response.status === 429) {
      throw new Error("Image generation limit reached. Try again later.");
    }
    throw new Error(`API error (${response.status}): ${errorText.slice(0, 500)}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Unexpected non-JSON response from the image API.");
  }

  const base64 = payload.data?.[0]?.b64_json;
  if (typeof base64 !== "string" || base64 === "") {
    throw new Error("Image API returned no image.");
  }
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new Error("Image API returned an unexpectedly large image.");
  }

  const image = Buffer.from(base64, "base64");
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES || !image.subarray(0, 8).equals(pngSignature)) {
    throw new Error("Image API returned invalid PNG data.");
  }
  return image;
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});

async function main() {
  const { prompt, quality } = parseArgs(process.argv.slice(2));
  const image = await generateImage(prompt, quality);
  const outputPath = join(tmpdir(), `codex-image-${randomUUID()}.png`);
  await writeFile(outputPath, image, { mode: 0o600 });
  process.stdout.write(`${outputPath}\n`);
}
