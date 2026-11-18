import hashlib
import json
import os
import shlex
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


COMPLETION_REVIEW = """Before ending, review the active human request and its current scope. This reminder is not a new user request. A status question does not cancel an active task; answer it and continue unless the human stops or changes the task.

For an action request, compare the actual result and evidence with the requested outcome. If essential work remains and a concrete, safe, authorized action can advance it, take that action now. A merged change, passing subtask, failed approach, or description of the remaining work does not by itself complete the request. Consider available alternatives and independent work before reporting a blocker; do not repeat futile attempts, weaken protections, or ask again for permission already granted.

Honor an explicit stop, pause, cancellation, change of scope, or request only for an answer. Do not resume superseded work, invent unnecessary work, or proceed past a real approval, safety, or access boundary. If the active request is complete, or no useful authorized action is available, finish with an accurate response."""


@dataclass(frozen=True)
class StopEvent:
    conversation_id: Optional[str]
    session_id: Optional[str]
    loop_count: Optional[int]
    status: Optional[str]
    stop_hook_active: Optional[bool]


def parse_event(value):
    if not isinstance(value, dict):
        return None
    conversation_id = value.get("conversation_id")
    session_id = value.get("session_id", value.get("sessionId"))
    loop_count = value.get("loop_count")
    status = value.get("status")
    active = value.get("stop_hook_active")
    if conversation_id is not None and not isinstance(conversation_id, str):
        return None
    if session_id is not None and not isinstance(session_id, str):
        return None
    if loop_count is not None and (
        type(loop_count) is not int or not 0 <= loop_count <= 2**53 - 1
    ):
        return None
    if status is not None and not isinstance(status, str):
        return None
    if active is not None and not isinstance(active, bool):
        return None
    return StopEvent(conversation_id, session_id, loop_count, status, active)


class CompletionState:
    def __init__(self, directory=None):
        self.uid = os.getuid() if hasattr(os, "getuid") else None
        identity = str(self.uid) if self.uid is not None else "user"
        self.directory = (
            Path(directory)
            if directory
            else Path(tempfile.gettempdir()) / f"hobo-agent-completion-{identity}"
        )

    def prepare(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise OSError("Invalid completion state directory")
        if self.uid is not None and (info.st_uid != self.uid or info.st_mode & 0o077):
            raise OSError("Insecure completion state directory")

    def path(self, conversation_id):
        self.prepare()
        name = hashlib.sha256(conversation_id.encode("utf-8")).hexdigest()
        return self.directory / name

    def read(self, conversation_id):
        path = self.path(conversation_id)
        try:
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "r", encoding="ascii") as source:
                value = source.read(17)
            return (
                int(value)
                if len(value) <= 16 and value.isascii() and value.isdecimal()
                else None
            )
        except FileNotFoundError:
            return None
        except (UnicodeError, ValueError):
            return None

    def write(self, conversation_id, count):
        path = self.path(conversation_id)
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="ascii") as output:
            output.write(str(count))

    def marker(self, token):
        if len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
            raise ValueError("Invalid completion marker")
        self.prepare()
        return self.directory / f"{token}.ready"

    def has_ready(self, session):
        try:
            return stat.S_ISREG(self.marker(session_token(session)).lstat().st_mode)
        except FileNotFoundError:
            return False

    def clear_ready(self, session):
        self.marker(session_token(session)).unlink(missing_ok=True)

    def mark(self, token, ready):
        path = self.marker(token)
        if ready:
            flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path, flags, 0o600)
            os.close(descriptor)
        else:
            path.unlink(missing_ok=True)


def session_token(session):
    return hashlib.sha256(session.encode("utf-8")).hexdigest()


def review_prompt(session):
    if not session:
        return COMPLETION_REVIEW
    executable = "python" if os.name == "nt" else "python3"
    script = str(Path(__file__).resolve())
    token = session_token(session)
    commands = [
        [executable, script, "record", token, state] for state in ("ready", "clear")
    ]
    quote = subprocess.list2cmdline if os.name == "nt" else shlex.join
    ready, clear = (quote(command) for command in commands)
    return f"""{COMPLETION_REVIEW}

When you identify a concrete, safe, authorized next action, record it as ready before acting:
{ready}
Then do the action. Clear the record only when no such action remains, the human explicitly stops or pauses, or a real external blocker prevents all useful authorized work:
{clear}
The record contains no task details. Do not clear it merely to end the turn. A recorded ready action keeps the stop guard active."""


def review_stop(event, mode, state):
    if event.status in ("aborted", "error"):
        return {}
    if mode == "shared":
        if event.conversation_id is not None:
            return {}
        session = event.session_id
        if event.stop_hook_active is False:
            if session:
                state.clear_ready(session)
            return {"decision": "block", "reason": review_prompt(session)}
        if event.stop_hook_active is True and session and state.has_ready(session):
            return {"decision": "block", "reason": review_prompt(session)}
        return {}
    if (
        event.status != "completed"
        or not event.conversation_id
        or event.loop_count is None
    ):
        return {}
    previous = state.read(event.conversation_id)
    state.write(event.conversation_id, event.loop_count)
    continuation = (previous is None and event.loop_count > 0) or (
        previous is not None and event.loop_count > previous
    )
    if continuation:
        if state.has_ready(event.conversation_id):
            return {"followup_message": review_prompt(event.conversation_id)}
        return {}
    state.clear_ready(event.conversation_id)
    return {"followup_message": review_prompt(event.conversation_id)}


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "record":
        try:
            if len(sys.argv) != 4 or sys.argv[3] not in ("ready", "clear"):
                raise ValueError("Invalid completion state")
            CompletionState().mark(sys.argv[2], sys.argv[3] == "ready")
            return 0
        except (OSError, ValueError, TypeError, OverflowError):
            print("Could not update the completion state.", file=sys.stderr)
            return 1
    try:
        event = parse_event(json.load(sys.stdin))
        mode = (
            "cursor" if len(sys.argv) > 1 and sys.argv[1] == "cursor" else "shared"
        )
        result = review_stop(event, mode, CompletionState()) if event else {}
    except OSError:
        result = {
            "systemMessage": "Completion review state is unavailable; the ready-action check did not run."
        }
    except (ValueError, TypeError, OverflowError):
        result = {}
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
