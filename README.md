# Agent Tools

Standalone tools and Pi resources maintained by Winds AI.

## Pi extensions

All Pi extension packages are grouped under [`pi/pi-extensions`](pi/pi-extensions). Each extension has its own `package.json` and is installed independently. This repository does not use a build step or publish an npm package.

Pi treats a git source as the repository root, so clone the repository and pass the individual extension directory to `pi install`:

```bash
git clone https://github.com/Winds-AI/agent-tools.git
cd agent-tools
pi install ./pi/pi-extensions/pi-browser-comment
```

For `pi-exa-web`, Pi installs its declared `dotenv` runtime dependency when installing that extension directory.

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

The other top-level directories contain standalone agent utilities and are not Pi extensions.
