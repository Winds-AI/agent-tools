# pi-model-favorites

A model picker for [pi](https://pi.dev) with your **favorite models pinned to the top** — a faithful clone of the built-in `/model` selector UI (search input, fuzzy filtering, `→` selection, `[provider]` badges, `✓` on the active model, scroll indicators, background catalog refresh).

## Install

```bash
git clone https://github.com/Winds-AI/agent-tools.git
cd agent-tools
pi install ./pi/pi-extensions/pi-model-favorites
```

Restart Pi after installation.

## Usage

```
/models
```

Opens the picker with favorites (★) pinned above a divider. Everything else behaves like the built-in `/model`:

| Key | Action |
|-----|--------|
| `f` | Toggle favorite on the focused model (when the search box is empty) |
| `↑` / `↓` | Navigate (wraps around) |
| Type | Fuzzy-filter by name, id, or provider |
| `Tab` | Toggle scope all/scoped (when scoped models are configured) |
| `Enter` | Select the focused model |
| `Esc` | Cancel |

`/models <query>` opens the picker pre-filtered.

## Favorites file

Favorites persist to `~/.pi/agent/model-favorites.json`:

```json
{
  "favorites": ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]
}
```

Keys are `provider/modelId`. The file is compatible with the same file used by other favorites extensions.

## License

MIT
