---
name: pi-colleagues
description: Spawn and manage colleague Pi agents (researcher, implementer, verifier, critic, explorer — same kind of agent as you, different job) inside tmux. Use when work should be delegated to a separate agent you can watch and interact with, or when running several agents in parallel (sub-agents / fleet).
---

# Colleagues: Pi agents in tmux

A colleague is a full Pi agent running in its own tmux session — same kind of agent as you, different job. You are the orchestrator: you decide who does what, hand over context, steer, collect results, and carry anything one colleague produces to another. Colleagues never talk to each other; you are their only channel.

One name identifies everything — the tmux session, the Pi session ID, the display name:

    <task>-<n>-<YYYYMMDD-HHMM>        e.g. research-auth-1-202609021830

`[A-Za-z0-9._-]` only, starts/ends alphanumeric. Increment `<n>` per colleague on the same task. Before launching: `tmux has-session -t =$NAME` — empty output means the name is free.

## Launch

```bash
tmux new-session -d -s "$NAME" -c "$CWD" -x 220 -y 50 \
  "pi --session-id '$NAME' --name '$NAME' --session-dir $SESSIONS_DIR [--model $PROVIDER/$MODEL] [--thinking $LEVEL] '$TASK'"
```

- `$SESSIONS_DIR` = `/home/meet/.pi/agent/subagent-sessions` — always pass it: isolates colleague sessions from human ones and makes them listable
- `-c "$CWD"` = the colleague's working directory; default yours (`$PWD`)
- `$TASK` = the task brief as the final positional argument — pi submits it at startup and the colleague starts working immediately
- `-x 220 -y 50` pre-sizes the pane (detached default 80×24 is cramped; attaching resizes to the human's terminal)
- Never pipe or redirect pi's output — the TUI needs a TTY and hangs otherwise
- Keystrokes sent before pi paints (pane footer shows the session name) are lost — hand over the task via `$TASK`, not launch-time `send-keys`

| Choice | Default | How |
|---|---|---|
| model | Pi's default | `--model provider/id` — pick via `pi --list-models` |
| thinking | Pi's default | `--thinking off\|minimal\|low\|medium\|high\|xhigh\|max`, or `--model provider/id:high` |
| working dir | your `$PWD` | `-c` in the tmux command |
| context | fresh | fresh unless you deliberately fork |

If subagent needs to know what you did then either give it needed context or point it to your session file as per need.

## Operations

| Operation | Command |
|---|---|
| Steer mid-run | `tmux send-keys -l -t "$NAME" "$MESSAGE"; tmux send-keys -t "$NAME" Enter` — delivered after the current tool batch (native steering); if idle it's just a new prompt |
| Stop current work | `tmux send-keys -t "$NAME" Escape` — generation aborts, process stays alive |
| Close | `tmux send-keys -t "$NAME" C-c C-c` — clean exit, session persists; the two presses must land <1s apart, else `C-d C-d`, else hard kill |
| Hard kill | `tmux kill-session -t "$NAME"` |
| Watch | `tmux capture-pane -t "$NAME" -p \| tail -40` |
| Human attach | `tmux attach -t "$NAME"` — same live pane, type directly into the agent |
| Reopen later | `tmux new-session -d -s "$NAME" -x 220 -y 50 "pi --session '$NAME' --session-dir $SESSIONS_DIR"` |
| Fork a colleague | like the fork-launch above, but `--fork "$NAME"` — copies its session to a new independent one; the original keeps running untouched, then drive the branches separately |

**Idle check:** tail `$SESSIONS_DIR/*_$NAME.jsonl` (created on the first message — a fork's exists immediately; named `<timestamp>_$NAME.jsonl`). Last entry is a `message` with `role:assistant` and a terminal `stopReason` (`stop`/`toolUse`/`aborted`) → idle. `toolUse` + no growth → still working. `stopReason` sits near the end of the JSON line — grep the whole line, never a truncated prefix. Reading that JSONL is also how you collect a colleague's results without attaching.

## Fleet

Run any number in parallel — one tmux session per colleague.

- Who's running: `tmux ls`
- Everyone ever created: `ls -t $SESSIONS_DIR/*.jsonl` (display name is inside in a `session_info` line)

## Model discovery

```bash
pi --list-models [search]     # columns: provider, model, context, max-out, thinking, images
```

`provider/model` is the launch slug. `thinking yes` = reasoning-capable (any level); `images yes` = image input. Deeper: `$PI_DOCS/models.md`.

## Gotchas

- One colleague, one pane — session JSONLs have no locking; opening the same session twice diverges the trees.
- `$PI_SESSION_FILE`, `$PI_SESSION_ID`, `$PI_PROVIDER`, `$PI_MODEL`, `$PI_REASONING_LEVEL` describe you when you run under Pi.

## Deeper reference

CLI flags `$PI_DOCS/usage.md` · sessions/forks `$PI_DOCS/sessions.md` · JSONL format `$PI_DOCS/session-format.md`
(`$PI_DOCS` = `/home/meet/.nvm/versions/node/v24.18.1/lib/node_modules/@earendil-works/pi-coding-agent/docs`)

## Model selection

Default model: glm 5.3 flash max through command code provider.
