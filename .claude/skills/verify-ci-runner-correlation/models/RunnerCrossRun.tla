-------------------------- MODULE RunnerCrossRun --------------------------
EXTENDS Naturals
VARIABLES first, second, mode, recent, phase, selected, incomplete, blocked
vars == <<first, second, mode, recent, phase, selected, incomplete, blocked>>

Init == /\ first \in {"queued", "none"} /\ second \in {"executing", "none"}
        /\ mode \in {"strict", "force"} /\ recent \in BOOLEAN
        /\ phase = "start" /\ selected = "none" /\ incomplete = FALSE /\ blocked = FALSE
ObserveFirst == /\ phase = "start" /\ phase' = "scanning" /\ selected' = first
                /\ UNCHANGED <<first, second, mode, recent, incomplete, blocked>>
Complete == /\ phase = "scanning" /\ phase' = "observed"
            /\ selected' = IF second = "executing" THEN "executing" ELSE selected
            /\ UNCHANGED <<first, second, mode, recent, incomplete, blocked>>
Fail == /\ phase = "scanning" /\ phase' = "observed" /\ incomplete' = TRUE
        /\ UNCHANGED <<first, second, mode, recent, selected, blocked>>
DirectFailure == /\ phase = "observed" /\ ~incomplete /\ selected # "executing"
                 /\ incomplete' = TRUE
                 /\ UNCHANGED <<first, second, mode, recent, phase, selected, blocked>>
Decide == /\ phase = "observed" /\ phase' = "done"
          /\ blocked' = IF incomplete /\ mode = "strict" THEN TRUE
                        ELSE IF selected = "executing" THEN TRUE
                        ELSE IF selected = "queued" /\ recent THEN TRUE ELSE FALSE
          /\ UNCHANGED <<first, second, mode, recent, selected, incomplete>>
Done == /\ phase = "done" /\ UNCHANGED vars
Next == ObserveFirst \/ Complete \/ Fail \/ DirectFailure \/ Decide \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ first \in {"queued", "none"} /\ second \in {"executing", "none"}
          /\ mode \in {"strict", "force"} /\ recent \in BOOLEAN
          /\ phase \in {"start", "scanning", "observed", "done"}
          /\ selected \in {"none", "queued", "executing"}
          /\ incomplete \in BOOLEAN /\ blocked \in BOOLEAN
NoMissedObservedExecution == phase = "done" /\ ~incomplete /\ second = "executing" => blocked
FailClosedOnIncomplete == phase = "done" /\ incomplete /\ mode = "strict" => blocked
RecentQueuedBlocks == phase = "done" /\ first = "queued" /\ recent => blocked
=============================================================================
