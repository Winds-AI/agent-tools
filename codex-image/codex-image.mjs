#!/usr/bin/env node

// codex-image — generate or edit an image with your existing Codex login.
// Text → image, or image + text → image. One PNG path out.
// Auth comes from ~/.codex/auth.json ($CODEX_HOME is honored).

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const API_BASE = "https://chatgpt.com/backend-api/codex/images";
const MODEL = "gpt-image-2";
const QUALITIES = new Set(["auto", "low", "medium", "high"]);
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

const HELP = `Usage: node codex-image.mjs <prompt> [--image <path>]... [--quality <q>] [--out <path>]

Modes (picked from the arguments):
  text -> image          node codex-image.mjs "a red fox in snow"
  image + text -> image  node codex-image.mjs "same character, now waving" --image ref.png
  several references     node codex-image.mjs "the cat from image 1 wearing the hat from image 2" --image cat.png --image hat.jpg

A prompt is always required, also with --image.

Options:
  --image <path>   Reference image (PNG, JPEG or WebP). Repeat for several; refer to them in the
                   prompt as "image 1", "image 2" in the order given.
  --quality <q>    auto | low | medium | high (default: auto). low is fastest.
  --out <path>     Where to write the PNG (parent folders are created; existing file is replaced).
                   Default: a new temp file.
  -h, --help       Show this help.

Output: on success, prints only the absolute path of the PNG to stdout and exits 0.
Errors: one "Error: ..." line on stderr; exit 2 for bad arguments, 1 for everything else.

Notes: one image per call, usually 15-60 s. Size and aspect ratio are chosen by the model; describe
the shape you want in the prompt ("wide 16:9 landscape"). Ask for "transparent background" in the
prompt to get a PNG with alpha. Uses your Codex login and quota (run \`codex login\` first).`;

class UsageError extends Error {}

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

/** Parse one prompt, any number of --image paths, --quality and --out. Anything that is not one of these flags is the prompt. */
function parseArgs(argv) {
  const args = { prompt: undefined, images: [], quality: "auto", out: undefined };
  const value = (name, i) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} requires a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [flag, inline] = arg.startsWith("--") && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag === "-h" || flag === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    } else if (flag === "--image") {
      args.images.push(inline ?? value("--image", ++i));
    } else if (flag === "--quality") {
      args.quality = inline ?? value("--quality", ++i);
    } else if (flag === "--out") {
      args.out = inline ?? value("--out", ++i);
    } else if (args.prompt === undefined) {
      args.prompt = arg;
    } else {
      throw new UsageError(`Unexpected extra argument: ${arg}. Quote the prompt so it is a single argument.`);
    }
  }

  if (args.prompt === undefined || args.prompt.trim() === "") {
    throw new UsageError("A prompt is required, also with --image. Run with --help for usage.");
  }
  if (!QUALITIES.has(args.quality)) {
    throw new UsageError(`Invalid quality: ${args.quality}. Use auto, low, medium, or high.`);
  }
  return args;
}

/** Detect the image type from its first bytes. */
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

/** Load reference images as data URLs, failing early with a clear message. */
async function loadImages(paths) {
  const refs = [];
  for (const path of paths) {
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new UsageError(`Image not found: ${path}`);
    }
    if (!info.isFile()) throw new UsageError(`Not a file: ${path}`);
    if (info.size > MAX_IMAGE_BYTES) throw new UsageError(`Image is larger than 32 MB: ${path}`);
    const bytes = await readFile(path);
    const mime = imageMime(bytes);
    if (!mime) throw new UsageError(`Unsupported image type: ${path}. Use PNG, JPEG or WebP.`);
    refs.push({ image_url: `data:${mime};base64,${bytes.toString("base64")}` });
  }
  return refs;
}

/** Generate (no references) or edit (with references) one image and return its PNG bytes. */
async function requestImage({ prompt, images, quality }) {
  const { token, accountId } = await getAuth();
  const editing = images.length > 0;
  const body = {
    prompt,
    background: "auto",
    model: MODEL,
    n: 1,
    quality,
    size: "auto",
  };
  if (editing) body.images = images;

  const response = await fetch(`${API_BASE}/${editing ? "edits" : "generations"}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountId,
      originator: "codex_cli_rs",
      "x-codex-image-turn-id": randomUUID(),
    },
    body: JSON.stringify(body),
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
    let message = errorText.slice(0, 500);
    try {
      message = JSON.parse(errorText).error?.message ?? message;
    } catch {}
    throw new Error(`API error (${response.status}): ${message}`);
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
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES || imageMime(image) !== "image/png") {
    throw new Error("Image API returned invalid PNG data.");
  }
  return image;
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(err instanceof UsageError ? 2 : 1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const images = await loadImages(args.images);
  const image = await requestImage({ prompt: args.prompt, images, quality: args.quality });
  const outputPath = args.out ? resolve(args.out) : join(tmpdir(), `codex-image-${randomUUID()}.png`);
  if (args.out) await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, image, { mode: 0o600 });
  process.stdout.write(`${outputPath}\n`);
}
