-------------------------- MODULE TrainingTraceCommit --------------------------
EXTENDS Integers
CONSTANTS DeferWrites, KeepExisting, CommitBatch
VARIABLES base, phase, buffer, sink
vars == <<base, phase, buffer, sink>>
Init == /\ base \in 0..1 /\ phase = "new" /\ buffer = 0 /\ sink = base
Start == /\ phase = "new" /\ phase' = "running" /\ UNCHANGED <<base, buffer, sink>>
Step == /\ phase = "running" /\ buffer < 2 /\ buffer' = buffer + 1
        /\ sink' = IF DeferWrites THEN sink ELSE sink + 1
        /\ UNCHANGED <<base, phase>>
Validate == /\ phase = "running" /\ buffer = 2 /\ phase' = "validated"
            /\ UNCHANGED <<base, buffer, sink>>
Fail == /\ phase = "running" /\ phase' = "failed" /\ UNCHANGED <<base, buffer, sink>>
Commit == /\ phase = "validated" /\ phase' = "done"
          /\ sink' = IF CommitBatch THEN IF KeepExisting THEN sink + buffer ELSE buffer ELSE sink
          /\ UNCHANGED <<base, buffer>>
Wait == UNCHANGED vars
Next == Start \/ Step \/ Validate \/ Fail \/ Commit \/ Wait
Spec == Init /\ [][Next]_vars
TypeOK == /\ base \in 0..1 /\ phase \in {"new", "running", "validated", "failed", "done"}
          /\ buffer \in 0..2 /\ sink \in 0..5
NoVisibleBeforeCommit == phase = "done" \/ sink = base
FailedRunPreservesQueue == phase # "failed" \/ sink = base
SuccessfulBatchComplete == phase # "done" \/ sink = base + 2
=============================================================================
