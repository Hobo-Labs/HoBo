----------------------- MODULE YardFundedGeneration --------------------------
EXTENDS Naturals
CONSTANTS RequireFunding, RequireCurrent, MarkUncertain, ReportFailure, KeepHold
VARIABLES funded, context, evidence, markAvailable, phase, executed, held, uncertain, reported
facts == <<funded, context, evidence, markAvailable>>
vars == <<funded, context, evidence, markAvailable, phase, executed, held, uncertain, reported>>
Init == /\ funded \in BOOLEAN /\ context \in BOOLEAN /\ evidence \in BOOLEAN /\ markAvailable \in BOOLEAN /\ phase = "pending"
        /\ executed = FALSE /\ held = FALSE /\ uncertain = FALSE /\ reported = FALSE
Claim == /\ phase = "pending" /\ phase' = IF (funded \/ ~RequireFunding) /\ (context \/ ~RequireCurrent) THEN "claimed" ELSE "rejected"
         /\ held' = funded /\ UNCHANGED <<facts, executed, uncertain, reported>>
Provision == /\ phase = "claimed" /\ phase' = "rematching" /\ executed' = TRUE
             /\ UNCHANGED <<facts, held, uncertain, reported>>
Rematch == /\ phase = "rematching" /\ phase' = IF evidence THEN "resolved" ELSE "rejected"
           /\ uncertain' = (~evidence /\ MarkUncertain /\ markAvailable)
           /\ reported' = (~evidence /\ ~markAvailable /\ ReportFailure)
           /\ held' = IF evidence \/ KeepHold THEN held ELSE FALSE
           /\ UNCHANGED <<facts, executed>>
Done == /\ phase \in {"resolved", "rejected"} /\ UNCHANGED vars
Next == Claim \/ Provision \/ Rematch \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ funded \in BOOLEAN /\ context \in BOOLEAN /\ evidence \in BOOLEAN /\ markAvailable \in BOOLEAN
          /\ executed \in BOOLEAN /\ held \in BOOLEAN /\ uncertain \in BOOLEAN /\ reported \in BOOLEAN
          /\ phase \in {"pending", "claimed", "rematching", "resolved", "rejected"}
ProvisionFunded == executed => funded /\ held
ProvisionCurrent == executed => context
ReconcileAfterEffect == executed /\ phase = "rejected" => held /\ (uncertain \/ reported)
=============================================================================
