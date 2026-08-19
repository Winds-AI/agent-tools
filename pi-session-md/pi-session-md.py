#!/usr/bin/env python3
"""pi-session-md — convert a pi session JSONL to compact markdown in the OS temp dir.

Usage: pi-session-md.py <session.jsonl>
Prints the path of the written .md file to stdout.
"""
import json, sys, os, tempfile, uuid
from datetime import datetime
from os.path import join

src = sys.argv[1] if len(sys.argv) > 1 else ""
if not src or not os.path.isfile(src):
    print(f"error: no such file: {src}", file=sys.stderr)
    sys.exit(1)

entries = []
calls = {}
for raw in open(src):
    raw = raw.strip()
    if not raw: continue
    try: d = json.loads(raw)
    except: continue
    t = d.get("type")
    if t == "session": continue
    if t == "model_change":
        entries.append(("meta", f"Model changed -> {d.get('modelId')}", d.get("timestamp"))); continue
    if t == "thinking_level_change":
        entries.append(("meta", f"Thinking -> {d.get('thinkingLevel')}", d.get("timestamp"))); continue
    if t == "summary":
        entries.append(("meta", f"Compaction: {d.get('summary','')}", d.get("timestamp"))); continue
    if t != "message" or not d.get("message"): continue
    m = d["message"]; role = m.get("role")
    ts = d.get("timestamp") or m.get("timestamp") or ""
    blocks = m.get("content") or []
    if role in ("system", "developer"):
        entries.append(("system", " ".join(b.get("text","") for b in blocks if b.get("type")=="text"), ts))
    elif role == "user":
        entries.append(("user", " ".join(b.get("text","") for b in blocks if b.get("type")=="text"), ts))
    elif role == "assistant":
        th = [b.get("thinking","") for b in blocks if b.get("type")=="thinking"]
        tx = " ".join(b.get("text","") for b in blocks if b.get("type")=="text")
        cls = [b for b in blocks if b.get("type")=="toolCall"]
        for c in cls: calls[c.get("id")] = ts
        entries.append(("assistant", (tx, th, cls), ts))
    elif role == "toolResult":
        tx = " ".join(b.get("text","") for b in blocks if b.get("type")=="text")
        cid = m.get("toolCallId"); dur = None
        t0 = calls.get(cid)
        if t0:
            try:
                dur = (datetime.fromisoformat(ts.replace("Z","+00:00")) - datetime.fromisoformat(t0.replace("Z","+00:00"))).total_seconds()*1000
            except: pass
        entries.append(("toolResult", (m.get("toolName","?"), tx, m.get("isError"), dur), ts))

out = []
for kind, data, ts in entries:
    meta = f" ({ts})" if ts else ""
    if kind == "meta":
        out += [f"## meta{meta}", data, ""]
    elif kind == "system":
        out += [f"## system{meta}", "```", data, "```", ""]
    elif kind == "user":
        out += [f"## user{meta}", data or "(empty)", ""]
    elif kind == "assistant":
        tx, th, cls = data
        out.append(f"## assistant{meta}")
        for t in th: out += ["### thinking", "", t, ""]
        out.append(tx or "(no text)")
        for c in cls:
            a = c.get("arguments"); a = a if isinstance(a, str) else json.dumps(a)
            out += ["", f"### tool_call: {c.get('name')}", "", "```json", a, "```"]
        out.append("")
    else:
        name, tx, isErr, dur = data
        out.append(f"## tool_result: {name}{meta}")
        if isErr: out += ["```", f"ERROR: {tx}", "```"]
        elif len(tx) > 2000: out += [f"<details><summary>result ({len(tx):,} chars)</summary>", "", "```", tx, "```", "</details>"]
        else: out += ["```", tx or "(empty)", "```"]
        out.append("")

# Same temp dir pi uses: Node os.tmpdir() == Python tempfile.gettempdir()
# ($TMPDIR on macOS/Linux, %TEMP% on Windows).
tmp = tempfile.gettempdir()
path = join(tmp, f"pi-session-{uuid.uuid4().hex[:8]}.md")
with open(path, "w") as f:
    f.write("\n".join(out))
print(path)
