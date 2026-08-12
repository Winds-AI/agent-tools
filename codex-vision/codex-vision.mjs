#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const [imageArg, ...instructionParts] = process.argv.slice(2);
const instruction = instructionParts.join(" ").trim();

const { stdout } = spawnSync("codex", [
  "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
  "--sandbox", "read-only", "--model", "gpt-5.6-luna",
  "--config", 'model_reasoning_effort="low"',
  `Inspect the image and answer only this request: ${instruction}`,
  "--image", imageArg,
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

process.stdout.write(stdout);
