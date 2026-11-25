---------------------------- MODULE RivetKv ----------------------------
EXTENDS Naturals

VARIABLE s
vars == <<s>>

Init ==
  s = [phase |-> "ready", operation |-> "none", value |-> "old",
       sent |-> 0, commits |-> 0, inFlight |-> FALSE, outcome |-> "none",
       receipt |-> FALSE, fenced |-> FALSE, lateCommit |-> FALSE,
       effectAfterFence |-> FALSE]

Dispatch(operation) ==
  /\ operation \in {"set", "delete"}
  /\ s.phase = "ready" /\ s.sent = 0 /\ s.sent < 2
  /\ s' = [s EXCEPT !.phase = "pending", !.operation = operation,
                     !.sent = @ + 1, !.inFlight = TRUE]

Timeout ==
  /\ s.phase = "pending" /\ s.inFlight /\ s.outcome = "none"
  /\ s' = [s EXCEPT !.phase = "done", !.outcome = "unknown"]

Commit ==
  /\ s.inFlight /\ ~s.fenced
  /\ s' = [s EXCEPT !.inFlight = FALSE, !.commits = @ + 1,
        !.value = IF s.operation = "set" THEN "new" ELSE "absent",
        !.receipt = IF s.outcome = "none" THEN TRUE ELSE s.receipt,
        !.phase = "done",
        !.lateCommit = @ \/ (s.outcome = "unknown"),
        !.effectAfterFence = @ \/ s.fenced,
        !.outcome = IF s.outcome = "none" THEN "success" ELSE s.outcome]

LoseReceipt ==
  /\ s.inFlight /\ ~s.fenced /\ s.outcome = "none"
  /\ s' = [s EXCEPT !.inFlight = FALSE, !.commits = @ + 1,
        !.value = IF s.operation = "set" THEN "new" ELSE "absent",
        !.phase = "done", !.outcome = "unknown"]

Reject ==
  /\ s.inFlight /\ s.outcome = "none"
  /\ s' = [s EXCEPT !.phase = "done", !.inFlight = FALSE, !.outcome = "denied"]

Fence ==
  /\ s.outcome = "unknown" /\ ~s.fenced
  /\ s' = [s EXCEPT !.fenced = TRUE]

Drain ==
  /\ s.fenced /\ s.inFlight
  /\ s' = [s EXCEPT !.inFlight = FALSE]

Retire ==
  /\ s.phase = "done" /\ ~s.inFlight
  /\ (s.outcome # "unknown" \/ s.fenced)
  /\ s' = [s EXCEPT !.phase = "retired"]

Retry ==
  /\ FALSE
  /\ s.phase = "done" /\ s.outcome = "unknown" /\ s.sent < 2
  /\ s' = [s EXCEPT !.phase = "pending", !.sent = @ + 1, !.inFlight = TRUE]

Next == (\E operation \in {"set", "delete"}: Dispatch(operation))
        \/ Timeout \/ Commit \/ LoseReceipt \/ Reject \/ Fence \/ Drain \/ Retire \/ Retry
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.phase \in {"ready", "pending", "done", "retired"}
  /\ s.operation \in {"none", "set", "delete"}
  /\ s.value \in {"old", "new", "absent"}
  /\ s.sent \in 0..2 /\ s.commits \in 0..2
  /\ s.outcome \in {"none", "success", "unknown", "denied"}
  /\ s.inFlight \in BOOLEAN /\ s.receipt \in BOOLEAN /\ s.fenced \in BOOLEAN
  /\ s.lateCommit \in BOOLEAN /\ s.effectAfterFence \in BOOLEAN

AtMostOneDispatch == s.sent <= 1
SuccessRequiresReceipt == s.outcome = "success" => s.commits = 1 /\ s.receipt
DenialHasNoEffect == s.outcome = "denied" => s.commits = 0
NoEffectAfterFence == ~s.effectAfterFence
UnknownRetirementRequiresFence == s.phase = "retired" /\ s.outcome = "unknown" => s.fenced /\ ~s.inFlight
NeverLateCommit == ~s.lateCommit
NeverLostCommittedReceipt == ~(s.outcome = "unknown" /\ s.commits = 1)
NeverRetiredUnknown == ~(s.phase = "retired" /\ s.outcome = "unknown")
=============================================================================
