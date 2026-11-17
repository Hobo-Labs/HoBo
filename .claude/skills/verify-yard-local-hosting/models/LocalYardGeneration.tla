----------------------- MODULE LocalYardGeneration --------------------------
EXTENDS Naturals
CONSTANT RequireFunding
VARIABLES durable, localProof, phase
vars == <<durable, localProof, phase>>
Init == /\ durable \in BOOLEAN /\ localProof \in BOOLEAN /\ phase = "pending"
Decide == /\ phase = "pending" /\ phase' = IF durable \/ ~RequireFunding THEN "started" ELSE "rejected"
          /\ UNCHANGED <<durable, localProof>>
Done == /\ phase \in {"started", "rejected"} /\ UNCHANGED vars
Next == Decide \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ durable \in BOOLEAN /\ localProof \in BOOLEAN /\ phase \in {"pending", "started", "rejected"}
FundedGeneration == phase = "started" => durable
=============================================================================
