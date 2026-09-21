import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CODEX_CONFIG_FILENAME,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_VERBOSITY,
  ENV_MODEL,
  ENV_REASONING_EFFORT,
  ENV_VERBOSITY,
} from "./constants.js";

export interface CodexRuntimeConfig {
  model: string;
  /** Reasoning effort to send, or null to let the backend default apply. */
  reasoningEffort: string | null;
  /** Response verbosity to send, or null to let the backend default apply. */
  verbosity: string | null;
}

/**
 * Read a top-level TOML string key.
 *
 * TOML does not allow returning to the root table once a section starts, so any
 * key belonging to the root table must appear before the first `[section]`
 * header. That makes "stop at the first section" the semantically correct scan,
 * and avoids picking up section-scoped keys that happen to share the name.
 */
function topLevelString(text: string, key: string): string | undefined {
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/u);
    if (match && match[1] === key) {
      const value = (match[2] ?? match[3] ?? "").trim();
      return value || undefined;
    }
  }
  return undefined;
}

/**
 * Resolve one knob. An explicit `off`/`none` omits the field entirely; an unset
 * or blank value falls back to the search-specific default rather than the
 * backend default, so an empty variable cannot silently make searches run at
 * `medium` reasoning.
 */
function resolveKnob(envValue: string | undefined, fallback: string): string | null {
  const trimmed = envValue?.trim().toLowerCase() ?? "";
  if (!trimmed) return fallback;
  if (trimmed === "off" || trimmed === "none") return null;
  return trimmed;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

/**
 * Resolve the knobs sent to the search request.
 *
 * The model comes from ~/.codex/config.toml so the extension tracks the Codex
 * CLI instead of pinning an outdated constant.
 *
 * Reasoning and verbosity deliberately do NOT inherit the coding agent's
 * settings — search runs on its own minimal values, because expensive generation
 * settings only buy latency here. They are still overridable per environment.
 *
 * Precedence: environment variable, then config.toml (model only), then default.
 */
export async function readCodexRuntimeConfig(): Promise<CodexRuntimeConfig> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  let text = "";
  try {
    text = await readFile(join(codexHome, CODEX_CONFIG_FILENAME), "utf-8");
  } catch {
    // No config file: fall through to the built-in model and defaults.
  }

  return {
    model:
      firstNonEmpty(process.env[ENV_MODEL], topLevelString(text, "model"), DEFAULT_MODEL) ??
      DEFAULT_MODEL,
    reasoningEffort: resolveKnob(process.env[ENV_REASONING_EFFORT], DEFAULT_REASONING_EFFORT),
    verbosity: resolveKnob(process.env[ENV_VERBOSITY], DEFAULT_VERBOSITY),
  };
}
