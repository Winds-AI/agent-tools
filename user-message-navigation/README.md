# User Message Navigation

Navigate Pi's session tree directly through prior user messages.

- `Cmd+Up`: previous user message
- `Cmd+Down`: next user message
- No branch summary
- No automatic model turn
- Modified non-empty drafts are protected

The selected user message is moved into Pi's editor, matching native `/tree` semantics.

## Install

Clone the collection, then install this package by local path:

```bash
git clone https://github.com/Winds-AI/pi-extensions.git
pi install ./pi-extensions/user-message-navigation
```

Restart Pi after installation. Command-arrow forwarding may also need to be configured in the terminal.
