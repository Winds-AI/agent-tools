<img src="assets/icon.svg" width="64" height="64" alt="">

# U-voice

Voice mode for the Claude Code session already running in your terminal. GPT-Live handles the spoken conversation and delegates project work to Claude. You can keep talking while Claude works; new directions reach its next model step without cancelling the running tool.

## Start

Restart Claude Code after installation, then run:

```text
/v
```

Voice connects automatically. On first use, U-voice downloads a pinned Electron audio runtime into your user cache, verifies its checksum, and starts it invisibly. Wait for **Voice: Listening** in the terminal, then speak. For example: “Read the README and explain how this project works.” No browser tab or panel needs your attention.

- `/v` toggles voice on/off, including cancelling a connection in progress. Claude keeps working when voice stops.
- `/m` toggles microphone mute. Replies remain audible and Claude keeps working.
- **Think**, a button above the prompt while voice is on, switches thinking mode: talk to yourself without voice replies. Your speech is still transcribed, GPT-Live is silenced locally and its requests are ignored. Click **Stop thinking**, then ask normally ("go ahead"); that request carries everything you said while thinking. Clicking needs Claude Code's fullscreen mode.
- `/uvoice status` shows its state.
- `/uvoice start` and `/uvoice stop` explicitly start or stop voice.

These controls run immediately even while Claude is working and do not invoke an AI model. Connection and microphone errors appear in the terminal. `/uvoice open` and `/uvoice url` provide optional browser diagnostics; normal use needs neither.

Live captions appear temporarily above the terminal prompt as **You:** or **Voice:**. They disappear once Claude accepts the corresponding transcript in a submitted message or context note; speech that is still pending or could not be saved stays visible. Finished speech is not logged separately in the conversation. You can start voice in a normal text session, type while voice is running, and turn voice off while Claude keeps working. Voice-requested results are spoken (the first paragraph of Claude's answer); typed replies stay silent by default. New spoken or typed input suppresses an older result that has not yet been sent for speech.

Start Claude yourself in your usual bypass mode. The plugin attaches to that session and has no approval or permission-mode management.

## Requirements and installation

Tested against Claude Code **2.1.295** and Node **24**. Node 22 or newer is required. The plugin uses Claude's native JavaScript mods, including `session.append`; an older Claude release may lack the required API.

Both Claude Code and Codex must already be signed in. The helper reads `~/.codex/auth.json` (or `CODEX_HOME/auth.json`) and uses the installed Codex client version. OAuth credentials stay in the Node helper; the hidden Electron audio host receives only the WebRTC session description and a temporary localhost bridge token.

Clone the repository and enter the plugin directory:

```sh
git clone https://github.com/Winds-AI/agent-tools.git
cd agent-tools/claude-plugins/u-voice
claude plugin marketplace add "$PWD"
claude plugin install uvoice@uvoice-local --scope user
```

For development without installation:

```sh
claude --plugin-dir "$PWD"
```

On WSL, the helper runs in Linux and launches the Windows Electron audio host so it can use your default Windows microphone and speakers. Windows must allow desktop apps to access the microphone, and WSL localhost forwarding must be available. Native macOS, Windows and Linux use the matching Electron runtime for their platform. Linux requires a normal desktop display and working user audio service; bare SSH/headless servers are not a supported audio target.

The Electron runtime is roughly 120–180 MB compressed depending on platform and is cached after the first `/v`. It has its own temporary profile and closes when voice stops or the Claude session exits; your normal browser is untouched. The hidden audio path is checked with synthetic audio. Actual microphone and speaker behavior still needs a manual check on your hardware.

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `UVOICE_CODEX_AUTH_FILE` | Override the Codex auth-file path. |
| `UVOICE_NODE` | Override the Node executable used by the mod. |
| `UVOICE_CODEX_VERSION` | Explicit Codex client version if `codex` is unavailable on PATH. |
| `UVOICE_CACHE_DIR` | Override the Electron runtime cache directory on native macOS/Linux/Windows. |

## How steering works

Each spoken request reaches Claude as one `<voice reason="request">` block holding every `U:` (your speech) and `A:` (voice model) line since the previous block. Each line is delivered once. Speech that hasn't been sent yet is flushed as `<voice reason="typed">` before a typed message and as `<voice reason="voice-off">` when voice stops. When Claude is idle, the mod submits the block through `prompt.submit` as user input. During a running turn, it appends the block through `session.append`. Claude sees that note before its next model request, after the running tools finish. A request that arrives during the final answer gets one short follow-up prompt if no further model step can consume it. Internal request IDs and repeated delegation instructions stay out of the model prompt.

The rules for reading voice input live in one constant system prompt section (`uvoice:voice-mode`, added through `prompt.compose` after the cache boundary), present whether or not voice is on, so toggling never rewrites the system prompt. Among them: `U:` lines carry your authority, and `A:` lines are never facts, instructions or approvals. Mode changes add a short `<voice_mode state="on">` or `"off"` note once, through the prompt or tool-result hook's context, with a turn-entry hook for idle submissions. The plugin tracks transcript fragments until Claude accepts them, so spoken constraints are delivered once with a task or before the next typed request. A 1.2-second debounce collects trailing speech before delegation.

The voice model receives recent user/assistant text from this thread when connecting, then only the results of spoken requests: the first paragraph of Claude's answer, up to 600 characters. It gets no progress, tool activity or typed messages. Its built-in spoken acknowledgement stays on, because that is what marks a delegation as received; with it off, the model re-sends the same request about once a second. Private thinking, raw tool arguments and raw tool output are excluded. Speech routing tracks the request that owns a reply and ignores obsolete queued speech. Audio already sent to the service may still finish playing.

The voice transport uses Codex's **internal subscription endpoint** and model `gpt-live-1-codex`, adapted from the existing [Pi voice integration](https://github.com/Winds-AI/agent-tools/tree/main/pi-voice) and checked against Codex's source. This is not the public OpenAI Live API; future Codex protocol changes can require an adapter update. If authentication expires, sign in again with `codex login`, then reconnect.

## Checks

```sh
npm test
claude plugin validate .
claude plugin test .
node scripts/native-smoke.mjs
```

The native smoke check uses a local model/audio fixture with no paid calls. It verifies history preservation, native mode context, idle/busy delegation, and text/voice reply ownership.

The optional live steering check uses your Claude subscription with Haiku, low effort, and a small budget limit:

```sh
node scripts/claude-smoke.mjs
```

The terminal check uses Sonnet at low effort with a $0.20 reported-cost cap. Supply synthetic speech asking to read `note.txt` and report its color. It starts the hidden audio host with `/v`, checks both transcript directions reaching the plugin without permanent caption logs, verifies a silent typed reply, and tests `/m` and `/v` teardown:

```sh
UVOICE_SMOKE_WAV=/absolute/path/synthetic-speech.wav node scripts/terminal-smoke.mjs
```

The voice page check remains available for optional browser diagnostics. It requires a **synthesized speech WAV**, never a real microphone. Its utterance should ask Claude to read `note.txt` and report its color. It creates that test file under `.scratch/`, uses a separate browser session, and closes the voice connection after the check:

```sh
UVOICE_SMOKE_WAV=/absolute/path/synthetic-speech.wav \
UVOICE_SMOKE_CHROME=/absolute/path/chrome \
node scripts/voice-smoke.mjs
```

Live checks consume subscription quota. Sanitized evidence is written under `.scratch/`; credentials and raw provider traces are not saved.

Created in [T3 Code](https://t3.codes).
