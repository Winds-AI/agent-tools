#!/usr/bin/env bash
set -u
uvoice_browser=$1
uvoice_profile=$2
shift 2
uvoice_pid=''
uvoice_cleanup() {
  if [[ -n "$uvoice_pid" ]]; then
    kill -TERM -- "-$uvoice_pid" 2>/dev/null || true
    sleep 0.2
    kill -KILL -- "-$uvoice_pid" 2>/dev/null || true
    wait "$uvoice_pid" 2>/dev/null || true
  fi
  rm -rf -- "$uvoice_profile"
}
trap uvoice_cleanup EXIT
trap 'exit 0' TERM INT
setsid "$uvoice_browser" "$@" >/dev/null 2>&1 &
uvoice_pid=$!
printf '%s\n' '{"type":"host.ready","hidden":true}'
while kill -0 "$uvoice_pid" 2>/dev/null; do
  IFS= read -r -t 1 uvoice_message
  uvoice_read_status=$?
  if [[ "$uvoice_read_status" -eq 0 ]]; then exit 0; fi
  # read returns 1 at pipe EOF; a timeout is greater than 128.
  if [[ "$uvoice_read_status" -eq 1 ]]; then exit 0; fi
done
printf '%s\n' '{"type":"host.error","message":"Background audio browser exited."}'
exit 1
