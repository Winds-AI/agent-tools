# Agent Tools

Standalone tools and Pi resources maintained by Winds AI.

## Pi extensions

All Pi extension entrypoints are grouped under [`pi/pi-extensions`](pi/pi-extensions). The repository-level `package.json` exposes those entrypoints as one Pi package, so the complete collection can be installed directly from GitHub:

```bash
pi install git:github.com/Winds-AI/agent-tools
```

Pi installs the TypeScript sources directly; this repository does not use a build step or publish an npm package. The `pi-exa-web` extension declares its `dotenv` runtime dependency, which Pi installs automatically when installing the git package.

To install just one extension from a local clone:

```bash
git clone https://github.com/Winds-AI/agent-tools.git
cd agent-tools
pi install ./pi/pi-extensions/pi-browser-comment
```

Use `pi config` to enable or disable individual resources after installing the collection.

| Extension | Path |
| --- | --- |
| Browser Comment | `pi/pi-extensions/pi-browser-comment` |
| Codex Web Search | `pi/pi-extensions/pi-codex-web-search` |
| Exa Web | `pi/pi-extensions/pi-exa-web` |
| Model Favorites | `pi/pi-extensions/pi-model-favorites` |
| Pi Sticky | `pi/pi-extensions/pi-sticky` |
| TPS Tracker | `pi/pi-extensions/pi-tps-tracker` |
| User Message Navigation | `pi/pi-extensions/pi-user-message-navigation` |
| Raw Probe | `pi/pi-extensions/raw-probe` |

[`pi/pi-extensions/pi-model-providers`](pi/pi-extensions/pi-model-providers) contains provider/model data for copying into Pi's `models.json`; it is intentionally data-only because Pi packages do not auto-load custom model catalogs.

The other top-level directories contain standalone agent utilities and are not loaded by the Pi package manifest.
