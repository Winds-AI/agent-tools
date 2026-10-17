import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { VoiceError } from "./errors.mjs";

/**
 * Codex subscription auth adapter, modeled on the read-only Pi voice reference
 * at pi-voice/mac/src/auth.mjs.
 * This bridge deliberately reads only Codex's auth file; it never reads Pi
 * credentials and never falls back to an API key.
 */
export function codexAuthPath(env = process.env) {
  if (env.UVOICE_CODEX_AUTH_FILE?.trim()) return env.UVOICE_CODEX_AUTH_FILE.trim();
  const root = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(root, "auth.json");
}

export async function getCodexAuth({ path = codexAuthPath(), read = readFile } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await read(path, "utf8"));
  } catch {
    throw new VoiceError("Could not read the Codex login. Run `codex login` and reconnect.");
  }

  const token = parsed?.tokens?.access_token;
  const accountId = parsed?.tokens?.account_id;
  if (typeof token !== "string" || !token || typeof accountId !== "string" || !accountId) {
    throw new VoiceError("The Codex login is incomplete. Run `codex login` and reconnect.");
  }
  return { token, accountId };
}
