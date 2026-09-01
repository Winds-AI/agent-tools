# Pi extensions

This directory contains the Pi extension packages included by the repository-level [`package.json`](../../package.json). Install the complete collection from GitHub with:

```bash
pi install git:github.com/Winds-AI/agent-tools
```

Each TypeScript extension also has its own `package.json` and can be installed from a local clone by passing its directory to `pi install`. `pi-model-providers` is an accompanying data directory, not an auto-loaded extension.
