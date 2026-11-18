# Codex Dictation Archive

Keeps every dictation you make in the Codex desktop app, audio and transcript.

Codex keeps only the newest 20 dictations in `~/.codex/dictation-history` and
deletes older ones; there is no setting to change that. This script copies
each dictation into an archive folder that only grows.

## Setup

Requires Node.js 22+ on Windows or macOS.

```bash
git clone https://github.com/Winds-AI/agent-tools.git
node agent-tools/codex-dictation-archive/codex-dictation-archive.mjs install
```

That's it: it starts now and at every login, with no window.

- **Windows:** a Task Scheduler task named "Codex Dictation Archive".
- **macOS:** a LaunchAgent named `ai.winds.codex-dictation-archive`.

`install` copies the script to `%LOCALAPPDATA%\codex-dictation-archive` (Windows)
or `~/Library/Application Support/codex-dictation-archive` (macOS) and runs that
copy, so the clone can live anywhere or be deleted. Run `install` again after
updating the repo or moving Node.

| Command | Does |
|---|---|
| `install [--archive <dir>]` | Start at login and now |
| `uninstall` | Stop and remove the login item (the archive stays) |
| `--once [--archive <dir>]` | Archive what is there now, then exit |
| *(no command)* `[--archive <dir>]` | Run in the foreground |

The archive defaults to `~/dictation-archive`. `CODEX_HOME` is honored.

## Archive

```
~/dictation-archive/
  2026-11-17_23-58-01Z_5033d735/   start time (UTC) + start of the dictation id
    audio.webm                     Codex's audio chunks joined, byte for byte
    metadata.json                  Codex's own file: transcript in "text", status, durationMs, …
  archiver.log
```

Finished, cancelled and interrupted dictations are all kept. Nothing in the
archive is ever deleted. Joined audio is the same size as Codex's chunks.

The audio is WebM/Opus as recorded by the browser, which stores no total
length: it plays fully, but some players show no duration. To add it:
`ffmpeg -i audio.webm -c copy fixed.webm`.

## How it works

- Codex writes each dictation as a folder of 5-second `.chunk` files plus a
  `metadata.json` whose `status` leaves `recording` when you stop talking.
- A file watcher (`fs.watch`, built into Node) copies a dictation as soon as it
  finishes, typically within half a second.
- File events are best-effort on every OS, so a full scan also runs at startup
  and every 60 seconds. It catches anything missed, including dictations made
  while the script was not running (up to 20, Codex's limit).
- Codex writes the transcript after the recording finishes, and again on a
  retry; the archive copy is updated when that happens.
- Each new dictation is built in a temp folder and renamed into place, so a
  half-copied folder never looks finished. The Codex folder is only read.
