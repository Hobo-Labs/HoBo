-------------------- MODULE CiProviderAllocation --------------------
EXTENDS Naturals
\* Two unvalidated reports refer to the same provider allocation.
CONSTANTS Reports
VARIABLES phase, available, choice, claimed
vars == <<phase, available, choice, claimed>>

Init == /\ phase = "unrouted" /\ available \in [1..2 -> Reports]
        /\ choice \in 1..2 /\ claimed = 0
Route == /\ phase = "unrouted"
         /\ IF \E i \in 1..2 : available[i] > 0
               THEN /\ phase' = "refused" /\ claimed' = 0
               ELSE /\ phase' = "admitted" /\ claimed' = available[choice]
         /\ UNCHANGED <<available, choice>>
Done == /\ phase \in {"admitted", "refused"} /\ UNCHANGED vars
Next == Route \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"unrouted", "admitted", "refused"}
          /\ available \in [1..2 -> Reports] /\ choice \in 1..2
          /\ claimed \in Reports
NoOverstatedAllocation == phase = "admitted" =>
                           \A i \in 1..2 : claimed <= available[i]
=============================================================================
