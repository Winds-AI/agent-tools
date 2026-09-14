# Source this file to make "pi -V" available in this Bash session.
# Regular pi keeps its existing behavior. Nothing is globally installed.
PI_VOICE_LAUNCHER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/bin/pi-v"
pi() {
  local enabled=0 parse_options=1 argument
  local -a forwarded=()
  for argument in "$@"; do
    if [[ "$parse_options" == 1 && "$argument" == "-V" ]]; then
      enabled=1
    else
      forwarded+=("$argument")
      [[ "$argument" == "--" ]] && parse_options=0
    fi
  done
  if [[ "$enabled" == 1 ]]; then
    "$PI_VOICE_LAUNCHER" "${forwarded[@]}"
  else
    command pi "${forwarded[@]}"
  fi
}
