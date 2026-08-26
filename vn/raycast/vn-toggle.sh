#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Toggle VN Mic
# @raycast.mode compact
# @raycast.packageName vn
# @raycast.icon 🎙️
# Toggles mute for the running vn voice session (mute if live, unmute if muted).

VN="$HOME/.local/bin/vn"
[ -x "$VN" ] || VN="$(cd "$(dirname "$0")/../scripts" 2>/dev/null && pwd)/vn.py"

S="$HOME/.local/state/vn/current.json"
[ -f "$S" ] || { echo "no active vn session"; exit 1; }

M=$(python3 -c "import json;print(json.load(open('$S')).get('muted',False))")

if [ "$M" = "True" ]; then
    "$VN" unmute >/dev/null && echo "vn: unmuted"
else
    "$VN" mute >/dev/null && echo "vn: muted"
fi
