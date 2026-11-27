#!/usr/bin/env bash
set -euo pipefail

while IFS= read -r marker || [ -n "$marker" ]; do
  if [ -n "$marker" ] && [ ! -f "$marker" ]; then
    printf '::warning::checkout succeeded but marker %s is missing\n' "$marker"
    exit 1
  fi
done <<< "${CHECKOUT_MARKER:-}"
