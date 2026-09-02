# User Message Navigation

Navigate Pi's session tree through user messages — no `/tree`, no arrow-key
walking through tool-call events, no branch summaries.

- **Cmd+Up**: go to the previous user message
- **Cmd+Down**: go to the next user message
- No branch summary is generated
- No model turn is triggered
- The target user message is restored into the editor (native `/tree`
  semantics); submitting it starts a new branch from that point

After navigating up, going down follows the **latest branch** — the tree walk
always follows the child with the newest timestamp at each fork, so you land
back on the most recent line of work even in heavily branched sessions. Pi's
built-in entry timestamps are used; nothing extra is persisted.

## Keys

Both **Cmd+Up/Down** (`super+up`/`super+down`) and **Ctrl+Up/Down** move along
the session tree, registered through `pi.registerShortcut` so they work in
regular and fullscreen TUI modes and with editor extensions. Ctrl+Up/Down
overrides pi's fullscreen "jump between marked messages" transcript keys —
transcript scrolling stays available via mouse wheel/trackpad.

## Install

```bash
git clone https://github.com/Winds-AI/agent-tools.git
cd agent-tools
pi install ./pi/pi-extensions/pi-user-message-navigation
```

Restart Pi after installation.

## License

MIT
