# Gemini Eyes

Minimal image understanding for pi (or any agent/harness) using your existing
Antigravity CLI login, authentication, and subscription quota. No extra API
keys or accounts.

Sends one or more images to Gemini 3.8 Flash (low thinking effort — the
cheapest fast tier) via the Antigravity backend
(`daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`), and
returns Flash's text response. A non-vision model can call this tool to
understand images. Sister tool to [Codex Eyes](../codex-eyes), which does the
same through Codex.

## Usage

Requires Node.js 22+ and an authenticated Antigravity CLI (run `agy` once and
log in).

```bash
node gemini-eyes.mjs /path/to/image.png
node gemini-eyes.mjs /path/to/image.png "What does this show?"
node gemini-eyes.mjs a.png b.png c.png "Compare these screenshots"
node gemini-eyes.mjs a.png b.png                       # default prompt, 2 images
node gemini-eyes.mjs -h                                # usage
```

That is the entire surface. Positional arguments only:

- **One argument**: a single image, default prompt.
- **Two or more arguments**: all but the last are image paths, the last one
  is the prompt.

The prompt is optional and defaults to `Describe what you see in this image.`
There are no other flags or options. `AGY_HOME` is honored for the auth file
location (default `~/.gemini/antigravity-cli`).

Output: Flash's complete answer is printed to stdout as a single block —
nothing is streamed or printed until the response is fully received. Errors
go to stderr with exit code 1.

## How it works

The Antigravity backend serves Gemini through `POST
https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`
— the same Cloud Code endpoint the Antigravity CLI uses, on the `daily` host.
Auth comes from the CLI's OAuth token file
(`~/.gemini/antigravity-cli/antigravity-oauth-token`, `$AGY_HOME` honored)
via `Authorization: Bearer`, with the `antigravity/cli/...` User-Agent the
CLI itself sends. When the stored access token is stale, the script refreshes
it through `oauth2.googleapis.com/token` and writes the renewed token back to
the same file the CLI uses.

Each request carries `project: "aicode-consumers"` (the free Antigravity
tier's billing project — omitting it yields `SUBSCRIPTION_REQUIRED`),
`userAgent: "antigravity"`, and `thinkingConfig: { thinkingBudget: 0 }` (no
thinking, like codex-eyes' `reasoning: none`). The prompt plus each image as
a base64 `inlineData` part make up the user turn.

Two prompt layers shape the answer:

- A global system prompt tells Flash it is the eyes of a non-vision agent
  and to explain the images from the requester's perspective.
- The per-call prompt is whatever the calling agent wants to know about these
  specific images.

The endpoint answers as an SSE stream of `data:` events; the script waits for
the whole response, concatenates the text parts, and returns them in one
piece. A `finishReason` other than `STOP` is surfaced as an error. On HTTP
429 the error includes the remaining weekly quota fraction from
`retrieveUserQuotaSummary` when that call succeeds.

## Token refresh setup

The Antigravity access token expires about once an hour; the script refreshes
it automatically. The refresh call needs the OAuth client id/secret that
Google issued for the Antigravity CLI — public, installed-app credentials
baked into every copy of the `agy` binary, but kept out of this repository
(GitHub push protection flags them). The script reads them from, in order:

1. `$AGY_OAUTH_CLIENT_ID` and `$AGY_OAUTH_CLIENT_SECRET`, or
2. `$AGY_HOME/oauth-client.json` (i.e.
   `~/.gemini/antigravity-cli/oauth-client.json`):

```json
{ "client_id": "<id>.apps.googleusercontent.com", "client_secret": "GOCSPX-…" }
```

To extract the pair from your own installed binary:

```bash
strings ~/.local/bin/agy | grep -oE '[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com' | sort -u
strings ~/.local/bin/agy | grep -oE 'GOCSPX-[A-Za-z0-9_-]+' | sort -u
```

The binary ships more than one candidate; the refresh endpoint rejects a
mismatched pair with `invalid_client` in seconds, so try them against each
other once and save the working combination to `oauth-client.json`:

```bash
curl -s https://oauth2.googleapis.com/token \
  -d client_id=<id> -d client_secret=<secret> \
  -d refresh_token=$(python3 -c 'import json;print(json.load(open("'$HOME'/.gemini/antigravity-cli/antigravity-oauth-token"))["token"]["refresh_token"]))' \
  -d grant_type=refresh_token
```

A response with `"access_token"` marks the working pair. Until the client
file exists, an expired token simply means: run `agy` once to re-login.

## Quota

Antigravity's free tier meters all Gemini models against one weekly bucket
(`gemini-weekly`, reset each week; third-party models have a separate
bucket). Consumption is proportional to token cost, so small image prompts
observed at roughly 0.05–0.11% of the weekly bucket per call. The bucket can
be inspected with `retrieveUserQuotaSummary`, which is what powers the
rate-limit error message.

## License

MIT
