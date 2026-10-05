# Claude Code plugins

Each plugin is maintained in its own directory and installed independently.

| Plugin | Version | Description |
| --- | --- | --- |
| [U-voice](u-voice) | 0.3.0 | Subscription-backed voice conversation in your current Claude Code session, terminal captions, and mixed voice/text input. |

Install U-voice from a local clone of this repository:

```sh
claude plugin marketplace add ./claude-plugins/u-voice
claude plugin install uvoice@uvoice-local --scope user
```

Restart Claude Code after installation. See [U-voice's documentation](u-voice/README.md) for supported environments, controls, and checks.
