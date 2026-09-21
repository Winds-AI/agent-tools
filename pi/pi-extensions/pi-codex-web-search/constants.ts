export const TOOL_NAME = "web_search";

// Codex ChatGPT backend API endpoint
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

// Fallback only. The model is normally read from ~/.codex/config.toml so this
// extension tracks the Codex CLI automatically; DEFAULT_MODEL is used when that
// file is missing or when a config-derived request is rejected by the backend.
export const DEFAULT_MODEL = "gpt-5.6-sol";

export const DEFAULT_MAX_SOURCES = 5;
export const MAX_ALLOWED_SOURCES = 10;
export const SEARCH_TIMEOUT_MS = 120_000;

// Search runs its own minimal generation settings rather than inheriting the
// coding agent's. These are sent explicitly: omitting `reasoning` is NOT the
// same as requesting the floor, because the backend then applies `medium`.
// `low` is the lowest value the endpoint accepts; `off` (see below) omits it.
export const DEFAULT_REASONING_EFFORT = "low";
export const DEFAULT_VERBOSITY = "low";

// Optional environment overrides. Set an effort/verbosity variable to "off" to
// omit the field entirely.
export const ENV_MODEL = "CODEX_WEB_SEARCH_MODEL";
export const ENV_REASONING_EFFORT = "CODEX_WEB_SEARCH_REASONING_EFFORT";
export const ENV_VERBOSITY = "CODEX_WEB_SEARCH_VERBOSITY";

export const CODEX_CONFIG_FILENAME = "config.toml";
