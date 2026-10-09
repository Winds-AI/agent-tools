# Gemini Video

Video understanding for any agent/harness: a local video and a question in, a
text answer with timestamps out. Uses Gemini 3.8 Flash through OpenRouter with
agentic video processing, where the model navigates the timeline and loads only
the frames, audio and transcript the question needs.

## Usage

Requires Node.js 22+, an OpenRouter API key, and `ffmpeg` for videos that need
converting or shrinking.

```bash
node gemini-video.mjs /path/to/recording.mp4 "What action caused the error?"
node gemini-video.mjs /path/to/demo.mov "List each scene change with its timestamp."
```

Exactly one local video and one question; no flags. The answer goes to stdout;
errors go to stderr with exit code 1.

Set `OPENROUTER_API_KEY`, or save the key in
`~/.config/gemini-video/openrouter-api-key` (mode `600`). The environment
variable wins.

## Behavior

- MP4, M4V, MOV, WebM and MPEG are sent as-is; AVI, WMV, MKV, FLV and 3GP are
  converted to MP4.
- OpenRouter's Gemini endpoint rejects requests over 20 MB, so videos over
  14 MB are re-encoded to fit (5 fps, up to 720p, mono audio). If a video
  cannot be made small enough, the error asks you to trim or split it.
- Agentic is only available through OpenRouter's Responses API, which this
  tool uses. Broad questions over a whole video can end without an answer; the
  tool then retries once with static processing (one pass at 1 frame per
  second) and says so on stderr. Rate limits and server errors are retried, up
  to 3 attempts in total.

## License

MIT
