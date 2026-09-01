#!/usr/bin/env python3
"""pi-session-md — convert a pi session JSONL into a compact markdown transcript.

Usage: pi-session-md.py <session.jsonl>
Prints the path of the written .md file (in the OS temp dir) to stdout.

Written against the pi v0.84.4 session format (JSONL, v3 tree schema).
Preserves everything agent-relevant: user messages, assistant text + thinking,
tool calls with arguments, tool results, errors/aborts, durations, compaction
summaries, model/thinking changes, extension events. Drops only the JSON
envelope: usage/cost objects, ids/parentIds, signatures, and base64 image
payloads (images are counted, not dumped).

Entries are emitted in *branch order* (walked from the session's current leaf
to the root), not raw file order — appending after a /tree branch would
otherwise interleave abandoned-branch entries into the transcript.
"""
import json
import os
import re
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from os.path import join

MAX_INLINE = 2000  # tool results longer than this go into a <details> block


def clean(text):
    """Normalize Windows/old-Mac line endings and drop NUL decoding artifacts."""
    return str(text).replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")


def fmt_ts(ts):
    """Normalize a timestamp to ISO text. Handles ISO strings and epoch-ms ints."""
    if ts is None or ts == "":
        return ""
    if isinstance(ts, (int, float)):
        try:
            return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        except Exception:
            return str(ts)
    return str(ts)


def dur_ms(t0, t1):
    """Duration in ms between two ISO timestamps, or None if unparseable."""
    try:
        p = lambda s: datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return (p(t1) - p(t0)).total_seconds() * 1000
    except Exception:
        return None


def fence(text):
    """Wrap text in a code fence, widening it past any backtick run in the text."""
    runs = [len(m.group(0)) for m in re.finditer(r"`+", text)]
    n = max([4] + [r + 1 for r in runs])
    return "`" * n + "\n" + text + "\n" + "`" * n


def collapse(text, label="result"):
    """Render potentially long text: inline if short, <details> if long."""
    text = text if text else "(empty)"
    if len(text) > MAX_INLINE:
        return [f"<details><summary>{label} ({len(text):,} chars)</summary>", "", fence(text), "</details>"]
    return [fence(text)]


def block_text(blocks, kind="text"):
    return clean("\n".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == kind))


def active_branch(entries):
    """Order entries along the current branch: walk from the last entry
    (the leaf) to the root via parentId, then reverse.

    The session header has no id/parentId (not part of the tree), so it is
    handled separately by the caller."""
    with_id = [d for d in entries if isinstance(d, dict) and d.get("id")]
    leaf = with_id[-1] if with_id else None
    if leaf is None:
        return []
    by_id = {d["id"]: d for d in with_id}
    chain = []
    node = leaf
    while node is not None:
        chain.append(node)
        node = by_id.get(node.get("parentId"))
    chain.reverse()
    return chain


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else ""
    if not src or not os.path.isfile(src):
        print(f"error: no such file: {src}", file=sys.stderr)
        sys.exit(1)

    lines = []
    for raw in open(src, encoding="utf-8", errors="replace"):
        raw = raw.strip()
        if not raw:
            continue
        try:
            lines.append(json.loads(raw))
        except Exception:
            pass  # tolerate malformed lines

    # Pass 1: map toolCall id -> call timestamp (order-independent duration linking).
    call_ts = {}
    for d in lines:
        if isinstance(d, dict) and d.get("type") == "message":
            m = d.get("message") or {}
            if m.get("role") == "assistant":
                for b in (m.get("content") or []):
                    if isinstance(b, dict) and b.get("type") == "toolCall" and b.get("id"):
                        call_ts[b["id"]] = fmt_ts(d.get("timestamp"))

    out = []

    def emit(*ls):
        out.extend(ls)

    # Emit the session header first (it is metadata, not part of the tree).
    for d in lines:
        if isinstance(d, dict) and d.get("type") == "session":
            ts = fmt_ts(d.get("timestamp"))
            emit(f"## meta ({ts})",
                 f"Session `{d.get('id', '?')}` — cwd: `{d.get('cwd', '?')}`", "")
            break

    for d in active_branch(lines):
        if not isinstance(d, dict):
            continue
        t = d.get("type")
        ts = fmt_ts(d.get("timestamp"))

        if t == "session":
            continue

        if t == "model_change":
            emit(f"## meta ({ts})", f"Model changed -> {d.get('provider', '')}/{d.get('modelId', '')}", "")
            continue

        if t == "thinking_level_change":
            emit(f"## meta ({ts})", f"Thinking -> {d.get('thinkingLevel')}", "")
            continue

        if t in ("summary", "compaction"):
            extra = ""
            if d.get("tokensBefore"):
                extra = f" (tokens before: {d['tokensBefore']:,})"
            emit(f"## meta ({ts})", f"Compaction{extra}:", "", clean(d.get("summary", "")), "")
            continue

        if t == "branch_summary":
            emit(f"## meta ({ts})", f"Branch summary (abandoned path):", "", clean(d.get("summary", "")), "")
            continue

        if t == "session_info":
            emit(f"## meta ({ts})", f"Session named: {d.get('name', '')}", "")
            continue

        if t == "label":
            emit(f"## meta ({ts})", f"Label: {d.get('label', '')}", "")
            continue

        if t == "custom_message":
            txt = block_text(d.get("content") or [])
            emit(f"## extension: {d.get('customType', '?')} ({ts})")
            if txt:
                emit(txt)
            elif d.get("details"):
                emit(fence(json.dumps(d["details"], ensure_ascii=False)[:500]))
            else:
                emit("(empty)")
            emit("")
            continue

        if t == "custom":
            data = json.dumps(d.get("data"), ensure_ascii=False)
            if len(data) > 300:
                data = data[:300] + " …"
            emit(f"## extension: {d.get('customType', '?')} ({ts})", fence(data), "")
            continue

        if t != "message":
            continue  # unknown entry types: skip rather than crash

        m = d.get("message")
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        ts = ts or fmt_ts(m.get("timestamp"))
        content = m.get("content")
        if content is None:
            content = []
        if isinstance(content, str):  # defensive: pi always emits a list today
            content = [{"type": "text", "text": content}]

        if role in ("system", "developer"):
            emit(f"## system ({ts})", fence(block_text(content) or "(empty)"), "")

        elif role == "user":
            txt = block_text(content)
            n_img = sum(1 for b in content if isinstance(b, dict) and b.get("type") == "image")
            if n_img:
                txt += f"\n({n_img} image(s) hidden)"
            emit(f"## user ({ts})", txt or "(empty)", "")

        elif role == "assistant":
            emit(f"## assistant ({ts})")
            for b in content:
                if isinstance(b, dict) and b.get("type") == "thinking":
                    emit("### thinking", "", clean(b.get("thinking", "")), "")
            txt = block_text(content)
            if txt:
                emit(txt, "")
            for b in content:
                if isinstance(b, dict) and b.get("type") == "toolCall":
                    a = b.get("arguments")
                    a = clean(a if isinstance(a, str) else json.dumps(a, ensure_ascii=False))
                    emit("", f"### tool_call: {b.get('name', '?')}", "", fence(a))
            stop = m.get("stopReason")
            err = m.get("errorMessage")
            if stop not in (None, "stop", "toolUse"):
                emit("", f"> turn ended: {stop}" + (f" — {err}" if err else ""))
            elif err:
                emit("", f"> error: {err}")
            emit("")

        elif role == "toolResult":
            name = m.get("toolName", "?")
            t0 = call_ts.get(m.get("toolCallId"))
            dur = dur_ms(t0, ts) if t0 else None
            dur_s = f" (+{dur / 1000:.2f}s)" if dur is not None and dur >= 0 else ""
            emit(f"## tool_result: {name}{dur_s} ({ts})")
            txt = block_text(content)
            if m.get("isError"):
                emit(*collapse(f"ERROR: {txt}", "error"), "")
            else:
                emit(*collapse(txt), "")
            det = m.get("details")
            if isinstance(det, dict) and det:
                emit("### result details", "", fence(json.dumps(det, ensure_ascii=False, indent=1)))
            emit("")

        elif role == "bashExecution":
            ok = "" if m.get("exitCode") == 0 else f" (exit {m.get('exitCode')})"
            emit(f"## bash: user ran `{m.get('command', '')}`{ok} ({ts})")
            emit(*collapse(clean(m.get("output", ""))), "")

        # unknown roles: skip silently

    if not out:
        print("warning: no renderable entries found (schema change?)", file=sys.stderr)

    # Same temp dir pi uses: Node os.tmpdir() == Python tempfile.gettempdir()
    tmp = tempfile.gettempdir()
    path = join(tmp, f"pi-session-{uuid.uuid4().hex[:8]}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    print(path)


if __name__ == "__main__":
    main()
