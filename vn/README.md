# vn — live voice session

Minimal unix tool for agent-driven live dictation: the mic is transcribed **locally**
while the full audio is captured, and a coding agent consumes the new transcript lines
each cycle — structuring your thoughts into a document, answering questions over
material you're reading, or anything else you tell it. Works with any harness/agent
that can run shell commands (pi, Codex CLI, ...).

One job split in two: the tool only turns mic audio into timestamped lines in an
append-only transcript; the agent turns those deltas into whatever you actually want.

## Requirements

- macOS on Apple Silicon, `ffmpeg` and `python3` on PATH
- `mlx-whisper` importable by some python (model: `mlx-community/whisper-large-v3-turbo`,
  loaded from the local HF cache). If it's not in your default python, point
  `VN_MLX_PYTHON` at a python that has it.
- Optional: Raycast for the global mute hotkey

## Commands

```bash
vn devices          # numbered list of audio inputs
vn start <device>   # start capture (device index required; omitting prints the list)
vn stop             # stop; compresses voice.wav -> voice.flac; keeps the session dir
vn mute             # pause capture (bytes discarded — never written, never transcribed)
vn unmute           # resume
vn poll             # print only lines since last poll; exit 0 = new, 1 = none; never blocks
```

## Where files live

```
~/.local/share/vn/sessions/<YYYYMMDD-HHMMSS>/   one dir per session (kept forever)
    transcript.txt                              [MM:SS] lines; stamps = audio playhead
    voice.flac                                  full session audio (voice.wav until stop)
    meta.json                                   start, device, model, cwd of harness
    ffmpeg.log                                  capture diagnostics
~/.local/state/vn/current.json                  runtime only (pids, cursor, muted flag)
```

Muted spans are absent from both transcript and audio; stamps stay aligned to the
recording's playhead across mutes. Audio: 16kHz mono FLAC (~55 MB/hour).
Transcription runs in 10s chunks (~1s per chunk on an M-series Mac).

## Agent loop

See `skill/SKILL.md` for the full contract. The short version:

```bash
vn start 0          # once, in setup
vn poll             # loop: exit 0 -> integrate printed lines, poll again
                    #       exit 1 -> sleep 10, poll again
vn stop             # when the user asks to end
```

The agent never re-reads old lines — the tool tracks the cursor. Raw ASR errors are
the agent's problem on purpose: it resolves them against accumulated conversation
context ("trapey" → Strapi), which works better than any dictionary.

## Raycast global mute hotkey

1. Raycast Settings → Extensions → add this repo's `vn/raycast/` dir as a Script Command Directory
2. On "Toggle VN Mic" set a hotkey
3. Press it anywhere: toggles mute/unmute of the running session
