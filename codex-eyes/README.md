# Codex Eyes

Minimal image understanding for pi (or any agent/harness) using your existing
Codex login, authentication, and subscription quota. No extra API keys or
accounts.

Sends one or more images to GPT-5.6 Luna (low-cost, fast model) via the
ChatGPT `backend-api/codex/responses` endpoint — the same one Codex CLI uses —
with `reasoning: none` in standard mode, and returns Luna's text response. A
non-vision model can call this tool to understand images.

## Usage

Requires Node.js 22+ and an authenticated Codex CLI (`codex login`).

```bash
node codex-eyes.mjs /path/to/image.png "What does this show?"
```

Multiple images in one call:

```bash
node codex-eyes.mjs a.png b.png c.png "Compare these screenshots"
```

The prompt is optional — defaults to `Describe what you see in this image.`
If two or more positional arguments are given, the last one is the prompt.

## How it works

The ChatGPT backend serves Luna through `POST
https://chatgpt.com/backend-api/codex/responses`. This script sends the prompt
plus each image as a base64 data URL in the request, with
`reasoning: { effort: "none" }` (no reasoning), `store: false`, and no
`service_tier` (standard mode, not priority/fast). Auth comes from
`~/.codex/auth.json` (`$CODEX_HOME` is honored) via `Authorization: Bearer` +
`ChatGPT-Account-Id` headers, with `originator: codex_cli_rs`.

Two prompt layers shape the answer:

- A global system prompt tells Luna it is the eyes of a non-vision agent and
  to explain the images from the requester's perspective.
- The per-call prompt is whatever the calling agent wants to know about these
  specific images.

We use plain HTTP (SSE), not the WebSocket transport Codex prefers for Luna.
Fast/priority mode is not reliably honored over this HTTP path — the backend
serves responses at the standard/default tier regardless — so we stay in
standard mode. The SSE stream is consumed incrementally and failure events
(`response.failed`, `response.incomplete`, `error`) are surfaced as errors.

## License

MIT
