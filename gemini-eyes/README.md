# Gemini Eyes

Minimal image understanding for pi (any agent/harness) using your existing Antigravity CLI login, authentication, and free-tier quota. No extra API keys or accounts.

Sends one or more images to Gemini 3.7 Flash (tiered) via the same `v1internal` endpoints the Antigravity CLI uses, with thinking at the lowest level the API accepts, and returns the text response. A non-vision model can call this tool to understand images.

## Usage

Requires Node.js 22+ (for `fetch` and `crypto.randomUUID`), macOS (for the `security` Keychain lookup), and an authenticated Antigravity CLI (`agy` — run it once and sign in with Google).

```bash
node gemini-eyes.mjs /path/to/image.png "What does this show?"
```

Multiple images in one call:

```bash
node gemini-eyes.mjs a.png b.png c.png "Compare these screenshots"
```

The prompt is optional — defaults to `Describe what you see in this image.`

## How it works

Auth comes from the same macOS Keychain item the Antigravity CLI writes (service `gemini`, account `antigravity`): an OAuth access token plus a refresh token. If the access token is expired, it is refreshed via the Google OAuth endpoint using the product's public OAuth client credentials, which are read from the installed `agy` binary at runtime (override with `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` env vars). Then:

1. `POST cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` → gets the account's `cloudaicompanionProject`.
2. `POST daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse` → sends prompt + images as base64 `inlineData`, with `generationConfig.thinkingConfig.thinkingLevel: "LOW"` (the API's no-reasoning floor — `NONE` is rejected, and `thinkingBudget: 0` still spends thought tokens).

We use plain HTTPS/SSE, not the WebSocket transport the Antigravity IDE prefers. The model is `gemini-3.7-flash-tiered` ("tiered" = reasoning level is set per request rather than baked into the model id). Free tier quota is a weekly token budget shared across Gemini models; the CLI's `/usage` command shows the remaining fraction.

Deliberately no retries, no fallback chain, no waiting inside the script — one attempt, a clear error with exit code, and the agent decides what to do next (e.g. re-run later). Exit codes: `0` answered, `1` usage/auth/fatal error, `2` quota or transient overload.

## License

MIT
