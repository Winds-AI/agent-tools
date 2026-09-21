# pi-native-codex-web-search

Native web search for Pi using the same API and auth as Codex CLI.

## Install

```bash
pi install npm:@winds-ai/pi-native-codex-web-search
```

Or from this repository:

```bash
git clone https://github.com/Winds-AI/agent-tools.git
cd agent-tools
pi install ./pi/pi-extensions/pi-codex-web-search
```

Restart Pi after installation.

> **Status:** As of August 17, 2026, the new standalone WebRun tool (`web/run`)
> is still experimental in Codex. Once it becomes stable, we will look into
> migrating this extension to it.

## Why Codex as the middleman?

During development, we discovered that **web search is not a standalone tool** — it's a native feature built into OpenAI's Responses API. Here's what we found:

### The architecture problem

When you use Codex and ask it to search the web, this happens:

1. Codex calls OpenAI's Responses API with `{ "type": "web_search" }` in the tools array
2. OpenAI's configured model in cli natively decides when to search and handles it
3. The search results come back as part of the model's response stream

The web search tool is **not** something Codex implements — it's OpenAI's built-in capability that Codex configures and passes through.

### Why we can't call OpenAI directly

We tried calling `api.openai.com/v1/responses` directly with the OAuth token from Pi's auth file. It failed with:

```
401: Missing scopes: api.responses.write
```

ChatGPT/Codex OAuth tokens are scoped for Codex's specific backend, not the standard OpenAI API. The standard API requires API keys with `api.responses.write` scope.

### The solution: ChatGPT's backend API

Codex actually calls a different endpoint:

```
https://chatgpt.com/backend-api/codex/responses
```

This endpoint:
- Accepts ChatGPT OAuth tokens (from `~/.codex/auth.json`)
- Requires `stream: true` and `store: false`
- Uses configured model
- Supports the native `web_search` tool

So this extension calls the **exact same API** that Codex CLI uses, with the **exact same auth**. It's not wrapping the Codex CLI — it's reimplementing the same API call that Codex makes internally.

## What the caller receives

The backend runs the search inside the model's own turn and never exposes raw
page content to the caller — only the model's answer text plus a record of the
`web_search_call` actions. The tool output therefore ends with the queries that
were actually executed and the sources cited:

```
---
executed queries: site:anthropic.com/news "September 1, 2026" ... | ...
sources: https://www.anthropic.com/... | ...
(Synthesized summary, not raw page content — check the executed queries when recency matters.)
```

The executed queries are the only evidence of search coverage available, so they
are surfaced rather than hidden in `details`. If an answer is load-bearing and
recency-sensitive, check that the queries actually targeted the current period,
and corroborate with a retrieval tool that returns raw documents.

Diagnostics that are useful to a human but not to the model — the model used,
its reasoning effort, and the number of search calls — are kept in `details` and
shown in the expanded TUI view (`Ctrl+O`) instead of the tool output, so they do
not consume model context on every call.
## Runtime settings

**Model** — read from `~/.codex/config.toml`, because this extension borrows
Codex's *credentials* but not its *settings*. Earlier releases pinned the model
in source, so it silently drifted away from whatever the CLI was configured to
use.

| config.toml key | sent as |
| --- | --- |
| `model` | request `model` |

**Reasoning and verbosity** — deliberately *not* inherited from the coding
agent's config. Search runs on minimal generation settings, since higher effort
only buys latency for retrieval-and-summarize work:

| Setting | Default |
| --- | --- |
| `reasoning.effort` | `low` (the lowest value the endpoint accepts) |
| `text.verbosity` | `low` |

These are sent *explicitly*. Omitting `reasoning` is not the same as requesting
the floor — the backend then applies `medium`.

Environment variables take precedence over everything:

| Variable | Purpose |
| --- | --- |
| `CODEX_WEB_SEARCH_MODEL` | Override the model |
| `CODEX_WEB_SEARCH_REASONING_EFFORT` | Override effort (`low`…`max`); `off` omits the field |
| `CODEX_WEB_SEARCH_VERBOSITY` | Override verbosity; `off` omits the field |

If the config file is missing, the extension falls back to its built-in model.
If a config-derived request is rejected with HTTP 400 (unknown model id or an
unsupported effort), the search is retried once with the built-in model and
backend defaults rather than failing outright.

## Requirements

- Node.js 22+
- Codex CLI installed and authenticated (`codex login`)

## Tool: `web_search`

| Parameter | Description |
|-----------|-------------|
| `query` | What to search for |
| `maxSources` | Max sources (1-10, default: 5) |
| `freshness` | `cached` (default) or `live` for time-sensitive |

## Auth

Uses credentials from `~/.codex/auth.json`. If search fails, run:

```bash
codex login
```

## License

CC0-1.0
