# Raw Probe

Ask any Pi-configured model a direct question through its provider API — **no tools, no agent loop, no injected prompt system**. You get the pure model response, including thinking blocks when the provider returns them unencrypted.

Designed for probing what a model natively knows, how it reasons, and how it behaves before writing its agent prompt.

## Install

Clone the collection, then install this package by local path:

```bash
pi install git:github.com/Winds-AI/agent-tools
```

To install only this extension from a local clone, use `pi install ./pi/pi-extensions/raw-probe` from the repository root. Restart Pi after installation.

To use the extension directly without installing, copy `index.ts` into `~/.pi/agent/extensions/`.

## Tools

| Tool | Active by default | Purpose |
|------|-------------------|---------|
| `search_tools` | ✅ | Loads registered tools on demand. Use ONLY on explicit user request, never proactively. |
| `raw_probe` | ❌ (loaded on demand) | Single-shot question to any Pi-configured model via its provider API — no tools, no agent loop, optional system prompt, returns thinking blocks when unencrypted. |
| `list_raw_models` | ❌ (loaded on demand) | Lists all models callable through `raw_probe` — subscriptions (e.g. openai-codex, cursor, xai) and API-key providers — as `provider/model-id`. |

`raw_probe` and `list_raw_models` are registered but inactive until `search_tools` loads them, so they never touch the system prompt and provider prompt caching stays stable.

## Usage

1. Ask the agent to find the probing tool via the search tool:

   > Use the search tool to find the tool that asks a raw model a direct question.

   This activates `raw_probe` and `list_raw_models`.

2. List what you can call:

   > List the raw models I can call.

   Returns one `provider/model-id` per line, e.g. `opencode-go/kimi-k2.6`.

3. Probe a model:

   > Use raw_probe on opencode-go/kimi-k2.6: what do you know about X?

   The model answers directly through its provider API — no tools, no agent loop, optional system prompt. Thinking blocks are returned when the provider exposes them unencrypted.

## License

MIT
