# Browser Comment

`/comment` opens the last completed assistant reply in your browser so you can attach comments to selected text or add an overall note. Fenced `mermaid` code blocks render as diagrams in the review page.

## Install

Clone the collection, then install this package by local path:

```bash
git clone https://github.com/Winds-AI/pi-extensions.git
pi install ./pi-extensions/browser-comment
```

Restart Pi after installation.

## Usage

1. Wait for the assistant response to finish.
2. Run `/comment`.
3. Select text in the browser and add comments, optionally adding an overall note.
4. Submit. The feedback is loaded into Pi's editor for review before sending.

Example editor output:

```md
## Comments

### 1
Regarding:
> selected text

Comment: your comment

## Overall note

general feedback
```

## Browser controls

- `Enter` adds a selection comment; `Shift+Enter` inserts a newline.
- `Cmd/Ctrl+Enter` submits.
- `Escape` closes the active popup.
- Selections can span paragraphs or list items without changing their document structure.
- `Tab` stays within an open popup and traverses existing comment marks.
- Comment textareas can be resized vertically.
- Fenced `html` blocks have a top-right preview toggle. Previews run in a sandboxed, script-free iframe.
- Raw HTML outside fenced code blocks is displayed as text instead of being executed.
- Submit and Cancel close the tab when the browser permits it and restore the previously focused macOS application.

## Design

| Concern | Approach |
|---|---|
| Pi integration | `registerCommand()` and `ctx.ui.setEditorText()` |
| Content source | Last completed assistant text from `ctx.sessionManager.getBranch()` |
| Isolation | Loopback server with `/s/<sessionId>` routes |
| Ports | Fixed pool `18760–18769` |
| Lifecycle | Server starts on `/comment` and closes on submit, cancel, timeout, replacement, or `session_shutdown` |
| Browser launch | Platform command spawned without a shell |
| Rendering | Vendored `marked` 18.0.5 and Mermaid 11.16.0 with local CSS and JavaScript; Mermaid uses strict security mode |
| macOS focus | Best-effort capture and restore via `osascript` |

## Layout

```text
browser-comment/
  index.ts
  lib/
    focus-restore.ts
    format-comments.ts
    last-assistant.ts
    open-browser.ts
    review-manager.ts
    types.ts
  web/
    index.html
    styles.css
    app.js
    vendor/marked.min.js
    vendor/mermaid.min.js
  scripts/
    smoke-ts.ts
```

## Smoke test

```bash
cd extensions/browser-comment
npx --yes tsx scripts/smoke-ts.ts
```
