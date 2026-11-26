#!/bin/sh
# Test shape for the hop race, POSIX sh only: ignores SIGTERM and, when given $3, writes it then;
# while $1 > 0 it sleeps 10 ms, starts itself again with $1 - 1 in the background (same group, no
# setsid) and exits; the last one writes $2 after 3 s. Usage: sh hop.sh <hops> <marker> [ready]
trap '' TERM
if [ -n "$3" ]; then : > "$3"; fi
if [ "$1" -gt 0 ]; then sleep 0.01; sh "$0" $(($1 - 1)) "$2" & exit 0; fi
sleep 3
touch "$2"
