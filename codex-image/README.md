# Codex Image

Minimal image generation for pi (or any agent/harness) using your existing
Codex login, authentication, and subscription quota. No extra API keys or
accounts.

Accepts one prompt, generates one image through ChatGPT's Codex image endpoint,
and returns the path to a temporary PNG file.

## Usage

Requires Node.js 22+ and an authenticated Codex CLI (`codex login`).

```bash
node codex-image.mjs "a tiny paper robot on a desk"
node codex-image.mjs "a tiny paper robot on a desk" --quality high
node codex-image.mjs --quality=low "a tiny paper robot on a desk"
node codex-image.mjs -h
```

That is the entire surface. Exactly one positional argument (the prompt) and
at most one option:

| Argument | Meaning |
|---|---|
| `<prompt>` (positional, required, exactly one) | Image-generation prompt |
| `--quality <auto\|low\|medium\|high>` (optional) | Generation quality; default: `auto` |
| `-h`, `--help` | Print usage and exit |

Anything else is rejected with an error. `CODEX_HOME` is honored for the auth
file location.

Output: the generated image is written to a temporary PNG file and its path is
printed to stdout — e.g. `/tmp/codex-image-<uuid>.png`. Nothing else is printed
on success; errors go to stderr with exit code 1.

## How it works

The script calls `POST
https://chatgpt.com/backend-api/codex/images/generations` with the same
`gpt-image-2` model and automatic size/background settings used by Codex.
Authentication comes from `~/.codex/auth.json` (`$CODEX_HOME` is honored) via
`Authorization: Bearer` + `ChatGPT-Account-Id` headers, with `originator:
codex_cli_rs`.

The endpoint does not reliably honor explicit dimensions, aspect ratios, or
output formats, so the tool exposes only the quality setting that is supported.
There is no paid OpenAI API fallback.

## License

MIT
