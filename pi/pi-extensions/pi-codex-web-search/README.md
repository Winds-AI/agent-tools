# Codex Web Search

Minimal extension for pi: adds one tool, `web_search`, powered by your existing Codex login, authentication, and subscription quota. No extra API keys or accounts.

pi ships without a web search tool by default. This extension exposes Codex's hosted web search to pi, so any pi model can fetch current web information. Built and verified against pi 0.84.2.

As of August 17, 2026, the new standalone WebRun tool (`web/run`) is still experimental in Codex. Once it becomes stable, we will look into migrating this extension to it.

## Install

Requires Node.js 22+ and an authenticated Codex CLI (`codex login`).

```bash
git clone https://github.com/Winds-AI/agent-tools.git
cd agent-tools
pi install ./pi/pi-extensions/pi-codex-web-search
```

Restart Pi after installation.

## Tool: `web_search`

| Parameter | Description |
|-----------|-------------|
| `query` | What to search for |
| `maxSources` | Max sources (1-10, default 5) |
| `freshness` | `cached` (default) or `live` for time-sensitive |

## License

MIT
