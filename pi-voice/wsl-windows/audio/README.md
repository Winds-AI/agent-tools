The local worker reads JSON lines from stdin and writes JSON lines to stdout. Audio is base64 PCM, 24 kHz, signed 16-bit little endian, mono, in 20 ms frames. It never makes network requests.

- `input`: detect speech on original audio and maintain a 300 ms pre-roll; emit activity/wake.
- `start`: stream held audio through a persistent pitch-preserving tempo filter.
- `pull`: return at most one 20 ms output frame. The caller paces requests at real time and supplies a `stream` generation echoed in the response, so late output from a closed stream can be ignored.
- `sleep`: return to local detection and retain pre-roll; drop the completed stream's filter.
- EOF or termination: release all state. No audio is saved.

Catch-up consumes queued input at 1.5× until fewer than 160 ms remain, then changes the same filter to 1×. Slow downstream processing fails at 15 seconds of queued original audio instead of losing speech. VAD confirms two positive 32 ms frames at probability ≥0.5 and releases after ten frames below 0.35. Pi's separate idle timer uses the original capture clock, not compressed pauses.

`silero_vad.onnx` is the Silero Team's MIT-licensed model. License: SILERO-LICENSE.
Source: https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx
SHA-256: 1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3
