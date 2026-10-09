# Codex Image

Image generation and editing for any agent/harness, using your existing Codex
login and subscription quota. No extra API keys.

Text → image, or text + reference images → image (edit, new pose, restyle,
combine). One PNG per call.

## Usage

Requires Node.js 22+ and `codex login`.

```bash
node codex-image.mjs "a tiny paper robot on a desk"
node codex-image.mjs "same robot, now waving" --image robot.png
node codex-image.mjs "the robot from image 1 holding the cup from image 2" --image robot.png --image cup.jpg
node codex-image.mjs "a tiny paper robot on a desk" --quality low --out assets/robot.png
```

| Argument | Meaning |
|---|---|
| `<prompt>` | Required, exactly one; any non-flag argument. Multi-line is fine when quoted |
| `--image <path>` | Reference image (PNG, JPEG or WebP, up to 50 MB), repeatable; "image 1", "image 2"… in the order given |
| `--quality <auto\|low\|medium\|high>` | Default `auto` |
| `--out <path>` | Output path (folders created, file replaced). Default: a temp file |

Prints only the PNG's absolute path on stdout. Errors: one `Error: ...` line on
stderr; exit `2` for bad arguments, `1` otherwise.

Size and aspect ratio are chosen by the model; ask for them in the prompt. For
alpha, ask for a "transparent background" in the prompt.

## How it works

Calls `https://chatgpt.com/backend-api/codex/images/generations`, or
`.../images/edits` when `--image` is given (references sent inline as data
URLs), with model `gpt-image-2`, the request shape Codex uses. Auth comes from
`~/.codex/auth.json` (`$CODEX_HOME` honored). No paid OpenAI API fallback.

## License

MIT
