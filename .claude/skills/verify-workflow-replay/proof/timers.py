"""Inductive correspondence of an unbounded timer-history prefix."""

import os
import sys

from z3 import And, Array, ArraySort, ForAll, Implies, Int, IntSort, Not, Select, Solver, Store, unsat

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

sequence = Int("sequence")
maximum = Int("maximum")
sequence_guard = (
    sequence <= maximum
    if os.environ.get("WORKFLOW_APPEND_PROOF_MUTATION") == "allow-exhausted"
    else sequence < maximum
)
prove(
    "a permitted next sequence stays within its bound",
    [0 <= sequence, 0 < maximum, sequence_guard],
    sequence + 1 <= maximum,
)

contexts = Array("contexts", IntSort(), IntSort())
left = Int("left")
right = Int("right")
updated = Store(contexts, right, right)
selected = (
    Select(updated, right)
    if os.environ.get("WORKFLOW_PROVENANCE_PROOF_MUTATION") == "shared"
    else Select(updated, left)
)
prove(
    "one context cannot overwrite a different context",
    [left != right, Select(contexts, left) == left],
    selected == left,
)

tree_history = Array("tree_history", IntSort(), ArraySort(IntSort(), IntSort()))
tree_requests = Array("tree_requests", IntSort(), ArraySort(IntSort(), IntSort()))
tree_cursors = Array("tree_cursors", IntSort(), IntSort())
parent = Int("tree_parent")
sibling = Int("tree_sibling")
position = Select(tree_cursors, parent)


def tree_prefix(owner, length):
    return ForAll(
        [k],
        Implies(
            And(0 <= k, k < length),
            Select(Select(tree_history, owner), k) == Select(Select(tree_requests, owner), k),
        ),
    )


compared_parent = sibling if os.environ.get("WORKFLOW_TREE_PROOF_MUTATION") == "wrong-parent" else parent
prove(
    "matching a child extends its parent's prefix",
    [parent != sibling, 0 <= position, tree_prefix(parent, position),
     Select(Select(tree_history, compared_parent), position) == Select(Select(tree_requests, parent), position)],
    tree_prefix(parent, position + 1),
)
advanced = Store(tree_cursors, parent, position + 1)
prove(
    "advancing one parent's cursor leaves its sibling unchanged",
    [parent != sibling],
    Select(advanced, sibling) == Select(tree_cursors, sibling),
)
