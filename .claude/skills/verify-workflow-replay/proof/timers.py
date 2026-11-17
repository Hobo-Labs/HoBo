"""Inductive correspondence of an unbounded timer-history prefix."""

import os
import sys

from z3 import And, Array, ForAll, Implies, Int, IntSort, Not, Select, Solver, unsat

journal = Array("journal", IntSort(), IntSort())
requested = Array("requested", IntSort(), IntSort())
n = Int("journal_length")
m = Int("request_length")
cursor = Int("cursor")
k = Int("k")


def prefix(length):
    return ForAll(
        [k], Implies(And(0 <= k, k < length), Select(journal, k) == Select(requested, k))
    )


def prove(name, premises, conclusion):
    solver = Solver()
    solver.add(*premises, Not(conclusion))
    result = solver.check()
    if result != unsat:
        print(f"FAIL {name}: {result}")
        if str(result) == "sat":
            print(solver.model())
        sys.exit(1)
    print(f"PASS {name}")


prove("empty prefix", [], prefix(0))
comparison = (
    Select(journal, 0)
    if os.environ.get("TIMER_PROOF_MUTATION") == "first"
    else Select(journal, cursor)
)
prove(
    "matching next timer extends the prefix",
    [0 <= cursor, cursor < n, cursor < m, prefix(cursor), comparison == Select(requested, cursor)],
    prefix(cursor + 1),
)
prove(
    "accepted histories agree at every position",
    [0 <= cursor, cursor == n, cursor == m, prefix(cursor)],
    prefix(n),
)
prove(
    "equal histories do not reject the next timer",
    [0 <= cursor, cursor < n, n == m, prefix(n)],
    Select(journal, cursor) == Select(requested, cursor),
)

start = Int("start")
delay = Int("delay")
now = Int("now")
deadline = start + delay
reached = now >= start if os.environ.get("TIMER_PROOF_MUTATION") == "omit-deadline-check" else now >= deadline
prove(
    "a reached deadline implies the full delay elapsed",
    [0 <= start, 0 <= delay, reached],
    now - start >= delay,
)
prove(
    "an unreached deadline has positive remaining time",
    [now < deadline],
    deadline - now > 0,
)
