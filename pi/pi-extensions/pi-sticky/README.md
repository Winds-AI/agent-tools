# Pi Sticky (keyboard-free fork)

Keeps Pi's chat input and footer pinned to the bottom while chat history scrolls.

This local fork preserves:

- Mouse scrolling
- Mouse selection and copy-on-release
- Pinned editor, widgets, status, and footer

It intentionally removes all keyboard scrolling and shortcut-matching functionality so keyboard input remains available to Pi and other extensions.

## Install

Clone the collection, then install this package by local path:

```bash
pi install git:github.com/Winds-AI/agent-tools
```

To install only this extension from a local clone, use `pi install ./pi/pi-extensions/pi-sticky` from the repository root. Restart Pi after installation.

Based on [`@burneikis/pi-sticky`](https://github.com/burneikis/pi-sticky). See [LICENSE](LICENSE) for upstream and third-party attribution.
