# Gemini Video

Minimal video understanding for pi or any agent/harness. Give it a video and
a question; get a text answer with relevant timestamps.

Use it to understand screen recordings, find specific events, explain actions,
or extract steps from a tutorial. Uses **Gemini 3.8 Flash** with agentic video
processing, which explores the video based on the question. The model is fixed;
there are no model overrides or fallbacks.

## Usage

Requires Node.js 22+ and a [Gemini API key](https://aistudio.google.com/api-keys).
No packages to install.

```bash
node gemini-video.mjs /path/to/recording.mp4 "What action caused the error?"
node gemini-video.mjs /path/to/demo.webm "What changes after clicking Save?"
node gemini-video.mjs "https://www.youtube.com/watch?v=VIDEO_ID" "Extract the setup steps."
node gemini-video.mjs /path/to/lecture.mp4 "List the main arguments." > notes.txt
node gemini-video.mjs -h
```

Exactly one local video or public YouTube URL, followed by one required prompt.
Pass the actual question as the prompt; it controls scope, detail, and format.
Apart from `-h` / `--help`, there are no flags.

Output: the complete answer is printed to stdout as one block. Errors go to
stderr with exit code 1. Each invocation is independent.

## Authentication

Set `GEMINI_API_KEY`, or save the key in `~/.config/gemini-video/api-key` with
permissions `600`. The environment variable takes precedence. Keep the key
outside the repository.

A free-tier project uses its available free quota; a billed project follows
its API pricing. Check your project's limits in
[AI Studio](https://aistudio.google.com/rate-limit).

## How it works

Uploads local videos through Gemini Files, waits until ready, and sends the
video and prompt to the Interactions API with `processing: "agentic"` and
`store: false`. The only system instruction is:

> Include timestamps for the moments supporting your answer.

The tool deletes its upload after success or failure. Interrupted processes
or failed cleanup can leave files until Gemini's automatic 48-hour expiry.
Requests time out after ten minutes. There are no automatic retries.

Local formats: MP4, MOV, WebM, AVI, MPEG, M4V, WMV; maximum 2 GB per file.
YouTube videos must be public. Agentic processing is not always faster on
short clips. Google's API data-use policies still apply.

## License

MIT
