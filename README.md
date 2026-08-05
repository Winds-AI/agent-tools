# Winds AI Pi Extensions

A small collection of extensions for [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Extensions

### Pi Sticky

Keeps the chat input and footer pinned while chat history scrolls. This fork retains mouse scrolling and selection but intentionally registers **no keyboard scrolling shortcuts**, leaving every keyboard shortcut available to Pi and other extensions.

Pi Sticky is based on [`@burneikis/pi-sticky`](https://github.com/burneikis/pi-sticky). Its original license and attribution are preserved in [`extensions/pi-sticky/LICENSE`](extensions/pi-sticky/LICENSE).

### User Message Navigation

Adds direct session-tree navigation through user messages:

- `Cmd+Up`: previous user message
- `Cmd+Down`: next user message
- Uses Pi's native tree navigation with `summarize: false`
- Restores the selected message in the editor for revision
- Does not create an empty branch or trigger a model turn
- Protects non-empty modified drafts from accidental replacement

## Install

```bash
pi install git:github.com/Winds-AI/pi-extensions
```

Restart Pi after installation. Both extensions are enabled by default and can be toggled independently with `pi config`.

### Terminal setup for Cmd+Arrow

The terminal must forward macOS Command-arrow combinations. For Ghostty and cmux, add this to `~/.config/ghostty/config`:

```ini
keybind = super+arrow_up=csi:1;9A
keybind = super+arrow_down=csi:1;9B
```

Then reload the terminal configuration or restart the terminal.

## Package layout

```text
extensions/
├── pi-sticky/
└── user-message-navigation/
```

The root `package.json` is a Pi package manifest and loads both extensions in the required order.

## License

The repository's original work is MIT licensed. Pi Sticky retains its upstream license and third-party attribution in its extension directory.
