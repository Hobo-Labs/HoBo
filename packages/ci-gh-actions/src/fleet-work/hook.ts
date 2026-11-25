import { INTERNAL_EVENTS, PULL_REQUEST_EVENTS } from "./origin.js";

// public-contract: in-sandbox path of the pre-job hook the runner installs.
export const HOOK_PATH = "/work/hobo-fleet/pre-job.sh";
// public-contract: in-sandbox directory the hook leaves its verdict and the facts it posted in.
export const STATE_DIR = "/work/hobo-fleet";
// public-contract: in-sandbox path of the runner registration, written with Sandbox.writeSecret.
export const REGISTRATION_PATH = "/run/hobo-fleet/registration";
// public-contract: prefix of the lines the start script prints after the runner exits.
export const MARKER = "@@hobo-fleet";

// public-contract: the pre-job hook's exit codes; GitHub shows them on the failed job.
export const HOOK_EXIT = {
	allowed: 0,
	refused: 41,
	conflict: 42,
	unreachable: 43,
} as const;

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function preJobHookScript(
	controlUrl: string,
	options: Readonly<{ stateDir?: string }> = {},
): string {
	return `#!/bin/sh
# HoBo fleet start fence (fleet design 6.9 step 7). Installed by the
# github-actions-job runner as ACTIONS_RUNNER_HOOK_JOB_STARTED. Exits
# ${HOOK_EXIT.refused} refused, ${HOOK_EXIT.conflict} conflict, ${HOOK_EXIT.unreachable} agent unreachable (fail closed).
set -u
fence=${quote(`${controlUrl}/fence`)}
state=${quote(options.stateDir ?? STATE_DIR)}
mkdir -p "$state" || exit ${HOOK_EXIT.unreachable}

# A just-in-time runner runs one job: a second one in this sandbox is a conflict.
if [ "$(cat "$state/fence" 2>/dev/null)" = allow ]; then
  echo conflict > "$state/fence"
  echo "HoBo fleet: this sandbox already started a job; refusing a second" >&2
  exit ${HOOK_EXIT.conflict}
fi

# JSON string contents: backslash and double quote escaped, control characters dropped.
esc() { printf '%s' "$1" | tr -d '\\000-\\037' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'; }
lower() { printf '%s' "$1" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz'; }

# The head repository's full name from the pull request in the event file:
# the first "full_name" inside "repo" of "head", read only up to "base".
# Escaped text inside a JSON string can never match a key pattern here.
head_repository() {
  [ -r "$1" ] || return 0
  section=$(tr -d '\\r\\n' < "$1" | sed -n 's/.*"head": *{//p' | sed -n 's/"base": *{.*//p')
  case "$section" in *'"repo": {'*|*'"repo":{'*) ;; *) return 0 ;; esac
  printf '%s' "$section" | sed -n 's/.*"repo": *{//p' \\
    | grep -o '"full_name": *"[^"\\\\]*"' | head -n 1 \\
    | sed 's/^"full_name": *"//; s/"$//'
}

repository=\${GITHUB_REPOSITORY:-}
ref=\${GITHUB_REF:-}
event=\${GITHUB_EVENT_NAME:-}
author=''
case "\${GITHUB_ACTOR_ID:-}" in
  ''|*[!0-9]*) ;;
  *) author="github:\${GITHUB_ACTOR_ID}" ;;
esac
origin=WORK_ORIGIN_UNKNOWN
case "$event" in
  ${INTERNAL_EVENTS.join("|")}) origin=WORK_ORIGIN_INTERNAL ;;
  ${PULL_REQUEST_EVENTS.join("|")})
    head=$(head_repository "\${GITHUB_EVENT_PATH:-/nonexistent}")
    if [ -n "$head" ]; then
      if [ "$(lower "$head")" = "$(lower "$repository")" ]; then
        origin=WORK_ORIGIN_INTERNAL
      else
        origin=WORK_ORIGIN_FORK
      fi
    fi ;;
esac
# The numeric job id, when the runner names it; otherwise empty, and the key joins no offer.
job=''
for candidate in "\${GITHUB_JOB_ID:-}" "\${JOB_CHECK_RUN_ID:-}"; do
  case "$candidate" in
    ''|*[!0-9]*) ;;
    *) job=$candidate; break ;;
  esac
done
attempt=''
case "\${GITHUB_RUN_ATTEMPT:-}" in
  ''|*[!0-9]*) ;;
  *) attempt=$GITHUB_RUN_ATTEMPT ;;
esac
work="\${repository}#\${job}@\${attempt}"

body="$state/observed.json"
printf '{"workKey":"%s","repository":"%s","ref":"%s","author":"%s","origin":"%s"}' \\
  "$(esc "$work")" "$(esc "$repository")" "$(esc "$ref")" "$(esc "$author")" "$origin" > "$body"

if command -v wget >/dev/null 2>&1; then
  answer=$(wget -q -T 10 -O- --header='Content-Type: application/json' --post-file="$body" "$fence" 2>/dev/null || true)
elif command -v curl >/dev/null 2>&1; then
  answer=$(curl -fsS -m 10 -H 'Content-Type: application/json' --data-binary "@$body" "$fence" 2>/dev/null || true)
else
  answer=''
fi

case "$answer" in
  *'"allow":true'*)
    echo allow > "$state/fence"
    exit ${HOOK_EXIT.allowed} ;;
  *'"allow":false'*)
    echo refuse > "$state/fence"
    echo "HoBo fleet: this device's start fence refused the job ($origin, $repository, $ref)" >&2
    exit ${HOOK_EXIT.refused} ;;
esac
echo unreachable > "$state/fence"
echo "HoBo fleet: this device's agent did not answer the start fence; refusing the job" >&2
exit ${HOOK_EXIT.unreachable}
`;
}

export const INSTALL_HOOK_ARGV: readonly string[] = [
	"sh",
	"-c",
	'umask 022 && mkdir -p "$(dirname "$1")" && cat > "$1" && chmod 0555 "$1"',
	"hobo-fleet-hook",
	HOOK_PATH,
];

// public-contract: the in-sandbox start script; its `@@hobo-fleet` lines are what the runner reads back.
export const START_SCRIPT = `set -u
state=${quote(STATE_DIR)}
mkdir -p "$state"
src=''
for dir in /home/runner /actions-runner /opt/actions-runner; do
  if [ -x "$dir/run.sh" ]; then src=$dir; break; fi
done
code=3
if [ -z "$src" ]; then
  echo "HoBo fleet: the image carries no GitHub runner" >&2
else
  mkdir -p /work/runner && cp -R "$src/." /work/runner/ && cd /work/runner && {
    ACTIONS_RUNNER_INPUT_JITCONFIG=$(cat ${quote(REGISTRATION_PATH)})
    rm -f ${quote(REGISTRATION_PATH)}
    export ACTIONS_RUNNER_INPUT_JITCONFIG
    code=0
    ./run.sh || code=$?
    unset ACTIONS_RUNNER_INPUT_JITCONFIG
  }
fi
rm -f ${quote(REGISTRATION_PATH)}
printf '%s fence %s\\n' ${quote(MARKER)} "$(cat "$state/fence" 2>/dev/null || echo none)"
printf '%s observed %s\\n' ${quote(MARKER)} "$(cat "$state/observed.json" 2>/dev/null)"
printf '%s exit %s\\n' ${quote(MARKER)} "$code"
`;

export const START_ARGV: readonly string[] = [
	"sh",
	"-c",
	START_SCRIPT,
	"hobo-fleet-runner",
];

export const START_ENV = {
	ACTIONS_RUNNER_HOOK_JOB_STARTED: HOOK_PATH,
	RUNNER_ALLOW_RUNASROOT: "1",
} as const;
