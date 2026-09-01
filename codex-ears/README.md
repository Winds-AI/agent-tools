# Codex Ears

Minimal voice transcription for pi (or any agent/harness) using your existing
Codex login, authentication, and subscription quota. No extra API keys or
accounts.

Accepts an audio file (any format the ChatGPT transcribe API supports, e.g.
WAV, MP3, M4A, WebM/Opus), sends it to ChatGPT's `backend-api/transcribe`
endpoint — the same one the ChatGPT desktop app and Codex CLI use for
dictation — and returns the transcript.

## Usage

Requires Node.js 22+, `curl`, and an authenticated Codex CLI (`codex login`).

```bash
node codex-ears.mjs /path/to/voice-note.wav
node codex-ears.mjs /path/to/voice-note.wav --lang en-US
```

The script writes the transcript to a temp text file and prints the file path.

## How it works

The ChatGPT desktop app sends recorded voice as a whole file (multipart) to
`POST https://chatgpt.com/backend-api/transcribe`, with model
`gpt-4o-mini-transcribe` and `response_format=json`. This script does exactly
that, using credentials from `~/.codex/auth.json` (`$CODEX_HOME` is honored),
with `Authorization: Bearer` + `originator: Codex Desktop` headers — no
streaming required.

`--lang <bcp-47>` asks the API to re-transcribe the audio in the given
language (the same `audio: { language }` field the ChatGPT client sends).

## Why curl

The transcribe endpoint fingerprints TLS clients: Node's `fetch`, `https`, and
`http2` all receive HTTP 403 from it (verified against a live login), while
every `curl` request passes regardless of user agent or headers. So the script
shells out to `curl` for this one request — curl ships everywhere Codex does.
The responses endpoint used by codex-eyes does not have this restriction.

## License

MIT
