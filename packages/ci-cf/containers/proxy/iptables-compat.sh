#!/bin/sh
set -u
real=/usr/sbin/$(basename "$0")
case "$*" in
  '-t mangle -A PREROUTING -p tcp -m socket -j DIVERT')
    error=$(mktemp) || exit 70
    "$real" "$@" 2>"$error"
    status=$?
    if [ "$status" -eq 0 ]; then rm -f "$error"; exit 0; fi
    # DIVERT is an established-socket fast path, not the interception rule.
    # Unsupported kernels still install the mandatory MARK/TPROXY rules.
    # All other errors and every non-fast-path rule retain their exit status.
    if grep -q 'Extension socket revision 0 not supported' "$error"; then
      cat "$error" >&2
      echo 'HoBo: socket DIVERT fast path unavailable; mandatory TPROXY interception remains enabled.' >&2
      rm -f "$error"
      exit 0
    fi
    cat "$error" >&2
    rm -f "$error"
    exit "$status"
    ;;
  *) exec "$real" "$@" ;;
esac
