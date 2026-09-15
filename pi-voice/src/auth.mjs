import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { VoiceError } from "./errors.mjs";

/** Resolve the Codex home directory like Codex itself does (CODEX_HOME, else ~/.codex). */
export function codexHome() {
  const env = process.env.CODEX_HOME;
  return env && env.trim() !== "" ? env : join(homedir(), ".codex");
}

/**
 * Codex subscription credentials for GPT-Live.
 *
 * Preference order:
 *  1. Pi's own auth file (`~/.pi/agent/auth.json`, provider `openai-codex`),
 *     because Pi refreshes it while it is in use.
 *  2. Codex's own auth file (`$CODEX_HOME/auth.json` or `~/.codex/auth.json`).
 *
 * A Platform API key is never required and never used.
 */
export async function getCodexAuth({
  piAuthPath = join(homedir(), ".pi", "agent", "auth.json"),
  codexAuthPath = join(codexHome(), "auth.json"),
  now = Date.now(),
} = {}) {
  const attempts = [];

  const pi = await readJson(piAuthPath);
  const piCredential = pi?.["openai-codex"];
  if (piCredential?.access && typeof piCredential.access === "string") {
    const expires = typeof piCredential.expires === "number" ? piCredential.expires : undefined;
    if (expires === undefined || now < expires) {
      const accountId = piCredential.accountId ?? piCredential.account_id;
      if (accountId) {
        return { token: piCredential.access, accountId, source: "pi", expires };
      }
      attempts.push(`${piAuthPath}: openai-codex has no account id`);
    } else {
      attempts.push(`${piAuthPath}: openai-codex credential expired`);
    }
  } else {
    attempts.push(`${piAuthPath}: no openai-codex credential`);
  }

  const codex = await readJson(codexAuthPath);
  const token = codex?.tokens?.access_token;
  const accountId = codex?.tokens?.account_id;
  if (typeof token === "string" && token && typeof accountId === "string" && accountId) {
    return { token, accountId, source: "codex" };
  }
  attempts.push(`${codexAuthPath}: no tokens`);

  throw new VoiceError(
    "No ChatGPT/Codex login found for voice. Run `codex login`, or sign in to Pi with " +
      "Codex so the subscription credential is available, then use /m again. Checked: " +
      attempts.join("; "),
  );
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}
