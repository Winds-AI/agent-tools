# Codex Image

Minimal image generation and editing for pi (or any agent/harness) using your
existing Codex login, authentication, and subscription quota. No extra API keys
or accounts.

Built for agents: one command, two modes picked from the arguments, one PNG
path on stdout.

| Mode | Arguments | Endpoint |
|---|---|---|
| Text → image | a prompt | `images/generations` |
| Image + text → image | a prompt and one or more `--image` | `images/edits` |

A prompt is always required; the edits endpoint rejects requests without one.

## Usage

Requires Node.js 22+ and an authenticated Codex CLI (`codex login`).

```bash
# text -> image
node codex-image.mjs "a tiny paper robot on a desk"

# image + text -> image (edit, new pose, restyle, same character in a new scene)
node codex-image.mjs "same character, now waving, transparent background" --image robot.png

# several references, referred to as "image 1", "image 2" in the order given
node codex-image.mjs "the robot from image 1 holding the cup from image 2" --image robot.png --image cup.jpg

# choose the output file and quality
node codex-image.mjs "a tiny paper robot on a desk" --quality low --out assets/robot.png
node codex-image.mjs -h
```

| Argument | Meaning |
|---|---|
| `<prompt>` (positional, required, exactly one) | What to generate, or how to change the references |
| `--image <path>` (repeatable) | Reference image: PNG, JPEG or WebP, up to 32 MB each |
| `--quality <auto\|low\|medium\|high>` | Generation quality; default `auto`. `low` is fastest |
| `--out <path>` | Output PNG path; parent folders are created and an existing file is replaced. Default: a new temp file |
| `-h`, `--help` | Print usage and exit |

`--flag value` and `--flag=value` both work. Anything else is rejected.
`CODEX_HOME` is honored for the auth file location.

Output: only the absolute path of the PNG is printed to stdout, e.g.
`/tmp/codex-image-<uuid>.png`. Errors are a single `Error: ...` line on stderr,
with exit code `2` for bad arguments (missing file, unsupported type, unknown
flag) and `1` for everything else (auth, rate limit, API errors).

## Tips for agents

- Each call returns one image and usually takes 15–60 seconds; run independent
  calls in parallel.
- Size and aspect ratio are chosen by the model. Describe the shape in the
  prompt ("wide 16:9 landscape", "tall portrait").
- Say "transparent background" in the prompt to get a PNG with alpha; the
  model does not keep a reference's transparency unless asked.
- To keep a character consistent across many images, generate it once, then
  pass that image as `--image` with a prompt such as "same character, now …".
  Several poses in one call (a sprite sheet) also come out consistent.

## How it works

Without references the script calls `POST
https://chatgpt.com/backend-api/codex/images/generations`; with references it
calls `POST https://chatgpt.com/backend-api/codex/images/edits`, sending each
image inline as a base64 data URL, the same request shape Codex uses. Both use
the `gpt-image-2` model with automatic size and background. Authentication
comes from `~/.codex/auth.json` (`$CODEX_HOME` is honored) via `Authorization:
Bearer` + `ChatGPT-Account-Id` headers, with `originator: codex_cli_rs`.

The endpoints do not reliably honor explicit dimensions, aspect ratios,
or output formats, so the tool exposes only the quality setting. There is no
paid OpenAI API fallback.

## License

MIT
