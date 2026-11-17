-------------------------- MODULE YardRuntimeSnapshot ------------------------
EXTENDS Naturals
CONSTANT CheckSnapshot
VARIABLES available, phase
vars == <<available, phase>>
Init == /\ available \in BOOLEAN /\ phase = "reading"
Read == /\ phase = "reading" /\ phase' = IF available \/ ~CheckSnapshot THEN "accepted" ELSE "rejected"
        /\ UNCHANGED available
Done == /\ phase \in {"accepted", "rejected"} /\ UNCHANGED vars
Next == Read \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ available \in BOOLEAN /\ phase \in {"reading", "accepted", "rejected"}
RequiresSnapshot == phase = "accepted" => available
=============================================================================
