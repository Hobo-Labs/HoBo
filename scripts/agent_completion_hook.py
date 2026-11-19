import hashlib
import json
import os
import re
import shlex
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


COMPLETION_REVIEW = """HoBo completion review (automatic; not a human request):
Before ending, review the active human request and its current scope. A status question does not cancel an active task; answer it and continue unless the human stops or changes the task.

For an action request, compare the actual result and evidence with the requested outcome. If essential work remains and a concrete, safe, authorized action can advance it, take that action now. A merged change, passing subtask, failed approach, or description of the remaining work does not by itself complete the request. Consider available alternatives and independent work before reporting a blocker; do not repeat futile attempts, weaken protections, or ask again for permission already granted.

Honor an explicit stop, pause, cancellation, change of scope, or request only for an answer. Do not resume superseded work, invent unnecessary work, or proceed past a real approval, safety, or access boundary. If the active request is complete, or no useful authorized action is available, finish with an accurate response."""

MAX_READY_RETRIES = 3
STALL_REVIEW = """HoBo completion review (automatic; not a human request):
A ready action remains after repeated attempts to stop. Do not claim the task is complete. Take an authorized next step if possible, or explain the concrete blocker and unfinished work. This is the last automatic continuation before the guard pauses to prevent a loop; a human can resume the work."""


@dataclass(frozen=True)
class StopEvent:
    conversation_id: Optional[str]
    session_id: Optional[str]
    loop_count: Optional[int]
    status: Optional[str]
    stop_hook_active: Optional[bool]
    prompt: Optional[str]


def parse_event(value):
    if not isinstance(value, dict):
        return None
    conversation_id = value.get("conversation_id")
    session_id = value.get("session_id", value.get("sessionId"))
    loop_count = value.get("loop_count")
    status = value.get("status")
    active = value.get("stop_hook_active")
    prompt = value.get("prompt")
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
    if prompt is not None and not isinstance(prompt, str):
        return None
    return StopEvent(conversation_id, session_id, loop_count, status, active, prompt)


class CompletionState:
    def __init__(self, directory=None, create=True):
        self.uid = os.getuid() if hasattr(os, "getuid") else None
        identity = str(self.uid) if self.uid is not None else "user"
        self.directory = (
            Path(directory)
            if directory
            else Path(tempfile.gettempdir()) / f"hobo-agent-completion-{identity}"
        )
        self.create = create

    def prepare(self):
        if self.create:
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
            if not self.regular(path):
                return None
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
        self.regular(path)
        descriptor, temporary = tempfile.mkstemp(prefix=".counter-", dir=self.directory)
        try:
            with os.fdopen(descriptor, "w", encoding="ascii") as output:
                output.write(str(count))
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def regular(self, path):
        try:
            info = path.lstat()
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(info.st_mode):
            raise OSError("Invalid completion state file")
        return True

    def marker(self, token):
        if len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
            raise ValueError("Invalid completion marker")
        self.prepare()
        return self.directory / f"{token}.ready"

    def flag(self, session, name):
        if name not in ("human", "review", "stop"):
            raise ValueError("Invalid completion flag")
        token = session_token(session)
        self.marker(token)
        return self.directory / f"{token}.{name}"

    def set_flag(self, session, name):
        path = self.flag(session, name)
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(descriptor)
        except FileExistsError:
            if not self.regular(path):
                raise OSError("Invalid completion flag")

    def has_flag(self, session, name):
        return self.regular(self.flag(session, name))

    def clear_flag(self, session, name):
        self.flag(session, name).unlink(missing_ok=True)

    def has_ready(self, session):
        return self.regular(self.marker(session_token(session)))

    def clear_ready(self, session):
        self.mark(session_token(session), False)

    def reset_retries(self, session):
        token = session_token(session)
        self.marker(token)
        for count in range(1, MAX_READY_RETRIES + 2):
            (self.directory / f"{token}.retry.{count}").unlink(missing_ok=True)

    def next_retry(self, session):
        token = session_token(session)
        self.marker(token)
        for count in range(1, MAX_READY_RETRIES + 2):
            path = self.directory / f"{token}.retry.{count}"
            try:
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(descriptor)
                return count
            except FileExistsError:
                if not self.regular(path):
                    raise OSError("Invalid completion retry state")
        return MAX_READY_RETRIES + 2

    def mark(self, token, ready):
        path = self.marker(token)
        if ready:
            try:
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(descriptor)
            except FileExistsError:
                if not self.regular(path):
                    raise OSError("Invalid completion marker")
        else:
            path.unlink(missing_ok=True)


def session_token(session):
    return hashlib.sha256(session.encode("utf-8")).hexdigest()


STOP_REQUEST = re.compile(
    r"(?:^|[.!?,;:\n]\s*|\b(?:please|kindly|just)\s+|"
    r"\b(?:want|need|ask|asking)\s+(?:you\s+)?to\s+|\bcan\s+you\s+)"
    r"(?:immediately\s+)?(?:stop|pause|cancel|halt|cease)\b"
    r"(?:\s+(?:(?:babysitting|monitoring|watching|reviewing|merging|checking|"
    r"processing|working|updating|editing|deploying|testing|building|fixing|"
    r"running|using|inspecting|handling|tracking|investigating|rechecking|"
    r"retrying|following|maintaining|doing)\b"
    r"(?:\s+(?!(?:and|then|but|after|once|when|until|while|for|please|"
    r"now|here|immediately)\b)[^\s,.;:!?]+){0,12}|"
    r"all\s+(?:(?:the|this)\s+)?(?:work|tasks?|activity)|"
    r"(?:the|this|your|current)\s+(?:work|tasks?|activity|job|request)|"
    r"work(?:ing)?|everything|what\s+you(?:'re|\s+are)\s+doing))?"
    r"(?:\s+(?:right\s+now|now|here|immediately))?"
    r"(?=\s*(?:$|[.,!?;:]|(?:and|then|but|for|until|while|please)\b))"
)
NEGATED_REQUEST = re.compile(
    r"\b(?:don't|do not|never|not|shouldn't|mustn't|cannot|can't|won't|"
    r"didn't|did not)(?:\s+\w+){0,4}\s*$"
)


def immediate_stop(prompt):
    text = prompt.casefold().replace("’", "'")
    text = re.sub(r'```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”', " ", text)
    text = re.sub(r"(?<!\w)'[^'\n]*'(?!\w)", " ", text)
    for match in STOP_REQUEST.finditer(text):
        if NEGATED_REQUEST.search(text[max(0, match.start() - 80):match.start()]):
            continue
        remainder = re.split(r"[.!?;\n]", text[match.end():], maxsplit=1)[0]
        if re.search(
            r"\b(?:after|once|when|continue|resume|restart)\b|"
            r"\bkeep\s+(?:working|going)\b",
            remainder,
        ):
            continue
        return True
    return bool(re.fullmatch(r"\s*never\s+mind[.!?\s]*", text))


def stop_only(prompt):
    text = prompt.casefold().replace("’", "'")
    text = re.sub(r'```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”', " ", text)
    text = re.sub(r"(?<!\w)'[^'\n]*'(?!\w)", " ", text)
    if not immediate_stop(prompt):
        return False
    for match in STOP_REQUEST.finditer(text):
        if NEGATED_REQUEST.search(text[max(0, match.start() - 80):match.start()]):
            continue
        clause = re.split(r"[.!?;\n]", text[match.end():], maxsplit=1)[0]
        if re.search(
            r"\b(?:after|once|when|continue|resume|restart)\b|"
            r"\bkeep\s+(?:working|going)\b",
            clause,
        ):
            continue
        remainder = text[match.end():]
        break
    else:
        return bool(re.fullmatch(r"\s*never\s+mind[.!?\s]*", text))
    for segment in re.split(r"[.!?;\n]+|\b(?:and|then|but)\b", remainder):
        segment = segment.strip(" ,:\t\r")
        segment = re.sub(r"^(?:please|kindly)\s+", "", segment)
        if re.match(r"^(?:do not|don't|never)\b", segment):
            continue
        for clause in segment.split(","):
            clause = clause.strip(" :\t\r")
            clause = re.sub(r"^(?:please|kindly)\s+", "", clause)
            if not clause:
                continue
            if re.fullmatch(
                r"(?:please|now|here|right now|immediately|for now|thanks|thank you|"
                r"(?:answer|respond)(?: me| here| my question)?)",
                clause,
            ):
                continue
            if re.match(
                r"^(?:explain (?:why|what|how)|tell me|why|what|how|"
                r"do nothing|no more (?:tools|tool calls)|stop using tools|"
                r"wait for my next message|until|while i)\b",
                clause,
            ):
                continue
            return False
    return True


def observe_prompt(event, mode, state):
    session = event.conversation_id if mode == "cursor" else event.session_id
    if mode == "shared" and event.conversation_id is not None:
        return {}
    if not session or not event.prompt:
        return {}
    if event.prompt.startswith(
        "HoBo completion review (automatic; not a human request):"
    ):
        return {}
    if immediate_stop(event.prompt):
        state.clear_ready(session)
        state.reset_retries(session)
        if stop_only(event.prompt):
            state.set_flag(session, "stop")
        else:
            state.clear_flag(session, "stop")
        if mode == "cursor":
            state.clear_flag(session, "human")
            state.clear_flag(session, "review")
            if not stop_only(event.prompt):
                state.set_flag(session, "human")
    else:
        state.clear_flag(session, "stop")
        state.reset_retries(session)
        if mode == "cursor":
            state.set_flag(session, "human")
    return {}


def record_command(script, directory, token, status, windows):
    args = [
        "python" if windows else "python3",
        script,
        "record",
        directory,
        token,
        status,
    ]
    if windows:
        return "& " + " ".join("'" + arg.replace("'", "''") + "'" for arg in args)
    return shlex.join(args)


def review_prompt(session, state):
    if not session:
        return COMPLETION_REVIEW
    state.prepare()
    script = str(Path(__file__).resolve())
    directory = str(state.directory.absolute())
    token = session_token(session)
    ready, clear = (
        record_command(script, directory, token, status, os.name == "nt")
        for status in ("ready", "clear")
    )
    return f"""{COMPLETION_REVIEW}

When you identify a concrete, safe, authorized next action, record it as ready before acting:
{ready}
Then do the action. Clear the record only when no such action remains, the human explicitly stops or changes scope, or a real external blocker prevents all useful authorized work:
{clear}
The record contains no task details. Do not clear it merely to end the turn. A recorded ready action keeps the stop guard active."""


def ready_response(session, mode, state):
    attempt = state.next_retry(session)
    key = "followup_message" if mode == "cursor" else "reason"
    if attempt <= MAX_READY_RETRIES:
        result = {key: review_prompt(session, state)}
    elif attempt == MAX_READY_RETRIES + 1:
        result = {key: STALL_REVIEW}
    else:
        return {
            "systemMessage": "Automatic continuation paused after repeated stops; ready work remains unresolved."
        }
    if mode == "shared":
        result["decision"] = "block"
    return result


def review_stop(event, mode, state):
    if event.status in ("aborted", "error"):
        if mode == "cursor" and event.conversation_id:
            if event.status == "aborted":
                state.clear_ready(event.conversation_id)
                state.reset_retries(event.conversation_id)
            state.clear_flag(event.conversation_id, "human")
            state.clear_flag(event.conversation_id, "review")
            if event.loop_count is not None:
                state.write(event.conversation_id, event.loop_count)
        return {}
    if mode == "shared":
        if event.conversation_id is not None:
            return {}
        session = event.session_id
        if session and state.has_flag(session, "stop"):
            state.clear_flag(session, "stop")
            return {}
        if event.stop_hook_active is False:
            return {"decision": "block", "reason": review_prompt(session, state)}
        if event.stop_hook_active is True and session and state.has_ready(session):
            return ready_response(session, mode, state)
        return {}
    if (
        event.status != "completed"
        or not event.conversation_id
        or event.loop_count is None
    ):
        return {}
    previous = state.read(event.conversation_id)
    state.write(event.conversation_id, event.loop_count)
    if state.has_flag(event.conversation_id, "stop"):
        state.clear_flag(event.conversation_id, "stop")
        return {}
    human = state.has_flag(event.conversation_id, "human")
    if human:
        state.clear_flag(event.conversation_id, "human")
        state.set_flag(event.conversation_id, "review")
        return {"followup_message": review_prompt(event.conversation_id, state)}
    continuation = state.has_flag(event.conversation_id, "review") or (
        previous is None and event.loop_count > 0
    ) or (
        previous is not None and event.loop_count > previous
    )
    if continuation:
        if state.has_ready(event.conversation_id):
            result = ready_response(event.conversation_id, mode, state)
            if "followup_message" not in result:
                state.clear_flag(event.conversation_id, "review")
            return result
        state.clear_flag(event.conversation_id, "review")
        return {}
    state.set_flag(event.conversation_id, "review")
    return {"followup_message": review_prompt(event.conversation_id, state)}


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "record":
        try:
            if len(sys.argv) != 5 or sys.argv[4] not in ("ready", "clear"):
                raise ValueError("Invalid completion state")
            directory = Path(sys.argv[2])
            uid = os.getuid() if hasattr(os, "getuid") else "user"
            if (
                not directory.is_absolute()
                or directory.name != f"hobo-agent-completion-{uid}"
            ):
                raise ValueError("Invalid completion state directory")
            CompletionState(directory, create=False).mark(
                sys.argv[3], sys.argv[4] == "ready"
            )
            return 0
        except (OSError, ValueError, TypeError, OverflowError):
            print("Could not update the completion state.", file=sys.stderr)
            return 1
    event = None
    action = sys.argv[1] if len(sys.argv) > 1 else "stop"
    mode = (
        "cursor" if action == "cursor" or sys.argv[2:3] == ["cursor"] else "shared"
    )
    try:
        event = parse_event(json.load(getattr(sys.stdin, "buffer", sys.stdin)))
        state = CompletionState()
        if not event:
            result = {}
        elif action == "prompt":
            result = observe_prompt(event, mode, state)
        elif action == "interrupt":
            session = event.conversation_id or event.session_id
            if session:
                state.clear_ready(session)
                state.reset_retries(session)
                state.clear_flag(session, "human")
                state.clear_flag(session, "review")
                state.clear_flag(session, "stop")
            result = {}
        else:
            result = review_stop(event, mode, state)
    except OSError:
        result = {
            "systemMessage": "Completion review state is unavailable; the ready-action check did not run."
        }
        if (
            event
            and action in ("stop", "cursor")
            and mode == "shared"
            and event.conversation_id is None
            and event.stop_hook_active is False
        ):
            result.update(decision="block", reason=COMPLETION_REVIEW)
        elif (
            event
            and action in ("stop", "cursor")
            and mode == "cursor"
            and event.status == "completed"
            and event.loop_count == 0
        ):
            result["followup_message"] = COMPLETION_REVIEW
    except (ValueError, TypeError, OverflowError):
        result = {}
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
