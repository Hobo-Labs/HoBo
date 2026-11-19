import hashlib
import json
import os
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


COMPLETION_REVIEW = """Before ending, review the latest human request and its current scope. This reminder is not a new user request.

For an action request, compare the actual result and evidence with the requested outcome. If essential work remains and a concrete, safe, authorized action can advance it, take that action now. A merged change, passing subtask, failed approach, or description of the remaining work does not by itself complete the request. Consider available alternatives and independent work before reporting a blocker; do not repeat futile attempts, weaken protections, or ask again for permission already granted.

Honor an explicit stop, pause, cancellation, change of scope, or request only for an answer. Do not resume superseded work, invent unnecessary work, or proceed past a real approval, safety, or access boundary. If the active request is complete, or no useful authorized action is available, finish with an accurate response."""


@dataclass(frozen=True)
class StopEvent:
    conversation_id: Optional[str]
    loop_count: Optional[int]
    status: Optional[str]
    stop_hook_active: Optional[bool]


def parse_event(value):
    if not isinstance(value, dict):
        return None
    conversation_id = value.get("conversation_id")
    loop_count = value.get("loop_count")
    status = value.get("status")
    active = value.get("stop_hook_active")
    if conversation_id is not None and not isinstance(conversation_id, str):
        return None
    if loop_count is not None and (
        type(loop_count) is not int or not 0 <= loop_count <= 2**53 - 1
    ):
        return None
    if status is not None and not isinstance(status, str):
        return None
    if active is not None and not isinstance(active, bool):
        return None
    return StopEvent(conversation_id, loop_count, status, active)


class CursorState:
    def __init__(self, directory=None):
        self.uid = os.getuid() if hasattr(os, "getuid") else None
        identity = str(self.uid) if self.uid is not None else "user"
        self.directory = (
            Path(directory)
            if directory
            else Path(tempfile.gettempdir()) / f"hobo-agent-completion-{identity}"
        )

    def path(self, conversation_id):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise OSError("Invalid completion state directory")
        if self.uid is not None and (info.st_uid != self.uid or info.st_mode & 0o077):
            raise OSError("Insecure completion state directory")
        name = hashlib.sha256(conversation_id.encode("utf-8")).hexdigest()
        return self.directory / name

    def read(self, conversation_id):
        path = self.path(conversation_id)
        try:
            value = path.read_text(encoding="ascii")
            return int(value) if value.isascii() and value.isdecimal() else None
        except FileNotFoundError:
            return None

    def write(self, conversation_id, count):
        path = self.path(conversation_id)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="ascii") as output:
            output.write(str(count))


def review_stop(event, mode, state):
    if event.stop_hook_active is True or event.status in ("aborted", "error"):
        return {}
    if mode == "shared":
        if event.conversation_id is not None or event.stop_hook_active is not False:
            return {}
        return {"decision": "block", "reason": COMPLETION_REVIEW}
    if (
        event.status != "completed"
        or not event.conversation_id
        or event.loop_count is None
    ):
        return {}
    previous = state.read(event.conversation_id)
    state.write(event.conversation_id, event.loop_count)
    if (previous is None and event.loop_count > 0) or (
        previous is not None and event.loop_count > previous
    ):
        return {}
    return {"followup_message": COMPLETION_REVIEW}


def main():
    try:
        event = parse_event(json.load(sys.stdin))
        mode = (
            "cursor" if len(sys.argv) > 1 and sys.argv[1] == "cursor" else "shared"
        )
        result = review_stop(event, mode, CursorState()) if event else {}
    except (OSError, ValueError, TypeError, OverflowError):
        result = {}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
