---------------------------- MODULE QuoteLiability --------------------------
EXTENDS Naturals
CONSTANT Current
VARIABLES quoted, bound, originalCap, laterCap, authorized, phase
vars == <<quoted, bound, originalCap, laterCap, authorized, phase>>
Init == /\ quoted \in 0..2 /\ bound \in 0..2 /\ originalCap \in 0..2 /\ laterCap \in 0..2
        /\ authorized = 0 /\ phase = "pending"
Allowed == IF Current THEN (bound >= quoted /\ bound <= originalCap) ELSE quoted <= laterCap
Approve == /\ phase = "pending" /\ Allowed
           /\ authorized' = (IF Current THEN bound ELSE quoted) /\ phase' = "approved"
           /\ UNCHANGED <<quoted, bound, originalCap, laterCap>>
Refuse == /\ phase = "pending" /\ ~Allowed /\ phase' = "refused" /\ UNCHANGED <<quoted, bound, originalCap, laterCap, authorized>>
Done == /\ phase \in {"approved", "refused"} /\ UNCHANGED vars
Next == Approve \/ Refuse \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ quoted \in 0..2 /\ bound \in 0..2 /\ originalCap \in 0..2 /\ laterCap \in 0..2
          /\ authorized \in 0..2 /\ phase \in {"pending", "approved", "refused"}
BoundCoversQuote == phase = "approved" => bound >= quoted
AuthorizedCoversBound == phase = "approved" => authorized >= bound
OriginalBudgetHonored == phase = "approved" => authorized <= originalCap
ValidBoundAccepted == bound >= quoted /\ bound <= originalCap => phase # "refused"
=============================================================================
