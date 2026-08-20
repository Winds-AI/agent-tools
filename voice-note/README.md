# Voice Note

Speak through an idea while a Pi agent maintains a clean, structured Markdown
document in real time. Audio and transcription stay on the machine.

## Architecture

```text
browser microphone -> 16 kHz AudioWorklet PCM -> local transcribe.cpp
-> append-only transcript -> Pi updates the working document -> cursor commit
```

V1 deliberately supports two simple profiles instead of trying to choose
the perfect model for every possible computer:

- Apple Silicon Mac: Whisper large-v3-turbo Q8_0 through Metal.
- Windows/Linux/WSL or Intel Mac: Whisper small.en Q8_0 through Vulkan when
  available, otherwise CPU.

## Install

Clone this repository and make the skill discoverable:

```bash
ln -s /absolute/path/to/pi-extensions/voice-note ~/.agents/skills/voice-note
```

On native Windows, copy the `voice-note` directory to
`%USERPROFILE%\.agents\skills\voice-note` instead.

Then tell Pi: `start a voice note`. On first use, the skill explains the chosen
profile and model download before running setup. During a session, use the
browser's **Mute** button when conversations should not enter the note. Say
`end voice note` to finish.

## V1 boundary

No native microphone integration, Docker, cloud ASR, VAD, clipboard behavior,
model catalog, or universal hardware benchmarker. The browser owns capture;
the local runtime owns ordered PCM and transcription; the agent owns meaning.

## License

MIT
