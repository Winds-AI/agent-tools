<img src="assets/icon.svg" width="64" height="64" alt="">

# U-voice for OpenCode

Voice mode for the OpenCode session already open in your terminal. Codex GPT-Live (`gpt-live-1-codex`, on your ChatGPT/Codex subscription) handles the spoken conversation and hands project work to OpenCode. You can keep talking while OpenCode works; new directions join its next model step without cancelling the running tool.

Port of the [U-voice Claude Code plugin](https://github.com/Winds-AI/agent-tools/tree/main/claude-plugins/u-voice). The Codex helper, hidden Electron audio host and GPT-Live protocol are the same code; only the host binding is new.

## Use

Open a session, then:

- `/v` toggles voice on or off for that session. Wait for **Voice: Listening** in the footer, then speak.
- `/m` mutes or unmutes the microphone. Replies stay audible.

Live captions (**You:** / **Voice:**) appear above the composer until the session has received them. The answer to a spoken request is spoken back (its first paragraph, up to 600 characters). Typed requests stay silent.

## Install

Requires OpenCode 2.x (tested on 2.0.32), Node 22+ on `PATH`, and a signed-in Codex CLI (`codex login`; the helper reads `~/.codex/auth.json` and `codex --version`). Clone the repository and link the plugin into OpenCode's global plugin directory:

```sh
git clone https://github.com/Winds-AI/agent-tools.git
ln -s "$PWD/agent-tools/opencode-plugins/u-voice" ~/.config/opencode/plugins/uvoice
```

OpenCode loads `server.js` in its server and `tui.tsx` in the terminal UI. The first `/v` downloads the pinned Electron audio runtime (about 120–180 MB) into the same cache the Claude plugin uses, so a machine that ran U-voice already skips the download.

Optional environment variables: `UVOICE_NODE` (Node executable), `UVOICE_CODEX_AUTH_FILE`, `UVOICE_CODEX_VERSION`, `UVOICE_CACHE_DIR`, `UVOICE_TEST_AUDIO_WAV` (synthetic speech instead of the microphone, for tests), `UVOICE_DEBUG_LOG` (event trace without transcript text).

## How it maps onto OpenCode

| Need | OpenCode v2 API |
| --- | --- |
| Spoken request, idle or busy | `client.session.prompt` with `delivery: "steer"`: starts a turn when idle, joins the next step when busy |
| Mode switches, speech left at voice-off | `client.session.synthetic` with `resume: false` (context only, starts nothing) |
| Speech said before a typed message | server `session.hook("prompt")` prepends it as `<voice reason="typed">`; the TUI keeps the server's copy current over plugin RPC |
| Voice rules for the agent | server `session.hook("context")` adds one constant system section |
| Results to speak | `session.inbox.delivered` / `session.text.ended` / `session.execution.*` events |
| `/v`, `/m`, footer status, captions | TUI `keymap.layer` slash commands, `prompt.footer.status` and `session.composer.top` slots |

## Differences from the Claude Code plugin

- No **Think** button yet (talk to yourself with GPT-Live silent).
- Voice binds to the session where you ran `/v`.
- The helper, audio host and Electron runtime code are copies of the Claude plugin's (with OpenCode named in the voice instructions). Keep `scripts/electron-runtime-manifest.json` identical in both so they share one cached Electron.

## Checks

```sh
npm test
```

Offline tests cover the server hooks and the transcript ledger. The live path was checked in tmux on WSL with synthetic speech: a spoken request, a correction spoken while a `sleep 25` tool call ran (one combined answer, spoken back), a typed message after speech, `/m`, and `/v` teardown.
