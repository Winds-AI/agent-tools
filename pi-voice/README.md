# pi-voice

Voice conversations for Pi, with Pi remaining the only executor. Two platform
implementations live side by side:

| Directory | Platform | Transport | Authentication |
| --- | --- | --- | --- |
| [`wsl-windows/`](wsl-windows/) | WSL on Windows | GPT-Live WebSocket API with PCM audio | Platform API key |
| [`mac/`](mac/) | macOS | WebRTC into the Codex realtime endpoint | ChatGPT/Codex subscription |

Both keep a local VAD so the metered voice session only opens when you actually
speak, hand the spoken request to Pi, and speak Pi's answer back.
