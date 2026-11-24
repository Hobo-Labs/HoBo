----------------------- MODULE WorkflowEmitRecovery -----------------------
EXTENDS Naturals
VARIABLES phase, recorded, writes, returnedSeq
vars == <<phase, recorded, writes, returnedSeq>>

Init == /\ phase = "running" /\ recorded = FALSE /\ writes = 0
        /\ returnedSeq = 0
LostBeforeCommit == /\ phase = "running" /\ ~recorded /\ phase' = "stopped"
                    /\ UNCHANGED <<recorded, writes, returnedSeq>>
Write == /\ phase = "running" /\ ~recorded /\ writes < 2
         /\ recorded' = TRUE /\ writes' = writes + 1
         /\ phase' \in {"running", "stopped"} /\ UNCHANGED returnedSeq
Crash == /\ phase = "running" /\ phase' = "stopped"
         /\ UNCHANGED <<recorded, writes, returnedSeq>>
Resume == /\ phase = "stopped" /\ phase' = "running"
          /\ UNCHANGED <<recorded, writes, returnedSeq>>
Return == /\ phase = "running" /\ recorded /\ phase' = "done"
          /\ returnedSeq' = 1 /\ UNCHANGED <<recorded, writes>>
Done == /\ phase = "done" /\ UNCHANGED vars
Next == LostBeforeCommit \/ Write \/ Crash \/ Resume \/ Return \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"running", "stopped", "done"}
          /\ recorded \in BOOLEAN /\ writes \in 0..2 /\ returnedSeq \in 0..2
AtMostOneEvent == writes <= 1
ReturnRequiresEvent == phase = "done" => recorded
ReturnOriginalSequence == phase = "done" => returnedSeq = 1
=============================================================================
