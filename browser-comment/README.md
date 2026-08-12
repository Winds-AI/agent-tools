# Browser Comment

`/comment` opens the last completed assistant reply in your browser so you can
attach comments to selected text or add an overall note. The reply is rendered
as centered markdown via the vendored `marked` library.

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
- Click a highlighted comment to view or delete it.
- Selections can span paragraphs or list items without changing their document structure.
- Raw HTML in the markdown is displayed as escaped text instead of being executed.
- Submit and Cancel close the tab when the browser permits it.

## Design

| Concern | Approach |
|---|---|
| Pi integration | `registerCommand()` and `ctx.ui.setEditorText()` |
| Content source | Last completed assistant text from `ctx.sessionManager.getBranch()` |
| Isolation | One loopback server per review on an ephemeral port (`listen(0)`) — no port pool |
| Lifecycle | Server starts on `/comment` and closes on submit, cancel, timeout, replacement, or `session_shutdown` |
| Browser launch | Platform command spawned without a shell |
| Rendering | Vendored `marked` 18.0.5 inlined into a single HTML page with inline CSS/JS |
| Markdown handoff | Markdown is JSON-inlined into the page server-side (no `/data` round-trip) |

## Layout

```text
browser-comment/
  index.ts              # command, branch walk, review server, formatting
  web/
    index.html          # single page: inline CSS + JS + marked
    vendor/marked.min.js
  scripts/
    smoke-ts.ts
```

## Smoke test

```bash
cd extensions/browser-comment
npx --yes tsx scripts/smoke-ts.ts
```
