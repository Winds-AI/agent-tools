# User Message Navigation

Navigate Pi's session tree through user messages — no `/tree`, no arrow-key
walking through tool-call events, no branch summaries.

- **Cmd+Up**: go to the previous user message
- **Cmd+Down**: go to the next user message, then the conversation endpoint
  with an empty editor, ready for a new prompt
- No branch summary is generated
- No model turn is triggered
- The target user message is restored into the editor (native `/tree`
  semantics); submitting it starts a new branch from that point

After navigating up, going down follows the **latest branch** — the tree walk
always follows the child with the newest timestamp at each fork, so you land
back on the most recent line of work even in heavily branched sessions. Pi's
built-in entry timestamps are used; nothing extra is persisted.

Navigation stops at the first prompt in the older direction and the branch's
final non-prompt entry in the newer direction. If the branch ends with a user
or custom message, there is no empty-editor endpoint: navigation stops at
the last user prompt. Custom messages are not navigation targets.

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

## Known limitations

- On Pi 0.85.1, `/reload` resets the in-memory fullscreen keybinding override.
  Quit and resume with `pi -c` instead; a fresh startup reapplies it without
  writing a keybindings file.
- If navigation is cancelled or fails after clearing unchanged recalled text,
  that text is not restored to the editor. The saved session message remains
  intact. Unsent drafts block navigation unless they match the recalled or
  target prompt.
- The terminal must forward the shortcuts to Pi. Terminal-level bindings
  (such as Warp's block navigation) may need to be unbound separately.

## License

MIT
