The local worker reads JSON lines from stdin and writes JSON lines to stdout.
Audio is base64 PCM, 24 kHz, signed 16-bit little endian, mono, in exactly
20 ms frames (960 bytes). It never makes network requests.

- `input`: run Silero VAD on one frame. When the speech state changes, emit
  `{"type": "activity", "speech": true|false}`. Eight consecutive positive
  32 ms windows (256 ms) at probability ≥ 0.5 start speech; ten windows below
  0.35 end it. Quieter than -50 dBFS never counts as speech.
- EOF or termination: release all state. No audio is saved, logged, or stashed.

The extension decides what to do with speech edges: a rising edge while armed
opens the GPT-Live session, and silence plus inactivity closes it again. The
page (not this worker) holds the short pre-roll buffer that keeps speech which
starts just before the session connects.

`silero_vad.onnx` is the Silero Team's MIT-licensed model. License:
SILERO-LICENSE. SHA-256:
`1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`.
Source: https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx
