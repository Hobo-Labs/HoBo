---------------------------- MODULE YardSagaRetry ----------------------------
EXTENDS Naturals
CONSTANTS CheckCoalesce, CheckIdentity, CheckSnapshot
VARIABLES phase, mutated, providerWork, calls, inspectWhilePending, conflictAccepted, waiting, conflictRefused
vars == <<phase, mutated, providerWork, calls, inspectWhilePending, conflictAccepted, waiting, conflictRefused>>
Init == /\ phase = "new" /\ mutated = FALSE /\ providerWork = "original"
        /\ calls = 0 /\ inspectWhilePending = FALSE /\ conflictAccepted = FALSE
        /\ waiting = FALSE /\ conflictRefused = FALSE
Start == /\ phase = "new" /\ phase' = "running" /\ calls' = 1
         /\ UNCHANGED <<mutated, providerWork, inspectWhilePending, conflictAccepted, waiting, conflictRefused>>
RetrySame == /\ phase = "running" /\ ~waiting
             /\ waiting' = TRUE
             /\ inspectWhilePending' = IF CheckCoalesce THEN inspectWhilePending ELSE TRUE
             /\ UNCHANGED <<phase, mutated, providerWork, calls, conflictAccepted, conflictRefused>>
RetryConflict == /\ phase \in {"running", "unknown", "checking", "ready"} /\ ~conflictRefused
                 /\ conflictRefused' = TRUE /\ conflictAccepted' = ~CheckIdentity
                 /\ UNCHANGED <<phase, mutated, providerWork, calls, inspectWhilePending, waiting>>
EditInput == /\ phase = "running" /\ ~mutated
             /\ mutated' = TRUE /\ providerWork' = IF CheckSnapshot THEN providerWork ELSE "changed"
             /\ UNCHANGED <<phase, calls, inspectWhilePending, conflictAccepted, waiting, conflictRefused>>
Finish == /\ phase = "running" /\ phase' = "ready"
          /\ UNCHANGED <<mutated, providerWork, calls, inspectWhilePending, conflictAccepted, waiting, conflictRefused>>
LoseReply == /\ phase = "running" /\ phase' = "unknown"
             /\ UNCHANGED <<mutated, providerWork, calls, inspectWhilePending, conflictAccepted, waiting, conflictRefused>>
Inspect == /\ phase = "unknown" /\ phase' = "checking"
           /\ UNCHANGED <<mutated, providerWork, calls, inspectWhilePending, conflictAccepted, waiting, conflictRefused>>
FinishInspect == /\ phase = "checking" /\ phase' = "ready"
                 /\ UNCHANGED <<mutated, providerWork, calls, inspectWhilePending, conflictAccepted, waiting, conflictRefused>>
Done == /\ phase = "ready" /\ UNCHANGED vars
Next == Start \/ RetrySame \/ RetryConflict \/ EditInput \/ Finish \/ LoseReply \/ Inspect \/ FinishInspect \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"new", "running", "unknown", "checking", "ready"}
          /\ mutated \in BOOLEAN /\ providerWork \in {"original", "changed"}
          /\ calls \in 0..1 /\ inspectWhilePending \in BOOLEAN
          /\ conflictAccepted \in BOOLEAN /\ waiting \in BOOLEAN /\ conflictRefused \in BOOLEAN
OneProvision == calls <= 1
NoInspectDuringProvision == ~inspectWhilePending
NoConflictingReuse == ~conflictAccepted
ImmutableProviderWork == providerWork = "original"
=============================================================================
