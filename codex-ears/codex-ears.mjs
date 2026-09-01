#!/usr/bin/env node

// codex-ears — transcribe an audio file with your existing Codex login.
// Talks to the same ChatGPT dictation endpoint the Codex app uses, using the
// OAuth tokens from ~/.codex/auth.json. One job: audio in, transcript out.
//
// curl is used as the HTTP transport because the transcribe endpoint rejects
// non-curl TLS fingerprints (Node's fetch/https/http2 get 403 here), while
// curl is universally available on machines that run Codex.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const MODEL = "gpt-4o-mini-transcribe";

function usage() {
  process.stderr.write(`Usage: node codex-ears.mjs <audio-file> [--lang <bcp-47>]\n`);
}

/** Resolve the Codex home dir like Codex itself does (CODEX_HOME, else ~/.codex). */
function codexHome() {
  const env = process.env.CODEX_HOME;
  return env && env.trim() !== "" ? env : join(homedir(), ".codex");
}

/** Read the ChatGPT OAuth access token from the local Codex login file. */
async function getAccessToken() {
  const authPath = join(codexHome(), "auth.json");
  let auth;
  try {
    auth = JSON.parse(await readFile(authPath, "utf8"));
  } catch {
    throw new Error(`Could not read Codex auth file at ${authPath}. Run \`codex login\` first.`);
  }
  const token = auth.tokens?.access_token;
  if (!token) throw new Error(`No access token in ${authPath}. Run \`codex login\` first.`);
  return token;
}

/** Parse args: one audio path plus an optional --lang <code> (re-transcription language). */
function parseArgs(argv) {
  const args = { audio: undefined, lang: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--lang") {
      const value = argv[++i];
      if (!value) throw new Error("--lang requires a value (e.g. en-US).");
      args.lang = value;
    } else if (arg.startsWith("--lang=")) {
      args.lang = arg.slice("--lang=".length);
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (args.audio === undefined) {
      args.audio = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }
  if (!args.audio) {
    usage();
    throw new Error("No audio file given.");
  }
  return args;
}

/** POST the audio file via curl. Resolves with the response body, rejects with a clean message. */
function transcribe(token, audioPath, lang) {
  const formArgs = [
    `file=@${audioPath}`,
    `model=${MODEL}`,
    "response_format=json",
  ];
  if (lang) formArgs.push(`audio={"language":"${lang}"}`);

  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      [
        "--fail-with-body",
        "--silent",
        "--show-error",
        "--max-time", "300",
        TRANSCRIBE_URL,
        "-A", "Codex Desktop",
        "-H", `Authorization: Bearer ${token}`,
        "-H", "originator: Codex Desktop",
        ...formArgs.flatMap((f) => ["-F", f]),
      ],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 320_000 },
      (error, stdout, stderr) => {
        if (error) {
          if (error.code === 401 || /401/.test(String(error.message))) {
            reject(new Error("Authentication failed. Run `codex login` first."));
          } else {
            reject(new Error(`Transcription request failed: ${stderr.trim() || error.message}`));
          }
          return;
        }
        resolve(stdout);
      },
    );
  });
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = await getAccessToken();

  const responseText = await transcribe(token, args.audio, args.lang);

  let transcript;
  try {
    transcript = JSON.parse(responseText).text;
  } catch {
    transcript = undefined;
  }
  if (typeof transcript !== "string") {
    throw new Error(`Unexpected API response: ${responseText.slice(0, 500)}`);
  }

  // Write the transcript to a temp file and print the path for the caller.
  const outputPath = join(tmpdir(), `codex-transcript-${randomUUID()}.txt`);
  await writeFile(outputPath, transcript);
  process.stdout.write(`${outputPath}\n`);
}
