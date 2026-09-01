# Pi Sticky (keyboard-free fork)

Keeps Pi's chat input and footer pinned to the bottom while chat history
scrolls, so you can keep typing while reading back through the transcript.

## Prefer the built-in fullscreen mode first

Recent Pi versions ship a native **fullscreen TUI mode** that solves the same
problem without an extension: the transcript scrolls inside the terminal
viewport while the editor, widgets, and footer stay fixed at the bottom. Try
it before installing this extension:

- Run `pi --tui-mode fullscreen`, or
- Set it as the default in `/settings` → `tuiMode` → `fullscreen`

Mouse wheel/trackpad scrolls the transcript, keyboard viewport keys stay
available, and selection/copy behavior is handled natively (see
`fullscreenCopyOnSelect` in Pi's settings). If fullscreen mode works for you,
you don't need pi-sticky.

This extension remains for **regular TUI mode**, where it implements the same
idea by intercepting terminal writes and maintaining a fixed scroll region
(there were trade-offs: it is monkey-patching internals, and selection copy
needed special handling).

## What this fork preserves

- Mouse scrolling
- Mouse selection and copy-on-release
- Pinned editor, widgets, status, and footer

It intentionally removes all keyboard scrolling and shortcut-matching
functionality so keyboard input remains available to Pi and other extensions.

## Install

```bash
git clone https://github.com/Winds-AI/agent-tools.git
cd agent-tools
pi install ./pi/pi-extensions/pi-sticky
```

Restart Pi after installation.

Based on [`@burneikis/pi-sticky`](https://github.com/burneikis/pi-sticky).
See [LICENSE](LICENSE) for upstream and third-party attribution.
