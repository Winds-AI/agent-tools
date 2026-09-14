# Verification

Verified 2026-09-14 on macOS (Apple Silicon, Darwin 25) with Pi 0.85.1, Node
22.23.1, Python 3.14.7, PyAV/ONNX Runtime from `audio/requirements.txt`, Google
Chrome (headless), against the Codex realtime endpoint `gpt-live-1-codex`.

## Automated checks

- `npm test` — 19 passed. Covers credential resolution (Pi first, then Codex;
  expiry, `account_id` spelling, missing login), call creation (identity
  headers, session shape, seeded history, credential rejection, malformed SDP),
  transcript handling (deltas, grouping, restored history, chunk limits), and
  session lifecycle (arm → wake → live, delegation handoff, spoken result,
  quiet auto-close with late re-announce, mute that keeps results audible, login
  failure).
- `npm run test:audio` — 2 passed. The worker reports `ready`, never flags
  synthetic silence as speech, and detects a macOS `say` utterance through the
  Silero VAD including release hysteresis.
- `npm run check` — syntax checks for every module.

## Media pipeline

Chromium takes ~1.1 s to launch and open the microphone; the page starts
capture before building the audio graph so that gap is as small as possible, and
the status shows `warming up…` until it is live. While a session opens, the
worklet holds up to 10 s of microphone audio, trims leading near-silence
(300 ms of context kept) and caps the replay at 3 s.

Catch-up is pitch-preserving: grains start every 15 ms but are laid down every
10 ms, so held speech replays at 1.5× at its original pitch, and each grain is
phase-aligned to the previous one (WSOLA) so overlapping windows add
constructively. Offline, a synthesized 440 Hz tone at 0.5 amplitude through the
worklet reconstructs at amplitude 0.500 with −31 dB residual. Live, the smoke
run held 1744 ms, consumed 5221 ms of audio into 3509 ms of output (exactly
1.5×), and transcribed the delegated request verbatim. At most ~32 ms is
discarded when switching to live, and the metered session closes whenever
speech stops.

## Muted announcements

When no session is open — quiet, or the microphone is muted — a finished Pi
answer reopens a short session and is sent as `session.context.append`
(speakable), and the microphone stays muted for that announcement. Outgoing
data-channel events are queued until the `oai-events` channel opens, so an
announcement sent immediately after connecting is delivered rather than
dropped.

Verified live through the real modules: start → wake → live → `/m` mute →
Pi result → the assistant spoke "The build passed, with three warnings."

## Delegations and session boundaries

A delegation belongs to the session that created it. If Pi's answer arrives after
that session closed (quiet, or the user kept talking into a new session), the
result is spoken through `session.context.append` in the session that is open
now; the delegation channel is only used while its own session is still live.
Closing a session retires its delegation and session id, and a regression test
covers a result that lands in a later session.

## Live end-to-end smoke (`npm run smoke`)

Runs the real modules against the real endpoint: Pi's Codex credential, the
headless Chromium media host, VAD wake, WebRTC call creation, delegation to the
client, and the spoken result. A synthesized request ("Please inspect this
project and tell me how many source files it contains. Just say the number.")
travels page → 24 kHz PCM → VAD → session → GPT-Live, which delegates it; the
client answers with `delegation.context.append` and the assistant speaks
"forty-two". Observed: `# auth: pi`, VAD `speech`, call connected, `# buffered`,
`# catchup`, `# delegation`, `# accuracy: verbatim`, `# spoken: forty-two`,
`SMOKE PASS`.

## Not covered by automation

- Audible speaker output in headless Chromium: the audio track and transcripts
  are verified, not sound.
- A full interactive TUI session with a real headset — the unit tests fake the
  media layer, and the smoke test injects synthesized speech over the real media
  host.
- Long-running drift: the Codex realtime surface is private and may change;
  failures surface as errors.
