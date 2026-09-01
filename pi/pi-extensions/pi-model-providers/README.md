# pi-model-providers

Declarative provider/model registration for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).
Unix-style: models are data, not code.

| File | What it is |
|---|---|
| `PROVIDERS.txt` | Operations guide — how to probe a provider, curate its models into pi, and verify the agentic loop (compat flags, thinking levels, pricing, edge cases). Start here. |
| `models.json` | Ready-to-use provider definitions. Copy to `~/.pi/agent/models.json` (or merge into yours), authenticate via `/login`, done. |

This directory is data-only. Pi's package manifest supports extensions, skills,
prompt templates, and themes, but not automatic loading of `models.json`, so
installing the collection does not overwrite your model configuration. Copy the
file explicitly when you want to use these providers:

```bash
cp pi/pi-extensions/pi-model-providers/models.json ~/.pi/agent/models.json
```

## Included providers (probed live 2026-08-28)

- **crofai** — [CrofAI](https://crof.ai) pay-as-you-go, 22 models, full pricing/context/reasoning metadata.
- **command-code** — Command Code, filtered to the **GOAT plan** (42/62 models; premium models excluded; one model excluded for a broken upstream route).

Guiding principle: **only models your actual subscription/setup can access belong in models.json.** Everything was verified empirically (per-model probes), not inferred from marketing pages. See `PROVIDERS.txt` for the method.
