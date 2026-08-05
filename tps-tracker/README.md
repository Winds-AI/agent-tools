# TPS Tracker

Shows live output-token throughput while Pi generates and reports aggregate streaming throughput when an agent run finishes.

Timing excludes tool execution and first-token latency. Official provider output-token usage is preferred, with a character-based estimate used for the live display until official usage is available.

## Install

Clone the collection, then install this package by local path:

```bash
git clone https://github.com/Winds-AI/pi-extensions.git
pi install ./pi-extensions/tps-tracker
```

Restart Pi after installation.
