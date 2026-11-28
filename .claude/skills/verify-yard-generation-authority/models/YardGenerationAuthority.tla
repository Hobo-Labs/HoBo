------------------------ MODULE YardGenerationAuthority ----------------------
EXTENDS Naturals
CONSTANTS CheckPolicy, CheckRuntime, CheckConnector, CheckEffect, CheckPost, MarkUncertain, ReportFailure
VARIABLES policy, runtime, connector, effectCurrent, postCurrent, markAvailable,
          phase, held, executed, uncertain, reported
facts == <<policy, runtime, connector, effectCurrent, postCurrent, markAvailable>>
vars == <<facts, phase, held, executed, uncertain, reported>>
Init == /\ policy \in BOOLEAN /\ runtime \in BOOLEAN /\ connector \in BOOLEAN
        /\ effectCurrent \in BOOLEAN /\ postCurrent \in BOOLEAN /\ markAvailable \in BOOLEAN
        /\ phase = "held" /\ held = TRUE /\ executed = FALSE /\ uncertain = FALSE /\ reported = FALSE
Claim == /\ phase = "held"
         /\ phase' = IF (policy \/ ~CheckPolicy) /\ (runtime \/ ~CheckRuntime) /\ (connector \/ ~CheckConnector)
                     THEN "claimed" ELSE "rejected"
         /\ UNCHANGED <<facts, held, executed, uncertain, reported>>
Provider == /\ phase = "claimed"
            /\ phase' = IF effectCurrent \/ ~CheckEffect THEN "provisioned" ELSE "rejected"
            /\ executed' = (effectCurrent \/ ~CheckEffect)
            /\ UNCHANGED <<facts, held, uncertain, reported>>
Finalize == /\ phase = "provisioned"
            /\ phase' = IF postCurrent \/ ~CheckPost THEN "issued" ELSE "rejected"
            /\ uncertain' = (~postCurrent /\ MarkUncertain /\ markAvailable)
            /\ reported' = (~postCurrent /\ ~markAvailable /\ ReportFailure)
            /\ UNCHANGED <<facts, held, executed>>
Done == /\ phase \in {"issued", "rejected"} /\ UNCHANGED vars
Next == Claim \/ Provider \/ Finalize \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ policy \in BOOLEAN /\ runtime \in BOOLEAN /\ connector \in BOOLEAN
          /\ effectCurrent \in BOOLEAN /\ postCurrent \in BOOLEAN /\ markAvailable \in BOOLEAN
          /\ held \in BOOLEAN /\ executed \in BOOLEAN /\ uncertain \in BOOLEAN /\ reported \in BOOLEAN
          /\ phase \in {"held", "claimed", "provisioned", "issued", "rejected"}
PolicyAtClaim == executed => policy
RuntimeAtClaim == executed => runtime
ConnectorAtClaim == executed => connector
AuthorityAtEffect == executed => effectCurrent
AuthorityAtReceipt == phase = "issued" => postCurrent
Reconciled == executed /\ phase = "rejected" => held /\ (uncertain \/ reported)
=============================================================================
