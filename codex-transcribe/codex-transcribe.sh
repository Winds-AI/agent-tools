#!/bin/zsh

AUDIO_FILE="$1"
APP_VERSION="$(plutil -extract CFBundleShortVersionString raw /Applications/ChatGPT.app/Contents/Info.plist)"
ACCESS_TOKEN="$(jq -r '.tokens.access_token' /Users/meetlimbani/.codex/auth.json)"
ACCOUNT_ID="$(jq -r '.tokens.account_id' /Users/meetlimbani/.codex/auth.json)"

curl --fail-with-body --silent --show-error \
  'https://chatgpt.com/backend-api/transcribe' \
  -A "Codex Desktop/${APP_VERSION} (Mac OS; $(uname -m))" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "ChatGPT-Account-Id: ${ACCOUNT_ID}" \
  -H 'originator: Codex Desktop' \
  -F "file=@${AUDIO_FILE}" \
  | jq -r '.text'

unset ACCESS_TOKEN ACCOUNT_ID
