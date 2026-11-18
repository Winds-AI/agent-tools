#!/bin/sh
# Paste script for Handy's "External Script" paste method, for Handy versions
# older than 0.10.0 that have no transcription hook.
#
# Handy passes the transcript as the first argument. This rewrites it, pastes
# the result into the focused app with Cmd+V, then puts the previous clipboard back.
# The first use makes macOS ask whether Handy may control System Events.
set -u

transcript=${1-}
[ -n "$transcript" ] || exit 0

file=$(mktemp -t open-typeless) || exit 1
trap 'rm -f "$file"' EXIT

# open-typeless prints the transcript unchanged when it cannot rewrite it.
if ! printf '%s' "$transcript" | "${OPEN_TYPELESS_BIN:-$HOME/.local/bin/open-typeless}" > "$file" || [ ! -s "$file" ]; then
    printf '%s' "$transcript" > "$file"
fi

/usr/bin/osascript - "$file" <<'APPLESCRIPT'
on run argv
    set newText to read (POSIX file (item 1 of argv)) as «class utf8»
    try
        set oldClipboard to the clipboard
    on error
        set oldClipboard to missing value
    end try
    set the clipboard to newText
    tell application "System Events" to keystroke "v" using command down
    delay 0.25
    if oldClipboard is not missing value then set the clipboard to oldClipboard
end run
APPLESCRIPT
