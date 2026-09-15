# Verification

Unified implementation status: the former `mac/` tree is the base; the former
`wsl-windows/` transport (platform API key, WebSocket, WSLg PulseAudio) was
removed by decision — both platforms use the Codex subscription endpoint.

## Automated checks

- `npm test` — unit tests, no network: credential resolution (Pi first, then
  Codex; expiry, `account_id` spelling, missing login), call creation (identity
  headers, session shape, seeded history, credential rejection, malformed SDP),
  transcript handling (deltas, grouping, restored history, chunk limits),
  session lifecycle (arm → wake → live, delegation handoff, spoken result,
  quiet auto-close with late re-announce, mute that keeps results audible,
  mute during warmup, login failure, VAD level + catch-up telemetry), helper
  portability (Windows browser discovery for WSL, %TEMP% profile, overflow
  notice, Edge "completed" state).
- `npm run test:audio` — worker tests: pre-roll retention, close-boundary
  onset, backlog draining, 1.5×/1× filter switching without pitch shift,
  scheduling-stall recovery, bounded failure, real Silero inference on silence,
  tuned hysteresis constants.
- `npm run check` — syntax checks for every module.

## Media pipeline

The browser takes ~1.1 s to launch and open the microphone; the page starts
capture before building the audio graph so that gap is as small as possible,
and the status shows `warming up…` until it is live. While a session opens,
the worklet holds microphone audio, trims leading near-silence (300 ms of
context kept) and caps the connect replay at 10 s (a warning is surfaced if
the cap is hit, replacing the old silent 3 s drop).

Catch-up is pitch-preserving: grains start every 15 ms but are laid down every
10 ms, so held speech replays at 1.5× at its original pitch, and each grain is
phase-aligned to the previous one (WSOLA) so overlapping windows add
constructively. The macOS smoke run held 1744 ms, consumed 5221 ms of audio
into 3509 ms of output (exactly 1.5×), and transcribed the delegated request
verbatim. At most ~32 ms is discarded when switching to live.

## WSL specifics (verified live)

Inside WSL the helper launches the Windows Chrome (`/mnt/c/Program Files/...`)
so the microphone and speakers are native Windows devices. The browser profile
is created under the Windows `%TEMP%` (resolved through `cmd.exe` +
`wslpath`) because a Windows process cannot write into a WSL path, and it
reaches the helper's loopback HTTP server through WSL's localhost forwarding.
WSL detection uses `WSL_INTEROP`/`WSL_DISTRO_NAME` and `/proc/version`
(binfmt_misc `WSLInterop` alone is unreliable — some systems only have
`WSLInterop-late`).

Live smoke from WSL passed against the real endpoint with the Pi-stored Codex
credential: `# auth: pi`, VAD speech on the synthesized request, call
connected (`rtc_u32_…`), 4432 ms buffered while connecting, catch-up replayed
6877 ms of audio into 4613 ms (exactly 1.5×), delegation observed, answer
spoken ("forty-two"), `SMOKE PASS`. Transcription of the *replayed* segment
was 53% word-accurate for the robotic Windows SAPI voice (the macOS run with
`say` transcribed verbatim); if accuracy is low with real speech too, compare
the replay rate or inspect the WSOLA alignment window first.

## Muted announcements

When no session is open — quiet, or the microphone is muted — a finished Pi
answer reopens a short session and is sent as `session.context.append`
(speakable), and the microphone stays muted for that announcement. Outgoing
data-channel events are queued until the `oai-events` channel opens, so an
announcement sent immediately after connecting is delivered rather than
dropped.

Verified live on macOS through the real modules: start → wake → live → `/m`
mute → Pi result → the assistant spoke "The build passed, with three
warnings."

## Delegations and session boundaries

A delegation belongs to the session that created it. If Pi's answer arrives after
that session closed (quiet, or the user kept talking into a new session), the
result is spoken through `session.context.append` in the session that is open
now; the delegation channel is only used while its own session is still live.
Closing a session retires its delegation and session id, and a regression test
covers a result that lands in a later session.

## Live end-to-end smoke (`npm run smoke`)

Runs the real modules against the real endpoint: Pi's Codex credential, the
headless browser media host, VAD wake, WebRTC call creation, delegation to the
client, and the spoken result. On macOS it synthesizes the request with `say`
+ `afconvert`; on WSL there is no bundled TTS, so speak into the microphone
after starting it. The smoke script itself still uses the macOS `say` path and
is intended for the mac until a WSL equivalent is needed.

Observed on macOS: `# auth: pi`, VAD `speech`, call connected, `# buffered`,
`# catchup`, `# delegation`, `# accuracy: verbatim`, `# spoken: forty-two`,
`SMOKE PASS`.

## Not covered by automation

- A full interactive TUI session with a real headset — the unit tests fake the
  media layer, and the smoke test injects synthesized speech (macOS `say`,
  Windows SAPI). On WSL the TUI path was additionally checked with the real
  Pi: the extension loads, `/m` arms, the status meter tracks live microphone
  audio (`listening · -53dB · vad 0.00`), and a real headset conversation
  remains the acceptance test.
- Long-running drift: the Codex realtime surface is private and may change;
  failures surface as errors.
