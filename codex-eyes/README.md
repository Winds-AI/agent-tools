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
node codex-eyes.mjs /path/to/image.png
node codex-eyes.mjs /path/to/image.png "What does this show?"
node codex-eyes.mjs a.png b.png c.png "Compare these screenshots"
node codex-eyes.mjs a.png b.png                       # default prompt, 2 images
node codex-eyes.mjs -h                                # usage
```

That is the entire surface. Positional arguments only:

- **One argument**: a single image, default prompt.
- **Two or more arguments**: all but the last are image paths, the last one
  is the prompt.

The prompt is optional and defaults to `Describe what you see in this image.`
There are no other flags or options. `CODEX_HOME` is honored for the auth
file location.

Output: Luna's complete answer is printed to stdout as a single block —
nothing is streamed or printed until the response is fully received. Errors
go to stderr with exit code 1.

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
standard mode. The endpoint requires `stream: true` on the wire (it rejects
`stream: false`), but the script simply waits for the whole response and
returns Luna's text in one piece; the caller never sees a stream. Failure
events (`response.failed`, `response.incomplete`, `error`) are surfaced as
errors.

## License

MIT
