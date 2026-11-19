#!/bin/sh
trap '' TERM
if [ -n "$3" ]; then : > "$3"; fi
if [ "$1" -gt 0 ]; then sleep 0.01; sh "$0" $(($1 - 1)) "$2" & exit 0; fi
sleep 3
touch "$2"
