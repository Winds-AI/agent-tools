#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const audioPath = process.argv[2];
const authPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
const { tokens } = JSON.parse(await readFile(authPath, "utf8"));
const codexVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim().split(" ").at(-1);

const response = execFileSync("curl", [
  "--fail-with-body",
  "--silent",
  "--show-error",
  "https://chatgpt.com/backend-api/transcribe",
  "-A", `Codex Desktop/${codexVersion}`,
  "-H", `Authorization: Bearer ${tokens.access_token}`,
  "-H", "originator: Codex Desktop",
  "-F", `file=@${audioPath}`,
], { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });

const outputPath = join(tmpdir(), `codex-transcript-${randomUUID()}.txt`);
await writeFile(outputPath, JSON.parse(response).text);
process.stdout.write(`${outputPath}\n`);
