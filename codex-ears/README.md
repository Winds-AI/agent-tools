# Codex Ears

Minimal voice transcription for pi(any agent/harness) using your existing Codex login, authentication, and subscription quota. No extra API keys or accounts.

Accepts an audio file (any format the ChatGPT transcribe API supports, e.g. WAV, MP3, M4A, WebM/Opus), sends it to ChatGPT's `backend-api/transcribe` endpoint — the same one the ChatGPT desktop app and Codex CLI use for dictation — and returns the transcript.

## Usage

Requires Node.js 22+ and an authenticated Codex CLI (`codex login`).

```bash
node codex-ears.mjs /path/to/voice-note.wav
```

The script writes the transcript to a temp text file and prints the file path.

## How it works

The ChatGPT desktop app sends recorded voice as a whole file (multipart) to `POST https://chatgpt.com/backend-api/transcribe`. This script does exactly that, using credentials from `~/.codex/auth.json` (`$CODEX_HOME` is honored), with `Authorization: Bearer` + `originator: Codex Desktop` headers — no streaming required.

## License

MIT
