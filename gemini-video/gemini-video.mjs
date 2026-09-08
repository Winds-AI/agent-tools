#!/usr/bin/env node

import { createReadStream, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://generativelanguage.googleapis.com";
const MODEL = "gemini-3.8-flash";
const KEY_FILE = join(homedir(), ".config/gemini-video/api-key");
const MIME = new Map([
  [".mp4", "video/mp4"], [".mov", "video/quicktime"],
  [".webm", "video/webm"], [".avi", "video/x-msvideo"],
  [".mpeg", "video/mpeg"], [".mpg", "video/mpeg"],
  [".m4v", "video/mp4"], [".wmv", "video/x-ms-wmv"],
]);
const USAGE = 'Usage: gemini-video <video-path-or-youtube-url> "<question>"\n';

async function loadKey() {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (key) return key;
  try {
    const saved = (await readFile(KEY_FILE, "utf8")).trim();
    if (saved) return saved;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  throw new Error(`Set GEMINI_API_KEY or save your key in ${KEY_FILE}.`);
}

async function check(response) {
  if (response.ok) return response;
  let message = response.statusText;
  try { message = (await response.json()).error?.message || message; } catch {}
  if (response.status === 429) message = `Quota exhausted or rate limited. ${message}`;
  throw new Error(`Gemini API (${response.status}): ${message}`);
}

function youtube(source) {
  if (!/^https?:\/\//i.test(source)) return null;
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname)) {
    throw new Error("Use a local video file or a public HTTPS YouTube URL.");
  }
  return url.href;
}

// The CLI prints only text; programmatic callers can also inspect processing
// steps and token usage in the returned interaction.
export async function analyzeVideo(source, question, apiKey = undefined) {
  if (!source || !question?.trim()) throw new Error(USAGE.trim());
  const uri = youtube(source);
  const mime = uri ? undefined : MIME.get(extname(source).toLowerCase());
  if (!uri && !mime) throw new Error("Unsupported video extension; use MP4, MOV, WebM, AVI, MPEG, M4V, or WMV.");
  const info = uri ? undefined : await stat(source);
  if (info && (!info.isFile() || info.size === 0)) throw new Error("Video must be a nonempty regular file.");
  if (info?.size > 2 * 1024 ** 3) throw new Error("Video exceeds the 2 GB free-tier upload limit.");
  const key = apiKey ?? await loadKey();
  const signal = AbortSignal.timeout(10 * 60_000);
  const request = async (path, options = {}) => check(await fetch(`${API}${path}`, {
    ...options, headers: { "x-goog-api-key": key, ...options.headers }, signal,
  }));
  let uploaded;
  try {
    let video = { type: "video", uri, processing: "agentic" };
    if (!uri) {
      const start = await request("/upload/v1beta/files", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(info.size),
          "X-Goog-Upload-Header-Content-Type": mime,
        },
        body: JSON.stringify({ file: { display_name: "gemini-video" } }),
      });
      const uploadUrl = start.headers.get("x-goog-upload-url");
      if (!uploadUrl) throw new Error("API did not return an upload URL.");
      const stream = createReadStream(source);
      try {
        const response = await check(await fetch(uploadUrl, {
          method: "POST",
          headers: {
            "Content-Length": String(info.size), "Content-Type": mime,
            "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize",
          },
          body: stream, duplex: "half", signal,
        }));
        uploaded = (await response.json()).file;
      } finally { stream.destroy(); }
      if (!uploaded?.name) throw new Error("Upload response is missing file metadata.");
      while (uploaded.state === "PROCESSING") {
        await sleep(2000, undefined, { signal });
        uploaded = await (await request(`/v1beta/${uploaded.name}`)).json();
      }
      if (uploaded.state !== "ACTIVE") throw new Error(`Video processing failed: ${uploaded.state}.`);
      video = { ...video, uri: uploaded.uri, mime_type: uploaded.mimeType || mime };
    }
    const response = await request("/v1beta/interactions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL, store: false,
        system_instruction: "Include timestamps for the moments supporting your answer.",
        input: [video, { type: "text", text: question }],
      }),
    });
    const interaction = await response.json();
    if (interaction.status !== "completed") {
      throw new Error(`Video analysis did not complete (${interaction.status || "unknown status"}).`);
    }
    const text = (interaction.steps ?? [])
      .filter(step => step.type === "model_output")
      .flatMap(step => step.content ?? [])
      .filter(part => part.type === "text")
      .map(part => part.text).join("\n").trim();
    if (!text) throw new Error("Gemini returned no text answer.");
    return { text, interaction };
  } catch (error) {
    if (signal.aborted) throw new Error("Video analysis timed out after 10 minutes.");
    throw new Error(String(error.message).replaceAll(key, "[REDACTED]"));
  } finally {
    if (uploaded?.name) {
      try {
        await check(await fetch(`${API}/v1beta/${uploaded.name}`, {
          method: "DELETE", headers: { "x-goog-api-key": key },
          signal: AbortSignal.timeout(10_000),
        }));
      } catch {
        process.stderr.write("Warning: uploaded video cleanup failed; Gemini Files expire automatically after 48 hours.\n");
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
    process.stdout.write(USAGE);
  } else if (args.length !== 2) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
  } else {
    analyzeVideo(...args).then(({ text }) => process.stdout.write(text + "\n"))
      .catch(error => { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; });
  }
}
