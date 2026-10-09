#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://openrouter.ai/api/v1/responses";
const MODEL = "google/gemini-3.8-flash";
const KEY_FILE = join(homedir(), ".config/gemini-video/openrouter-api-key");
const INSTRUCTIONS = "Include timestamps for the moments supporting your answer.";
// OpenRouter routes agentic video to Google AI Studio, which rejects request
// bodies over 20,000,000 bytes. Base64 adds a third, so raw videos must stay
// under ~14 MB; larger ones are re-encoded to fit.
export const MAX_VIDEO_BYTES = 14_000_000;
// Formats OpenRouter accepts as-is; anything else is converted to MP4.
const MIME = new Map([
  [".mp4", "video/mp4"], [".m4v", "video/mp4"], [".mov", "video/mov"],
  [".webm", "video/webm"], [".mpeg", "video/mpeg"], [".mpg", "video/mpeg"],
]);
const CONVERTIBLE = new Set([".avi", ".wmv", ".mkv", ".flv", ".3gp"]);
const ATTEMPTS = 3;
const USAGE = 'Usage: gemini-video <video-path> "<question>"\n';
const run = promisify(execFile);

async function loadKey() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (key) return key;
  try {
    const saved = (await readFile(KEY_FILE, "utf8")).trim();
    if (saved) return saved;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  throw new Error(`Set OPENROUTER_API_KEY or save your key in ${KEY_FILE}.`);
}

async function ffmpeg(args) {
  try {
    return await run(args[0], args.slice(1), { maxBuffer: 1 << 20 });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${args[0]} is required to convert or shrink this video; install ffmpeg.`);
    throw new Error(`${args[0]} failed: ${String(error.stderr || error.message).trim().split("\n").pop()}`);
  }
}

// Re-encode to MP4 at 5 fps with mono audio, choosing the bitrate so the file
// fits `limit`. Gemini samples video sparsely, so this keeps answers intact.
export async function fitVideo(source, limit = MAX_VIDEO_BYTES) {
  const { stdout } = await ffmpeg(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", source]);
  const seconds = Number.parseFloat(stdout);
  if (!(seconds > 0)) throw new Error("Could not read the video duration.");
  const dir = await mkdtemp(join(tmpdir(), "gemini-video-"));
  const out = join(dir, "video.mp4");
  let budget = limit * 0.92;
  for (let attempt = 0; attempt < 3; attempt++, budget *= 0.8) {
    const kbps = Math.floor((budget * 8 / seconds - 32_000) / 1000);
    if (kbps < 1) break;
    // Low bitrates look better at a lower resolution.
    const height = kbps >= 120 ? 720 : 480;
    await ffmpeg(["ffmpeg", "-v", "error", "-y", "-i", source,
      "-vf", `fps=5,scale=-2:'min(${height},ih)'`, "-c:v", "libx264", "-preset", "medium",
      "-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ac", "1", "-b:a", "32k", "-movflags", "+faststart", out]);
    if ((await stat(out)).size <= limit) return { path: out, mime: "video/mp4", cleanup: () => rm(dir, { recursive: true, force: true }) };
  }
  await rm(dir, { recursive: true, force: true });
  throw new Error("Video is too long to fit OpenRouter's 20 MB request limit; trim it or split it into parts.");
}

async function prepare(source) {
  const ext = extname(source).toLowerCase();
  const mime = MIME.get(ext);
  if (!mime && !CONVERTIBLE.has(ext)) {
    throw new Error("Unsupported video extension; use MP4, MOV, WebM, MPEG, M4V, AVI, WMV, MKV, FLV, or 3GP.");
  }
  const info = await stat(source);
  if (!info.isFile() || info.size === 0) throw new Error("Video must be a nonempty regular file.");
  if (mime && info.size <= MAX_VIDEO_BYTES) return { path: source, mime, cleanup: async () => {} };
  return fitVideo(source);
}

// One answer per call. 429/5xx are retried as-is. A reply with no answer is what
// OpenRouter sends when a long agentic session is cut off (roughly 2 minutes in),
// so the next attempt uses static processing, which answers in one pass.
async function ask(key, request, signal) {
  let lastError, processing = "agentic";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(5000 * 3 ** (attempt - 2), undefined, { signal });
    const body = request(processing);
    const response = await fetch(API, {
      method: "POST", signal, body,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch {}
    if (!response.ok || data?.error) {
      const message = data?.error?.message || response.statusText || "request failed";
      lastError = new Error(`OpenRouter (${response.status}): ${message}`);
      if (response.ok || response.status === 429 || response.status >= 500) continue;
      throw lastError;
    }
    const text = (data?.output ?? [])
      .filter(item => item.type === "message")
      .flatMap(item => item.content ?? [])
      .filter(part => part.type === "output_text")
      .map(part => part.text).join("\n").trim();
    if (data?.status === "completed" && text) return { text, processing, response: data };
    lastError = new Error(`Video analysis ended without an answer (${data?.status || "empty response"}).`);
    if (processing === "agentic") {
      processing = "static";
      process.stderr.write("Note: agentic session ended without an answer; retrying with static processing.\n");
    }
  }
  throw new Error(`${lastError.message} Gave up after ${ATTEMPTS} attempts.`);
}

// The CLI prints only text; programmatic callers also get the processing mode
// that answered and the raw response, whose encrypted reasoning items are
// Gemini's video navigation steps.
export async function analyzeVideo(source, question, apiKey = undefined) {
  if (!source || !question?.trim()) throw new Error(USAGE.trim());
  if (/^https?:\/\//i.test(source)) throw new Error("Use a local video file.");
  const key = apiKey ?? await loadKey();
  const video = await prepare(source);
  const signal = AbortSignal.timeout(15 * 60_000);
  try {
    const data = (await readFile(video.path)).toString("base64");
    const request = processing => JSON.stringify({
      model: MODEL,
      instructions: INSTRUCTIONS,
      input: [{
        role: "user",
        content: [
          { type: "input_video", video_url: `data:${video.mime};base64,${data}`, processing },
          { type: "input_text", text: question },
        ],
      }],
    });
    return await ask(key, request, signal);
  } catch (error) {
    if (signal.aborted) throw new Error("Video analysis timed out after 15 minutes.");
    throw new Error(String(error.message).replaceAll(key, "[REDACTED]"));
  } finally {
    await video.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const fail = error => {
    if (error.code !== "EPIPE") process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  };
  process.stdout.on("error", fail);
  const args = process.argv.slice(2);
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
    process.stdout.write(USAGE);
  } else if (args.length !== 2) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
  } else {
    analyzeVideo(...args).then(({ text }) => process.stdout.write(text + "\n"))
      .catch(fail);
  }
}
