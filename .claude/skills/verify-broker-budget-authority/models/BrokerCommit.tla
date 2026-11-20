------------------------- MODULE BrokerCommit -------------------------
EXTENDS Naturals, FiniteSets
CONSTANT GuardReentry
VARIABLES stage, attempted, rejected, acknowledged, writes
vars == <<stage, attempted, rejected, acknowledged, writes>>

Init == /\ stage = "idle" /\ attempted = FALSE /\ rejected = FALSE
        /\ acknowledged = {} /\ writes = 0
Begin == /\ stage = "idle" /\ stage' = "writing"
         /\ UNCHANGED <<attempted, rejected, acknowledged, writes>>
Reenter == /\ stage = "writing" /\ ~attempted /\ attempted' = TRUE
           /\ IF GuardReentry
                 THEN /\ rejected' = TRUE /\ UNCHANGED <<acknowledged, writes>>
                 ELSE /\ rejected' = FALSE
                      /\ acknowledged' = acknowledged \cup {"nested"}
                      /\ writes' = writes + 1
           /\ UNCHANGED stage
Abort == /\ stage = "writing" /\ rejected /\ stage' = "aborted"
         /\ UNCHANGED <<attempted, rejected, acknowledged, writes>>
Complete == /\ stage = "writing" /\ ~rejected /\ stage' = "done"
            /\ acknowledged' = acknowledged \cup {"outer"}
            /\ writes' = writes + 1 /\ UNCHANGED <<attempted, rejected>>
Done == /\ stage \in {"aborted", "done"} /\ UNCHANGED vars
Next == Begin \/ Reenter \/ Abort \/ Complete \/ Done
Spec == Init /\ [][Next]_vars

TypeOK == /\ stage \in {"idle", "writing", "aborted", "done"}
          /\ attempted \in BOOLEAN /\ rejected \in BOOLEAN
          /\ acknowledged \subseteq {"outer", "nested"} /\ writes \in 0..2
NoOverlappingAdmissions == Cardinality(acknowledged) <= 1
NoDuplicateSequence == writes <= 1
NoAcknowledgedAbort == stage = "aborted" => acknowledged = {} /\ writes = 0
=============================================================================
