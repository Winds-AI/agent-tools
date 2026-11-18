# open-typeless

Handy transcription hook: rewrites text with Groq and returns the original if the rewrite fails the checks. The source and prompt are the Mac version; Windows uses `%APPDATA%\\open-typeless` for its data. Windows build and full Handy integration are not yet verified.

## Windows handoff

- Build with Rust (`cargo test`, then `cargo build --release`), copy the Windows executable to Handy data directory as `hooks\\transcription` (no extension); confirm Handy 0.10.1 can launch it.
- Copy `config.example.json` to `%APPDATA%\\open-typeless\\config.json`. This is required: without it the built-in defaults include a second model. It selects Qwen only and no vocabulary.
- Place the existing Groq key privately in `%APPDATA%\\open-typeless\\api-key` with appropriate Windows permissions. The key is not in this repository.
- In Handy, select a local speech model. Verify Qwen response, raw-text fallback and real dictation through to paste.

Text is sent to Groq; transcript and output are recorded in local history by default.
